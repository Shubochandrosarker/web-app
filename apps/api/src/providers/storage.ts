import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ApiConfig } from '../lib/env.ts';
import type { ProviderLogger } from './notifications.ts';

/**
 * Object storage.
 *
 * Two buckets, and the separation is structural rather than a convention:
 *
 *  - **public** holds site media. Objects are served from a CDN origin, cached
 *    hard, and their URLs are permanent and guessable — which is fine, because
 *    they are pictures on a website.
 *
 *  - **private** holds uploaded documents: transcripts, certificates, ID
 *    scans. Nothing in the platform can produce a permanent URL for one. The
 *    only way to read an object is an authorised request that mints a signed
 *    URL valid for minutes, and writes an audit row before the URL is
 *    returned.
 *
 * Keeping them in one bucket with a prefix convention would make the whole
 * guarantee depend on every future call site remembering the convention. Two
 * buckets means a mistake is a missing-credential error rather than a
 * publicly readable transcript.
 */

export interface SignedUpload {
  readonly url: string;
  readonly objectKey: string;
  readonly expiresInSeconds: number;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

export interface Storage {
  readonly configured: boolean;
  /** A short-lived URL the browser may PUT one object to. */
  signPrivateUpload(input: {
    objectKey: string;
    contentType: string;
    contentLength: number;
  }): Promise<SignedUpload>;
  /** A short-lived URL for reading one private object. */
  signPrivateDownload(input: {
    objectKey: string;
    filename: string;
  }): Promise<{ url: string; expiresAt: Date }>;
  putPublicObject(input: {
    objectKey: string;
    body: Uint8Array;
    contentType: string;
  }): Promise<void>;
  deletePrivateObject(objectKey: string): Promise<void>;
  deletePublicObject(objectKey: string): Promise<void>;
}

class UnconfiguredStorage implements Storage {
  readonly configured = false;
  private readonly logger: ProviderLogger;

  constructor(logger: ProviderLogger) {
    this.logger = logger;
  }

  private fail(): never {
    // Throwing beats returning a fake URL: an upload endpoint that appears to
    // work and stores nothing is worse than one that is plainly switched off.
    throw new Error(
      'Object storage is not configured. Set the R2_* environment variables to enable uploads.',
    );
  }

  async signPrivateUpload(): Promise<SignedUpload> {
    this.logger.warn({}, 'Upload attempted with no storage configured');
    this.fail();
  }
  async signPrivateDownload(): Promise<{ url: string; expiresAt: Date }> {
    this.fail();
  }
  async putPublicObject(): Promise<void> {
    this.fail();
  }
  async deletePrivateObject(): Promise<void> {
    this.fail();
  }
  async deletePublicObject(): Promise<void> {
    this.fail();
  }
}

class R2Storage implements Storage {
  readonly configured = true;
  private readonly client: S3Client;
  private readonly publicBucket: string;
  private readonly privateBucket: string;
  private readonly ttl: number;

  constructor(config: NonNullable<ApiConfig['storage']>) {
    this.publicBucket = config.R2_PUBLIC_BUCKET;
    this.privateBucket = config.R2_PRIVATE_BUCKET;
    this.ttl = config.R2_SIGNED_URL_TTL;

    this.client = new S3Client({
      // R2 is S3-compatible and ignores the region, but the SDK insists on
      // one; `auto` is what Cloudflare documents.
      region: 'auto',
      endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.R2_ACCESS_KEY_ID,
        secretAccessKey: config.R2_SECRET_ACCESS_KEY,
      },
    });
  }

  /**
   * Sign an upload.
   *
   * The content type and length are signed into the URL, so the browser cannot
   * present a URL issued for a 2 MB PDF and use it to store a 2 GB video — the
   * signature covers those headers and R2 rejects a mismatch.
   */
  async signPrivateUpload(input: {
    objectKey: string;
    contentType: string;
    contentLength: number;
  }): Promise<SignedUpload> {
    const command = new PutObjectCommand({
      Bucket: this.privateBucket,
      Key: input.objectKey,
      ContentType: input.contentType,
      ContentLength: input.contentLength,
    });

    const url = await getSignedUrl(this.client, command, {
      expiresIn: this.ttl,
      signableHeaders: new Set(['content-type', 'content-length']),
    });

    return {
      url,
      objectKey: input.objectKey,
      expiresInSeconds: this.ttl,
      requiredHeaders: {
        'content-type': input.contentType,
        'content-length': String(input.contentLength),
      },
    };
  }

  async signPrivateDownload(input: {
    objectKey: string;
    filename: string;
  }): Promise<{ url: string; expiresAt: Date }> {
    const command = new GetObjectCommand({
      Bucket: this.privateBucket,
      Key: input.objectKey,
      // Force a download rather than an inline render. An HTML or SVG file
      // rendered inline from a storage origin is a stored-XSS vector against
      // whoever opens it.
      ResponseContentDisposition: `attachment; filename="${input.filename.replace(/["\\]/g, '')}"`,
      ResponseCacheControl: 'no-store, private',
    });

    const url = await getSignedUrl(this.client, command, { expiresIn: this.ttl });
    return { url, expiresAt: new Date(Date.now() + this.ttl * 1000) };
  }

  async putPublicObject(input: {
    objectKey: string;
    body: Uint8Array;
    contentType: string;
  }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.publicBucket,
        Key: input.objectKey,
        Body: input.body,
        ContentType: input.contentType,
        // Media objects are content-addressed by checksum, so a given key
        // never changes and can be cached for a year.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
  }

  async deletePrivateObject(objectKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.privateBucket, Key: objectKey }));
  }

  async deletePublicObject(objectKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.publicBucket, Key: objectKey }));
  }
}

export function createStorage(config: ApiConfig, logger: ProviderLogger): Storage {
  return config.storage ? new R2Storage(config.storage) : new UnconfiguredStorage(logger);
}

/**
 * A safe object key.
 *
 * The uploader's filename never becomes the key. It is kept in the database
 * for display; the key is derived from ids the server controls, so a filename
 * containing `../`, a null byte or four hundred characters of Unicode cannot
 * reach the storage layer at all.
 */
export function privateObjectKey(
  workspaceId: string,
  documentId: string,
  extension: string,
): string {
  const safeExtension = /^[a-z0-9]{1,8}$/.test(extension) ? extension : 'bin';
  return `documents/${workspaceId}/${documentId}.${safeExtension}`;
}

export function publicObjectKey(workspaceId: string, checksum: string, extension: string): string {
  const safeExtension = /^[a-z0-9]{1,8}$/.test(extension) ? extension : 'bin';
  return `media/${workspaceId}/${checksum}.${safeExtension}`;
}

/**
 * A filename fit to store and show.
 *
 * Path separators and control characters are removed rather than escaped, and
 * the result is length-capped. This value is only ever rendered as text and
 * put in a `Content-Disposition`, both of which are quoting contexts an
 * attacker would like to escape.
 */
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '')
    .trim();
  return (cleaned.length > 0 ? cleaned : 'file').slice(0, 200);
}
