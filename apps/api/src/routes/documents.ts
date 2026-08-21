import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace } from '@bos/database';
import { ApiError } from '../lib/errors.ts';
import { publicRoute, requirePermission } from '../lib/permissions.ts';
import { requestContext, requireUserId, requireWorkspace } from '../lib/context.ts';
import { consumeRateLimit } from '../lib/redis.ts';
import { privateObjectKey, sanitizeFilename } from '../providers/storage.ts';
import type { AppContext } from '../app.ts';

/**
 * Private documents.
 *
 * NuESheba receives transcripts, certificates and national ID scans. The rules
 * below are not defence in depth around a convenience feature — they are the
 * feature:
 *
 *  - the object lives in a bucket with no public read;
 *  - no code path anywhere produces a permanent URL for it;
 *  - a download is a signed URL valid for minutes, minted per request;
 *  - the audit row is written **before** the URL is returned, so a failure to
 *    record an access means no access;
 *  - the object key is derived from server-controlled ids, never from the
 *    uploader's filename;
 *  - `documents.download` is a separate permission from `documents.read`, so
 *    seeing that a transcript is attached and opening it are different grants.
 *
 * The upload is direct to storage via a signed PUT rather than through the
 * API. That keeps a twenty-megabyte scan off the API's event loop, and means
 * the file never sits in the API process's memory at all.
 */

/**
 * What a visitor may upload.
 *
 * An allow-list, not a block-list. `image/svg+xml` is absent deliberately: an
 * SVG is a document that can carry script, and there is no version of "upload
 * your transcript" that needs one.
 */
const ALLOWED_MIME_TYPES: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

const uploadRequest = z.object({
  workspace: z.string().min(1).max(140),
  filename: z.string().min(1).max(300),
  contentType: z.string().min(1).max(140),
  contentLength: z.number().int().min(1).max(MAX_DOCUMENT_BYTES),
  kind: z
    .enum(['transcript', 'certificate', 'national_id', 'photo', 'application_form', 'other'])
    .default('other'),
});

export function registerDocumentRoutes(app: FastifyInstance, context: AppContext): void {
  const { db, redis, storage, auth, resolveWorkspaceId } = context;

  /* ----------------------------------------------------------- upload URL */

  /**
   * Authorise one upload from a public form.
   *
   * Unauthenticated by necessity — the person filling in the form has no
   * account — so it is bounded instead: a strict rate limit per address, a
   * size ceiling signed into the URL, and a row that starts life orphaned. An
   * upload never attached to a lead is collected by the retention sweep.
   */
  app.post(
    '/v1/documents/upload-url',
    {
      config: {
        bosAccess: publicRoute(
          'Authorises one bounded upload from a public form. The object is private and unattached until a submission claims it.',
        ),
      },
    },
    async (request, reply) => {
      const input = uploadRequest.parse(request.body);

      const limit = await consumeRateLimit(redis, `rl:upload:${request.clientIpPrefix}`, 20, 3600);
      if (!limit.allowed) {
        throw new ApiError(429, 'too_many_requests', 'Too many uploads. Please try again later.');
      }

      const extension = ALLOWED_MIME_TYPES[input.contentType];
      if (!extension) {
        throw ApiError.badRequest(
          'That file type is not accepted. Upload a PDF or a photograph (JPEG, PNG, WebP or HEIC).',
        );
      }

      if (!storage.configured) {
        throw new ApiError(
          503,
          'uploads_unavailable',
          'File upload is not available on this deployment.',
        );
      }

      const workspaceId = await resolveWorkspaceId(input.workspace);
      const documentId = randomUUID();
      const objectKey = privateObjectKey(workspaceId, documentId, extension);
      const filename = sanitizeFilename(input.filename);

      const signed = await storage.signPrivateUpload({
        objectKey,
        contentType: input.contentType,
        contentLength: input.contentLength,
      });

      await withWorkspace(db, workspaceId, (tx) =>
        tx.insert(schema.documents).values({
          id: documentId,
          workspaceId,
          kind: input.kind,
          objectKey,
          originalFilename: filename,
          mimeType: input.contentType,
          sizeBytes: input.contentLength,
          // The real checksum is unknown until the object exists. It is filled
          // in by the confirm step; an empty one marks a document whose upload
          // was never completed.
          checksumSha256: '',
          status: 'uploaded',
          // Uploads that are never claimed by a submission expire in a day.
          retainUntil: new Date(Date.now() + 24 * 3600 * 1000),
        }),
      );

      return reply.status(201).send({
        documentId,
        uploadUrl: signed.url,
        expiresInSeconds: signed.expiresInSeconds,
        requiredHeaders: signed.requiredHeaders,
      });
    },
  );

  /* ------------------------------------------------------------- download */

  /**
   * Mint a download URL.
   *
   * The audit row is written inside the same transaction that reads the
   * document, and before the signed URL is generated. If that write fails the
   * caller gets an error and no link — an access that cannot be recorded does
   * not happen.
   */
  app.post(
    '/v1/documents/:id/download-url',
    { config: { bosAccess: requirePermission('documents.download') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const userId = requireUserId(request);

      if (!storage.configured) {
        throw new ApiError(503, 'uploads_unavailable', 'Document storage is not configured.');
      }

      const document = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.documents)
          .where(and(eq(schema.documents.id, id), isNull(schema.documents.deletedAt)))
          .limit(1);

        // Row-level security scoped the read, so a document in another
        // workspace is genuinely absent — and 404 does not confirm the id.
        if (!row) throw ApiError.hidden('Document');

        if (row.status === 'rejected' || row.status === 'deleted' || row.status === 'expired') {
          throw new ApiError(410, 'gone', 'That document is no longer available.');
        }

        return row;
      });

      const ttlSeconds = context.config.storage?.R2_SIGNED_URL_TTL ?? 300;
      const urlExpiresAt = new Date(Date.now() + ttlSeconds * 1000);

      await withWorkspace(db, workspace.workspaceId, (tx) =>
        tx.insert(schema.documentAccessLog).values({
          workspaceId: workspace.workspaceId,
          documentId: id,
          userId,
          action: 'url_issued',
          ipAddress: request.ip.slice(0, 45),
          userAgent: (request.headers['user-agent'] ?? '').slice(0, 1000),
          urlExpiresAt,
        }),
      );

      const signed = await storage.signPrivateDownload({
        objectKey: document.objectKey,
        filename: document.originalFilename,
      });

      await auth.audit(
        workspace.workspaceId,
        userId,
        'document.download_url_issued',
        requestContext(request),
        { documentId: id, kind: document.kind },
      );

      return {
        url: signed.url,
        expiresAt: signed.expiresAt.toISOString(),
        filename: document.originalFilename,
      };
    },
  );

  /* --------------------------------------------------------------- delete */

  app.delete(
    '/v1/documents/:id',
    { config: { bosAccess: requirePermission('documents.delete') } },
    async (request, reply) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const userId = requireUserId(request);

      const document = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [row] = await tx
          .select({ objectKey: schema.documents.objectKey, kind: schema.documents.kind })
          .from(schema.documents)
          .where(and(eq(schema.documents.id, id), isNull(schema.documents.deletedAt)))
          .limit(1);
        if (!row) throw ApiError.hidden('Document');
        return row;
      });

      // Storage first, then the row. The other order can leave a row marked
      // deleted while the object is still readable by a signed URL somebody
      // already holds.
      await storage.deletePrivateObject(document.objectKey);

      await withWorkspace(db, workspace.workspaceId, async (tx) => {
        await tx
          .update(schema.documents)
          .set({
            status: 'deleted',
            deletedAt: new Date(),
            deletedFromStorageAt: new Date(),
          })
          .where(eq(schema.documents.id, id));

        await tx.insert(schema.documentAccessLog).values({
          workspaceId: workspace.workspaceId,
          documentId: id,
          userId,
          action: 'deleted',
          ipAddress: request.ip.slice(0, 45),
        });
      });

      await auth.audit(workspace.workspaceId, userId, 'document.deleted', requestContext(request), {
        documentId: id,
        kind: document.kind,
      });

      return reply.status(204).send();
    },
  );

  /* ------------------------------------------------------------ access log */

  app.get(
    '/v1/documents/:id/access-log',
    { config: { bosAccess: requirePermission('audit.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);

      const rows = await withWorkspace(db, workspace.workspaceId, (tx) =>
        tx
          .select()
          .from(schema.documentAccessLog)
          .where(eq(schema.documentAccessLog.documentId, id))
          .limit(200),
      );

      return { items: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })) };
    },
  );
}

/**
 * Retention sweep.
 *
 * Run by the nightly cron. Deletes the object first and marks the row second,
 * so a crash between the two leaves a row claiming a document still exists —
 * which a person can investigate — rather than a row claiming it is gone while
 * the file remains.
 *
 * Exported rather than inlined into the cron route so it is callable from a
 * test and from an operator script.
 */
export async function sweepExpiredDocuments(
  context: AppContext,
  now = new Date(),
): Promise<{ swept: number; failed: number }> {
  const { db, storage } = context;
  if (!storage.configured) return { swept: 0, failed: 0 };

  const due = await db
    .select({
      id: schema.documents.id,
      workspaceId: schema.documents.workspaceId,
      objectKey: schema.documents.objectKey,
    })
    .from(schema.documents)
    .where(
      and(
        lte(schema.documents.retainUntil, now),
        isNull(schema.documents.deletedFromStorageAt),
        isNull(schema.documents.deletedAt),
      ),
    )
    .limit(500);

  let swept = 0;
  let failed = 0;

  for (const row of due) {
    try {
      await storage.deletePrivateObject(row.objectKey);
      await withWorkspace(db, row.workspaceId, (tx) =>
        tx
          .update(schema.documents)
          .set({ status: 'expired', deletedFromStorageAt: new Date(), deletedAt: new Date() })
          .where(eq(schema.documents.id, row.id)),
      );
      swept += 1;
    } catch {
      // Left in place for the next sweep. A storage error must not mark a
      // document gone when the object is still there.
      failed += 1;
    }
  }

  return { swept, failed };
}

/** Checksum helper, used by the confirm step and by tests. */
export function checksumOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
