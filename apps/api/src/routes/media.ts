import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace } from '@bos/database';
import { ApiError } from '../lib/errors.ts';
import { requirePermission } from '../lib/permissions.ts';
import { requestContext, requireUserId, requireWorkspace } from '../lib/context.ts';
import { detectType } from '../lib/file-signatures.ts';
import { publicObjectKey } from '../providers/storage.ts';
import type { AppContext } from '../app.ts';

/**
 * The media library — public site imagery, and nothing else.
 *
 * Deliberately a different world from private documents: these objects are
 * cacheable, permanently addressable, and served from a CDN origin, because
 * they are pictures on a website. A transcript can never end up here — the
 * two paths share no endpoint, no bucket and no table.
 *
 * Uploads go **through** the API rather than direct-to-storage: site imagery
 * is small, staff-only and worth inspecting on the way in. The API checks the
 * real bytes against the declared type, reads the pixel dimensions from the
 * headers (stored so the site can reserve space and avoid layout shift), and
 * content-addresses the object by checksum — the same picture uploaded twice
 * is one object and two rows, and a URL never changes under its cache.
 *
 * There is no variant pipeline here, on purpose: the site serves images
 * through next/image, which negotiates AVIF/WebP and sizes per device at
 * request time. Pre-generating variants would duplicate that badly.
 */

const ALLOWED_IMAGE_TYPES: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Pixel dimensions from the header bytes — no image library required. */
export function imageDimensions(
  bytes: Uint8Array,
  mime: string,
): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (mime === 'image/png' && bytes.length >= 24) {
    // IHDR is always the first chunk: width and height at offsets 16 and 20.
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  if (mime === 'image/webp' && bytes.length >= 30) {
    const format = String.fromCharCode(...bytes.subarray(12, 16));
    if (format === 'VP8 ' && bytes.length >= 30) {
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
    if (format === 'VP8L' && bytes.length >= 25) {
      const b0 = bytes[21]!;
      const b1 = bytes[22]!;
      const b2 = bytes[23]!;
      const b3 = bytes[24]!;
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
    if (format === 'VP8X' && bytes.length >= 30) {
      return {
        width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
        height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)),
      };
    }
    return null;
  }

  if (mime === 'image/jpeg') {
    // Walk the segment chain to the first SOFn marker.
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1]!;
      const length = view.getUint16(offset + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      }
      offset += 2 + length;
    }
    return null;
  }

  return null;
}

export function registerMediaRoutes(app: FastifyInstance, context: AppContext): void {
  const { db, storage } = context;

  /* ---------------------------------------------------------------- upload */

  app.post(
    '/v1/cms/media',
    { config: { bosAccess: requirePermission('media.write') } },
    async (request, reply) => {
      const workspace = requireWorkspace(request);
      const userId = requireUserId(request);

      if (!storage.configured) {
        throw new ApiError(503, 'uploads_unavailable', 'Media storage is not configured.');
      }

      const upload = await request.file();
      if (!upload) throw ApiError.badRequest('Attach an image file.');

      const bytes = new Uint8Array(await upload.toBuffer());
      if (bytes.length === 0) throw ApiError.badRequest('That file is empty.');
      if (bytes.length > MAX_IMAGE_BYTES) {
        throw ApiError.badRequest('Images can be at most 10 MB.');
      }

      // The bytes decide the type; the declared Content-Type is not consulted
      // at all. An SVG — a script container — cannot get past this because it
      // has no entry in the signature table.
      const detected = detectType(bytes);
      const extension = detected ? ALLOWED_IMAGE_TYPES[detected] : undefined;
      if (!detected || !extension) {
        throw ApiError.badRequest('Upload a JPEG, PNG or WebP image.');
      }

      const checksum = createHash('sha256').update(bytes).digest('hex');
      const objectKey = publicObjectKey(workspace.workspaceId, checksum, extension);
      const dimensions = imageDimensions(bytes, detected);

      /*
       * Same checksum, same object: the put is idempotent by construction, so
       * the row is what deduplication checks. Re-uploading a file someone
       * already added surfaces the existing entry rather than a copy.
       */
      const existing = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [row] = await tx
          .select({ id: schema.media.id })
          .from(schema.media)
          .where(and(eq(schema.media.checksumSha256, checksum), isNull(schema.media.deletedAt)))
          .limit(1);
        return row;
      });
      if (existing) {
        return reply.status(200).send({ id: existing.id, deduplicated: true });
      }

      await storage.putPublicObject({ objectKey, body: bytes, contentType: detected });

      const created = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [row] = await tx
          .insert(schema.media)
          .values({
            workspaceId: workspace.workspaceId,
            objectKey,
            visibility: 'public',
            filename: (upload.filename ?? 'image').slice(0, 300),
            mimeType: detected,
            sizeBytes: bytes.length,
            width: dimensions?.width ?? null,
            height: dimensions?.height ?? null,
            checksumSha256: checksum,
            uploadedBy: userId,
          })
          .returning({ id: schema.media.id });
        return row!.id;
      });

      await context.auth.audit(
        workspace.workspaceId,
        userId,
        'media.uploaded',
        requestContext(request),
        { mediaId: created, sizeBytes: bytes.length, mimeType: detected },
      );

      return reply.status(201).send({ id: created });
    },
  );

  /* ------------------------------------------------------------------ list */

  app.get(
    '/v1/cms/media',
    { config: { bosAccess: requirePermission('media.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const query = z
        .object({
          search: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        })
        .parse(request.query);

      const baseUrl = (context.config.storage?.R2_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');

      const rows = await withWorkspace(db, workspace.workspaceId, (tx) =>
        tx
          .select()
          .from(schema.media)
          .where(
            and(
              isNull(schema.media.deletedAt),
              query.search
                ? sql`(${schema.media.filename} ilike ${`%${query.search}%`} or ${schema.media.altText} ilike ${`%${query.search}%`})`
                : undefined,
            ),
          )
          .orderBy(sql`${schema.media.createdAt} desc`)
          .limit(query.limit)
          .offset(query.offset),
      );

      return {
        items: rows.map((row) => ({
          id: row.id,
          filename: row.filename,
          originalFilename: row.filename,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          width: row.width,
          height: row.height,
          alt: row.altText,
          caption: row.caption,
          url: baseUrl ? `${baseUrl}/${row.objectKey}` : null,
          createdAt: row.createdAt.toISOString(),
        })),
      };
    },
  );

  /* ----------------------------------------------------------------- edit */

  app.patch(
    '/v1/cms/media/:id',
    { config: { bosAccess: requirePermission('media.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const input = z
        .object({
          alt: z.string().max(300).optional(),
          caption: z.string().max(2000).optional(),
        })
        .parse(request.body);

      const updated = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const rows = await tx
          .update(schema.media)
          .set({
            ...(input.alt !== undefined ? { altText: input.alt } : {}),
            ...(input.caption !== undefined ? { caption: input.caption } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(schema.media.id, id), isNull(schema.media.deletedAt)))
          .returning({ id: schema.media.id });
        return rows.length > 0;
      });

      if (!updated) throw ApiError.hidden('Media');
      return { id };
    },
  );

  /* ---------------------------------------------------------------- delete */

  app.delete(
    '/v1/cms/media/:id',
    { config: { bosAccess: requirePermission('media.delete') } },
    async (request, reply) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const userId = requireUserId(request);

      const result = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [row] = await tx
          .select({ objectKey: schema.media.objectKey })
          .from(schema.media)
          .where(and(eq(schema.media.id, id), isNull(schema.media.deletedAt)))
          .limit(1);
        if (!row) throw ApiError.hidden('Media');

        /*
         * Deletion protection: an image still placed on a page must not
         * vanish from under it. Section documents reference media by id, so
         * a containment scan over the workspace's documents is the check —
         * unindexed, but bounded to one workspace and run only on delete.
         */
        const [usage] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(schema.contentEntries)
          .where(
            and(
              isNull(schema.contentEntries.deletedAt),
              sql`${schema.contentEntries.document}::text like ${`%${id}%`}`,
            ),
          );

        if ((usage?.count ?? 0) > 0) {
          throw ApiError.conflict(
            `That image is used on ${usage!.count} page(s). Remove it from them first.`,
          );
        }

        await tx.update(schema.media).set({ deletedAt: new Date() }).where(eq(schema.media.id, id));

        return row;
      });

      // The row is soft-deleted before the object goes: a crash here leaves
      // an orphaned object (harmless, collectable) rather than a live row
      // pointing at nothing.
      await storage.deletePublicObject(result.objectKey).catch((error: unknown) => {
        request.log.warn({ err: error, mediaId: id }, 'Media object deletion failed');
      });

      await context.auth.audit(
        workspace.workspaceId,
        userId,
        'media.deleted',
        requestContext(request),
        { mediaId: id },
      );

      return reply.status(204).send();
    },
  );
}
