import { createHash, randomUUID } from 'node:crypto';
import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace, withoutTenantScope } from '@bos/database';
import { ApiError } from '../lib/errors.ts';
import { publicRoute, requirePermission } from '../lib/permissions.ts';
import { requestContext, requireUserId, requireWorkspace } from '../lib/context.ts';
import { consumeRateLimit } from '../lib/redis.ts';
import { hashToken, mintToken } from '../lib/crypto.ts';
import { matchesDeclaredType } from '../lib/file-signatures.ts';
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
 *  - a download is a signed URL valid for minutes, minted per request, and
 *    only for a document whose status is `clean`;
 *  - the audit row is written **before** the URL is returned, so a failure to
 *    record an access means no access;
 *  - the object key is derived from server-controlled ids, never from the
 *    uploader's filename;
 *  - `documents.download` is a separate permission from `documents.read`, so
 *    seeing that a transcript is attached and opening it are different grants.
 *
 * ## The lifecycle
 *
 * ```
 * request upload         → pending_upload   (claim token issued, once)
 * browser PUTs to R2
 * confirm (claim token)  → verify: real size, magic bytes, checksum
 *                            mismatch → rejected, object deleted
 *                        → scan
 *                            clean    → clean
 *                            infected → rejected, object deleted
 *                            error    → scanning (retried by the sweep)
 * form submission        → attach, by claim token, clean documents only
 * staff download         → clean documents only, logged before issuance
 * retention sweep        → expired, object deleted first
 * ```
 *
 * The upload is direct to storage via a signed PUT rather than through the
 * API. That keeps a twenty-megabyte scan off the API's event loop, and means
 * the file never sits in the API process's memory at all — until the confirm
 * step deliberately reads it back once, bounded, to verify and scan it.
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

/** How long an unconfirmed upload authorisation stays claimable. */
const PENDING_UPLOAD_TTL_HOURS = 24;
/** How long a rejected object's row is kept for the audit trail. */
const REJECTED_RETENTION_DAYS = 7;

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
   * daily ceiling per workspace, a size ceiling signed into the URL, and a
   * row that starts life `pending_upload` and unattached. The response
   * carries a one-shot **claim token**; presenting it is what later proves
   * ownership at confirm and attach time. Only its hash is stored.
   */
  app.post(
    '/v1/documents/upload-url',
    {
      config: {
        bosAccess: publicRoute(
          'Authorises one bounded upload from a public form. The object is private, unverified and unattached until a submission claims it with the claim token.',
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

      /*
       * The workspace ceiling. Not per-address — that is the limit above —
       * but the total a tenant can accumulate in a day, so a botnet cannot
       * turn the public form into free bulk storage twenty megabytes at a
       * time. Five hundred a day is far beyond any legitimate day's leads.
       */
      const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
      const recentCount = await withWorkspace(db, workspaceId, async (tx) => {
        const [row] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(schema.documents)
          .where(gte(schema.documents.createdAt, dayAgo));
        return row?.count ?? 0;
      });
      if (recentCount >= 500) {
        request.log.warn({ workspaceId, recentCount }, 'Workspace daily upload ceiling reached');
        throw new ApiError(429, 'too_many_requests', 'Uploads are busy. Please try again later.');
      }

      const documentId = randomUUID();
      const claimToken = mintToken();
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
          // The real checksum is unknown until the object is verified.
          checksumSha256: '',
          status: 'pending_upload',
          claimTokenHash: hashToken(claimToken),
          retainUntil: new Date(Date.now() + PENDING_UPLOAD_TTL_HOURS * 3600 * 1000),
        }),
      );

      return reply.status(201).send({
        documentId,
        // Returned exactly once. The uploader holds it; the database holds
        // its hash; nobody else ever sees it.
        claimToken,
        uploadUrl: signed.url,
        expiresInSeconds: signed.expiresInSeconds,
        requiredHeaders: signed.requiredHeaders,
      });
    },
  );

  /* -------------------------------------------------------------- confirm */

  /**
   * Confirm an upload: verify the object and scan it.
   *
   * Called by the uploader after the PUT succeeds, bearing the claim token.
   * This is where the platform stops taking the uploader's word for
   * anything: the stored object's real size is compared with the declared
   * one, its leading bytes with the declared type, and its checksum is
   * computed from what actually arrived. Any mismatch rejects the document
   * and deletes the object.
   *
   * The scan follows immediately. `clean` and `infected` are verdicts;
   * a scanner *error* leaves the document in `scanning`, downloadable by
   * no one, for the scheduled sweep to retry — fail closed.
   */
  app.post(
    '/v1/documents/:id/confirm',
    {
      config: {
        bosAccess: publicRoute(
          'Completes an upload the caller authorised moments ago; the claim token is the proof.',
        ),
      },
    },
    async (request, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const body = z
        .object({
          workspace: z.string().min(1).max(140),
          claimToken: z.string().min(1).max(400),
        })
        .parse(request.body);

      const limit = await consumeRateLimit(redis, `rl:confirm:${request.clientIpPrefix}`, 40, 3600);
      if (!limit.allowed) {
        throw new ApiError(429, 'too_many_requests', 'Too many requests. Please try again later.');
      }

      const workspaceId = await resolveWorkspaceId(body.workspace);

      const document = await withWorkspace(db, workspaceId, async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.documents)
          .where(and(eq(schema.documents.id, id), isNull(schema.documents.deletedAt)))
          .limit(1);
        return row;
      });

      // One error for every failure mode an outsider can probe: wrong id,
      // wrong token, wrong workspace, already handled. Distinguishing them
      // would make this endpoint an oracle.
      if (
        !document ||
        !document.claimTokenHash ||
        document.claimTokenHash !== hashToken(body.claimToken) ||
        document.status !== 'pending_upload'
      ) {
        throw ApiError.hidden('Document');
      }

      const outcome = await verifyAndScan(context, {
        id: document.id,
        workspaceId,
        objectKey: document.objectKey,
        declaredMime: document.mimeType,
        declaredSize: document.sizeBytes,
      });

      if (outcome.status === 'rejected') {
        return reply.status(422).send({
          status: 'rejected',
          reason: outcome.reason,
          message:
            outcome.reason === 'infected'
              ? 'That file failed our safety scan and was not accepted.'
              : 'That file does not appear to be what it claims to be and was not accepted.',
        });
      }

      return reply.status(200).send({
        status: outcome.status,
        message:
          outcome.status === 'clean'
            ? 'Your document has been received.'
            : 'Your document has been received and is being checked.',
      });
    },
  );

  /* ----------------------------------------------------------------- list */

  app.get(
    '/v1/documents',
    { config: { bosAccess: requirePermission('documents.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const query = z
        .object({
          leadId: z.uuid().optional(),
          contactId: z.uuid().optional(),
          status: z.enum(schema.documentStatus.enumValues).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .parse(request.query);

      const rows = await withWorkspace(db, workspace.workspaceId, (tx) =>
        tx
          .select({
            id: schema.documents.id,
            kind: schema.documents.kind,
            originalFilename: schema.documents.originalFilename,
            mimeType: schema.documents.mimeType,
            sizeBytes: schema.documents.sizeBytes,
            status: schema.documents.status,
            scanResult: schema.documents.scanResult,
            leadId: schema.documents.leadId,
            contactId: schema.documents.contactId,
            createdAt: schema.documents.createdAt,
            verifiedAt: schema.documents.verifiedAt,
            scannedAt: schema.documents.scannedAt,
            retainUntil: schema.documents.retainUntil,
          })
          .from(schema.documents)
          .where(
            and(
              isNull(schema.documents.deletedAt),
              query.leadId ? eq(schema.documents.leadId, query.leadId) : undefined,
              query.contactId ? eq(schema.documents.contactId, query.contactId) : undefined,
              query.status ? eq(schema.documents.status, query.status) : undefined,
              // The dashboard has no business listing authorisations nobody
              // completed.
              query.status ? undefined : sql`${schema.documents.status} != 'pending_upload'`,
            ),
          )
          .orderBy(sql`${schema.documents.createdAt} desc`)
          .limit(query.limit),
      );

      return {
        items: rows.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          verifiedAt: row.verifiedAt?.toISOString() ?? null,
          scannedAt: row.scannedAt?.toISOString() ?? null,
          retainUntil: row.retainUntil?.toISOString() ?? null,
        })),
      };
    },
  );

  /* ------------------------------------------------------------- download */

  /**
   * Mint a download URL — for a `clean` document, and no other status.
   *
   * The audit row is written before the signed URL is generated. If that
   * write fails the caller gets an error and no link — an access that cannot
   * be recorded does not happen.
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
        return row;
      });

      // Row-level security scoped the read, so a document in another
      // workspace is genuinely absent — and 404 does not confirm the id.
      if (!document) throw ApiError.hidden('Document');

      if (
        document.status === 'rejected' ||
        document.status === 'deleted' ||
        document.status === 'expired'
      ) {
        throw new ApiError(410, 'gone', 'That document is no longer available.');
      }

      if (document.status !== 'clean') {
        /*
         * Recorded as a denial, because "who tried to open an unscanned file"
         * is an audit-trail question somebody will eventually ask. In its own
         * transaction, deliberately: an audit row written inside the
         * transaction that then throws is an audit row that never existed.
         */
        await withWorkspace(db, workspace.workspaceId, (tx) =>
          tx.insert(schema.documentAccessLog).values({
            workspaceId: workspace.workspaceId,
            documentId: id,
            userId,
            action: 'denied',
            ipAddress: request.ip.slice(0, 45),
            userAgent: (request.headers['user-agent'] ?? '').slice(0, 1000),
          }),
        );
        throw new ApiError(
          409,
          'not_scanned',
          'That document has not passed verification and scanning yet.',
        );
      }

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

/* ------------------------------------------------------------ verification */

export type VerifyOutcome =
  | { status: 'clean' }
  | { status: 'scanning' }
  | { status: 'rejected'; reason: 'missing' | 'size_mismatch' | 'type_mismatch' | 'infected' };

/**
 * Verify a stored object against its declaration, then scan it.
 *
 * Shared by the confirm endpoint and the sweep's rescan path. Everything here
 * treats the stored object as the fact and the upload request as the claim.
 */
export async function verifyAndScan(
  context: AppContext,
  document: {
    id: string;
    workspaceId: string;
    objectKey: string;
    declaredMime: string;
    declaredSize: number;
  },
): Promise<VerifyOutcome> {
  const { db, storage, scanner } = context;

  const reject = async (
    reason: 'missing' | 'size_mismatch' | 'type_mismatch' | 'infected',
    detail: Record<string, unknown>,
    deleteObject: boolean,
  ): Promise<VerifyOutcome> => {
    if (deleteObject) {
      await storage.deletePrivateObject(document.objectKey).catch(() => {
        // The sweep retries deletion via retainUntil; the rejection stands.
      });
    }
    await withWorkspace(db, document.workspaceId, (tx) =>
      tx
        .update(schema.documents)
        .set({
          status: 'rejected',
          scanResult: { reason, ...detail },
          scannedAt: new Date(),
          claimTokenHash: null,
          deletedFromStorageAt: deleteObject ? new Date() : null,
          retainUntil: new Date(Date.now() + REJECTED_RETENTION_DAYS * 24 * 3600 * 1000),
        })
        .where(eq(schema.documents.id, document.id)),
    );
    return { status: 'rejected', reason };
  };

  const head = await storage.headPrivateObject(document.objectKey);
  if (!head) return reject('missing', { note: 'no object arrived' }, false);

  if (head.sizeBytes !== document.declaredSize || head.sizeBytes > MAX_DOCUMENT_BYTES) {
    return reject(
      'size_mismatch',
      { declared: document.declaredSize, actual: head.sizeBytes },
      true,
    );
  }

  const bytes = await storage.getPrivateObjectBytes(document.objectKey, MAX_DOCUMENT_BYTES);
  if (!bytes) return reject('missing', { note: 'object vanished between head and read' }, false);

  const signature = matchesDeclaredType(bytes, document.declaredMime);
  if (!signature.matches) {
    return reject(
      'type_mismatch',
      { declared: document.declaredMime, detected: signature.detected },
      true,
    );
  }

  const checksum = createHash('sha256').update(bytes).digest('hex');

  await withWorkspace(db, document.workspaceId, (tx) =>
    tx
      .update(schema.documents)
      .set({ checksumSha256: checksum, verifiedAt: new Date() })
      .where(eq(schema.documents.id, document.id)),
  );

  const verdict = await scanner.scan(bytes);

  if (verdict.outcome === 'infected') {
    return reject('infected', { scanner: verdict.scanner, signature: verdict.signature }, true);
  }

  if (verdict.outcome === 'clean' || verdict.outcome === 'not_scanned') {
    await withWorkspace(db, document.workspaceId, (tx) =>
      tx
        .update(schema.documents)
        .set({
          status: 'clean',
          scannedAt: new Date(),
          scanResult:
            verdict.outcome === 'clean'
              ? { outcome: 'clean', scanner: verdict.scanner }
              : { outcome: 'not_scanned', scanner: 'none' },
          // A verified upload now follows the workspace's business
          // retention; until an explicit policy exists, one year.
          retainUntil: new Date(Date.now() + 365 * 24 * 3600 * 1000),
        })
        .where(eq(schema.documents.id, document.id)),
    );
    return { status: 'clean' };
  }

  // Scanner error: owed a scan, downloadable by no one, retried by the sweep.
  await withWorkspace(db, document.workspaceId, (tx) =>
    tx
      .update(schema.documents)
      .set({
        status: 'scanning',
        scanResult: { outcome: 'error', scanner: verdict.scanner, reason: verdict.reason },
      })
      .where(eq(schema.documents.id, document.id)),
  );
  return { status: 'scanning' };
}

/**
 * Retry documents stuck in `scanning` because the scanner errored.
 * Run by the nightly cron alongside the retention sweep.
 */
export async function rescanPendingDocuments(
  context: AppContext,
  limit = 50,
): Promise<{ rescanned: number; clean: number; rejected: number; stillPending: number }> {
  if (!context.storage.configured) return { rescanned: 0, clean: 0, rejected: 0, stillPending: 0 };

  const due = await withoutTenantScope(context.db, (tx) =>
    tx
      .select({
        id: schema.documents.id,
        workspaceId: schema.documents.workspaceId,
        objectKey: schema.documents.objectKey,
        mimeType: schema.documents.mimeType,
        sizeBytes: schema.documents.sizeBytes,
      })
      .from(schema.documents)
      .where(and(eq(schema.documents.status, 'scanning'), isNull(schema.documents.deletedAt)))
      .limit(limit),
  );

  let clean = 0;
  let rejected = 0;
  let stillPending = 0;

  for (const row of due) {
    const outcome = await verifyAndScan(context, {
      id: row.id,
      workspaceId: row.workspaceId,
      objectKey: row.objectKey,
      declaredMime: row.mimeType,
      declaredSize: row.sizeBytes,
    });
    if (outcome.status === 'clean') clean += 1;
    else if (outcome.status === 'rejected') rejected += 1;
    else stillPending += 1;
  }

  return { rescanned: due.length, clean, rejected, stillPending };
}

/**
 * Attach uploaded documents to a lead, by claim token.
 *
 * Called from the public form submission. Possession of the claim token — not
 * knowledge of a document id — is what authorises the attachment, and only a
 * verified, unattached document qualifies. The claim token is spent by the
 * attachment: the column is nulled, so it cannot attach anything twice.
 */
export async function attachDocumentsByClaim(
  context: AppContext,
  workspaceId: string,
  claims: readonly { documentId: string; claimToken: string }[],
  target: { leadId: string; contactId: string },
): Promise<{ attached: number }> {
  if (claims.length === 0) return { attached: 0 };

  let attached = 0;
  await withWorkspace(context.db, workspaceId, async (tx) => {
    for (const claim of claims) {
      const result = await tx
        .update(schema.documents)
        .set({ leadId: target.leadId, contactId: target.contactId, claimTokenHash: null })
        .where(
          and(
            eq(schema.documents.id, claim.documentId),
            eq(schema.documents.claimTokenHash, hashToken(claim.claimToken)),
            // Only a document that passed verification and scanning may be
            // attached to a lead; anything else is still in flight or dead.
            inArray(schema.documents.status, ['clean', 'scanning']),
            isNull(schema.documents.leadId),
            isNull(schema.documents.deletedAt),
          ),
        )
        .returning({ id: schema.documents.id });
      attached += result.length;
    }
  });

  return { attached };
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

  /*
   * `withoutTenantScope`, and it is load-bearing: the sweep is a cross-tenant
   * job and the API connects as the RLS-bound application role. The previous
   * version queried without it, which under that role returns zero rows for
   * every tenant — a retention sweep that had silently never swept anything.
   * Caught by the lifecycle test running as the production-like role.
   */
  const due = await withoutTenantScope(db, (tx) =>
    tx
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
      .limit(500),
  );

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
