import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace } from '@bos/database';
import { pageDocumentSchema, parsePageDocument } from '@bos/sections';
import { ApiError } from '../lib/errors.ts';
import { publicRoute, requirePermission } from '../lib/permissions.ts';
import { requestContext, requireUserId, requireWorkspace } from '../lib/context.ts';
import { consumeRateLimit } from '../lib/redis.ts';
import { hashToken, mintToken } from '../lib/crypto.ts';
import { resolveSectionReferences } from '../lib/references.ts';
import { toContentEntry } from './content-public.ts';
import type { AppContext } from '../app.ts';

/**
 * What the section editor needs beyond the content CRUD:
 *
 *  - the reference pickers' choices (services, forms, locations, people);
 *  - revision detail and restore — the snapshot the update endpoint has
 *    always written finally gets its undo button;
 *  - authenticated draft preview, as a short-lived token the site exchanges
 *    for the draft. The public content API stays structurally incapable of
 *    serving a draft; this is the one deliberate, expiring exception, and it
 *    requires `content.read` to mint.
 */

const PREVIEW_TTL_SECONDS = 600;

export function registerCmsReferenceRoutes(app: FastifyInstance, context: AppContext): void {
  const { db, redis } = context;

  /* ------------------------------------------------------- picker choices */

  app.get(
    '/v1/cms/services',
    { config: { bosAccess: requirePermission('content.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const rows = await withWorkspace(db, workspace.workspaceId, (tx) =>
        tx
          .select({
            id: schema.services.id,
            name: schema.services.name,
            slug: schema.services.slug,
            status: schema.services.status,
          })
          .from(schema.services)
          .where(isNull(schema.services.deletedAt))
          .orderBy(schema.services.position, schema.services.name)
          .limit(500),
      );
      return { items: rows };
    },
  );

  app.get(
    '/v1/cms/forms',
    { config: { bosAccess: requirePermission('content.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const rows = await withWorkspace(db, workspace.workspaceId, (tx) =>
        tx
          .select({
            id: schema.forms.id,
            name: schema.forms.name,
            slug: schema.forms.slug,
            enabled: schema.forms.enabled,
          })
          .from(schema.forms)
          .where(isNull(schema.forms.deletedAt))
          .orderBy(schema.forms.name)
          .limit(200),
      );
      return { items: rows };
    },
  );

  app.get(
    '/v1/cms/locations',
    { config: { bosAccess: requirePermission('content.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const rows = await withWorkspace(db, workspace.workspaceId, (tx) =>
        tx
          .select({
            id: schema.locations.id,
            name: schema.locations.displayName,
            city: schema.locations.addressLocality,
          })
          .from(schema.locations)
          .where(isNull(schema.locations.deletedAt))
          .orderBy(schema.locations.displayName)
          .limit(200),
      );
      return { items: rows };
    },
  );

  app.get(
    '/v1/cms/people',
    { config: { bosAccess: requirePermission('content.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const rows = await withWorkspace(db, workspace.workspaceId, (tx) =>
        tx
          .select({
            id: schema.staffProfiles.id,
            name: schema.staffProfiles.fullName,
            role: schema.staffProfiles.role,
          })
          .from(schema.staffProfiles)
          .where(isNull(schema.staffProfiles.deletedAt))
          .orderBy(schema.staffProfiles.fullName)
          .limit(200),
      );
      return { items: rows };
    },
  );

  /* ------------------------------------------------------------ revisions */

  app.get(
    '/v1/cms/content/:id/revisions/:revision',
    { config: { bosAccess: requirePermission('content.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const params = z
        .object({ id: z.uuid(), revision: z.coerce.number().int().min(1) })
        .parse(request.params);

      const row = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [revision] = await tx
          .select()
          .from(schema.contentRevisions)
          .where(
            and(
              eq(schema.contentRevisions.contentEntryId, params.id),
              eq(schema.contentRevisions.revision, params.revision),
            ),
          )
          .limit(1);
        return revision;
      });

      if (!row) throw ApiError.hidden('Revision');

      return {
        revision: row.revision,
        title: row.title,
        document: row.document,
        fields: row.fields,
        createdAt: row.createdAt.toISOString(),
        createdBy: row.createdBy,
      };
    },
  );

  /**
   * Restore a revision.
   *
   * Implemented as "make the current state a new revision, then copy the old
   * one over it" — a restore is itself undoable, which is the property that
   * makes people willing to press the button.
   */
  app.post(
    '/v1/cms/content/:id/revisions/:revision/restore',
    { config: { bosAccess: requirePermission('content.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const params = z
        .object({ id: z.uuid(), revision: z.coerce.number().int().min(1) })
        .parse(request.params);
      const userId = requireUserId(request);

      const restored = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [entry] = await tx
          .select()
          .from(schema.contentEntries)
          .where(
            and(eq(schema.contentEntries.id, params.id), isNull(schema.contentEntries.deletedAt)),
          )
          .limit(1);
        if (!entry) throw ApiError.hidden('Content');

        const [target] = await tx
          .select()
          .from(schema.contentRevisions)
          .where(
            and(
              eq(schema.contentRevisions.contentEntryId, params.id),
              eq(schema.contentRevisions.revision, params.revision),
            ),
          )
          .limit(1);
        if (!target) throw ApiError.hidden('Revision');

        const [latest] = await tx
          .select({ revision: schema.contentRevisions.revision })
          .from(schema.contentRevisions)
          .where(eq(schema.contentRevisions.contentEntryId, params.id))
          .orderBy(sql`${schema.contentRevisions.revision} desc`)
          .limit(1);

        await tx.insert(schema.contentRevisions).values({
          workspaceId: workspace.workspaceId,
          contentEntryId: params.id,
          revision: (latest?.revision ?? 0) + 1,
          document: entry.document,
          fields: entry.fields,
          title: entry.title,
          createdBy: userId,
        });

        await tx
          .update(schema.contentEntries)
          .set({
            title: target.title ?? entry.title,
            document: target.document,
            fields: target.fields,
            updatedAt: new Date(),
          })
          .where(eq(schema.contentEntries.id, params.id));

        return { restoredFrom: params.revision, newRevision: (latest?.revision ?? 0) + 1 };
      });

      await context.auth.audit(
        workspace.workspaceId,
        userId,
        'content.revision_restored',
        requestContext(request),
        { contentEntryId: params.id, revision: params.revision },
      );

      return restored;
    },
  );

  /* -------------------------------------------------------------- preview */

  /**
   * Mint a preview token for a draft.
   *
   * The token is the whole grant: ten minutes, one entry, hashed at rest.
   * The URL it produces can be pasted to a colleague and dies on its own —
   * which is the property that stops preview links accumulating in chat
   * histories as permanent draft access.
   */
  app.post(
    '/v1/cms/content/:id/preview-token',
    { config: { bosAccess: requirePermission('content.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);

      const entry = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [row] = await tx
          .select({ id: schema.contentEntries.id, path: schema.contentEntries.path })
          .from(schema.contentEntries)
          .where(and(eq(schema.contentEntries.id, id), isNull(schema.contentEntries.deletedAt)))
          .limit(1);
        return row;
      });
      if (!entry) throw ApiError.hidden('Content');

      const token = mintToken();
      await redis.set(
        `preview:${hashToken(token)}`,
        JSON.stringify({ contentEntryId: id, workspaceId: workspace.workspaceId }),
        'EX',
        PREVIEW_TTL_SECONDS,
      );

      return { token, expiresInSeconds: PREVIEW_TTL_SECONDS };
    },
  );

  /**
   * Exchange a preview token for the draft, resolved exactly like a public
   * page. Site-facing and unauthenticated by design — the token is the
   * authentication, and it was minted by someone holding `content.read`.
   */
  app.get(
    '/v1/content/preview',
    {
      config: {
        bosAccess: publicRoute(
          'Serves one draft to a holder of a short-lived preview token minted by an editor.',
        ),
      },
    },
    async (request) => {
      const query = z.object({ token: z.string().min(1).max(400) }).parse(request.query);

      const limit = await consumeRateLimit(redis, `rl:preview:${request.clientIpPrefix}`, 60, 600);
      if (!limit.allowed) {
        throw new ApiError(429, 'too_many_requests', 'Too many preview requests.');
      }

      const raw = await redis.get(`preview:${hashToken(query.token)}`);
      if (!raw) throw ApiError.hidden('Preview');
      const grant = JSON.parse(raw) as { contentEntryId: string; workspaceId: string };

      return withWorkspace(db, grant.workspaceId, async (tx) => {
        const [row] = await tx
          .select({ entry: schema.contentEntries, seo: schema.seoMetadata })
          .from(schema.contentEntries)
          .leftJoin(
            schema.seoMetadata,
            eq(schema.seoMetadata.contentEntryId, schema.contentEntries.id),
          )
          .where(
            and(
              eq(schema.contentEntries.id, grant.contentEntryId),
              isNull(schema.contentEntries.deletedAt),
            ),
          )
          .limit(1);
        if (!row) throw ApiError.hidden('Preview');

        const { sections } = parsePageDocument(pageDocumentSchema.parse(row.entry.document));
        const references = await resolveSectionReferences(tx, grant.workspaceId, sections, {
          publicMediaBaseUrl: context.config.storage?.R2_PUBLIC_BASE_URL,
          turnstileSiteKey: context.config.TURNSTILE_SITE_KEY,
          defaultLocale: row.entry.locale,
        });

        return toContentEntry(row.entry, row.seo, references);
      });
    },
  );
}
