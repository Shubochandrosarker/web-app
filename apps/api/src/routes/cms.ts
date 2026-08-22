import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace, type Database } from '@bos/database';
import {
  pageDocumentSchema,
  parseSection,
  type PageDocument,
  type StoredSection,
} from '@bos/sections';
import { sanitizeContentHtml } from '@bos/sanitize';
import { safeAbsoluteUrl } from '@bos/sanitize/url';
import { ApiError } from '../lib/errors.ts';
import { requirePermission } from '../lib/permissions.ts';
import { requestContext, requireUserId, requireWorkspace } from '../lib/context.ts';
import {
  buildPage,
  cursorCondition,
  decodeCursor,
  orderFor,
  withCursor,
} from '../lib/pagination.ts';
import { appendOutboxEvent } from '../lib/outbox.ts';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../app.ts';

/**
 * Content authoring.
 *
 * Separate from `content-public.ts` for one reason that is worth stating
 * plainly: this file is allowed to return drafts and that one is not. Keeping
 * them in the same router would mean the difference between a draft leaking
 * and not leaking was a `status` parameter somebody remembered to constrain.
 *
 * This is also the **sanitisation write boundary**. Every path that stores a
 * section document goes through `sanitizeDocument`, and the renderer's
 * `dangerouslySetInnerHTML` is only defensible because of it.
 */

const localeParam = z.string().min(2).max(10);
const pathParam = z
  .string()
  .startsWith('/')
  .max(2048)
  // A path is a routing key. Whitespace and control characters in one produce
  // URLs that work in a browser's address bar and not in a sitemap.
  .regex(/^\/[\w\-./%]*$/, 'may contain only letters, digits, hyphens, dots and slashes');

const seoInput = z.object({
  title: z.string().max(70).optional(),
  description: z.string().max(180).optional(),
  canonicalUrl: safeAbsoluteUrl.optional(),
  noindex: z.boolean().default(false),
  nofollow: z.boolean().default(false),
  ogImageMediaId: z.uuid().optional(),
});

const entryInput = z.object({
  type: z.enum(schema.contentType.enumValues),
  slug: z
    .string()
    .min(1)
    .max(140)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase words separated by single hyphens'),
  path: pathParam,
  locale: localeParam,
  title: z.string().min(1).max(300),
  excerpt: z.string().max(600).optional(),
  document: pageDocumentSchema.default({ sections: [] }),
  fields: z.record(z.string(), z.unknown()).default({}),
  seo: seoInput.default({ noindex: false, nofollow: false }),
});

/**
 * The update schema, written out rather than derived with `.partial()`.
 *
 * `.partial()` makes a field optional but does **not** remove its `.default()`,
 * so `entryInput.partial().parse({ path: '/new' })` returns
 * `{ path: '/new', document: { sections: [] }, fields: {} }` — and a PATCH that
 * only renamed a page silently replaced its entire content with nothing.
 *
 * Every field here is optional with no default, so an absent key is absent.
 * The distinction between "not sent" and "sent as empty" is the whole contract
 * of a PATCH, and it has to be visible in the schema rather than reconstructed
 * by the handler.
 */
const entryUpdateInput = z.object({
  type: z.enum(schema.contentType.enumValues).optional(),
  slug: z
    .string()
    .min(1)
    .max(140)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase words separated by single hyphens')
    .optional(),
  path: pathParam.optional(),
  locale: localeParam.optional(),
  title: z.string().min(1).max(300).optional(),
  excerpt: z.string().max(600).optional(),
  document: pageDocumentSchema.optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  seo: seoInput.optional(),
});

const statusInput = z.object({
  status: z.enum(['draft', 'scheduled', 'published', 'archived']),
  /** Required when status is `scheduled`; ignored otherwise. */
  publishAt: z.iso.datetime({ offset: true }).optional(),
});

export interface SanitizedDocument {
  readonly document: PageDocument;
  readonly warnings: readonly string[];
}

/**
 * Sanitise a document on the way in.
 *
 * Two things happen here, and both are load-bearing:
 *
 *  1. Every `content` section's HTML is run through the allow-list sanitiser.
 *     What is stored is what the renderer will inject, so the guarantee holds
 *     without the render path parsing HTML on every request.
 *
 *  2. Every section is parsed against its schema — which is what rejects an
 *     unsafe link, because `safeHref` is part of the schema. A section that
 *     fails is refused at save time, where an editor can fix it, rather than
 *     silently disappearing from the published page.
 */
export function sanitizeDocument(document: PageDocument, siteOrigin: string): SanitizedDocument {
  const warnings: string[] = [];
  const sections: StoredSection[] = [];

  for (const section of document.sections) {
    let props = section.props;

    if (section.type === 'content' && typeof props.html === 'string') {
      const result = sanitizeContentHtml(props.html, { siteOrigin });
      props = { ...props, html: result.html };

      for (const dropped of result.droppedUrls) {
        warnings.push(
          `Section ${section.id}: removed a ${dropped.tag} pointing at "${dropped.value.slice(0, 80)}" (${dropped.reason}).`,
        );
      }
    }

    const candidate: StoredSection = { ...section, props };
    const parsed = parseSection(candidate);

    if (!parsed.ok) {
      throw new ApiError(
        422,
        'invalid_section',
        `The "${section.type}" section is not valid.`,
        parsed.issues.map((issue) => ({
          sectionId: section.id,
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }

    // Store the *parsed* props, not the raw ones: parsing applies defaults and
    // normalises hrefs, and storing the raw form would mean the stored
    // document and the validated one differ.
    sections.push({ ...candidate, props: parsed.section.props as Record<string, unknown> });
  }

  return { document: { sections }, warnings };
}

export function registerCmsRoutes(app: FastifyInstance, context: AppContext): void {
  const { db } = context;

  const siteOriginFor = async (workspaceId: string): Promise<string> =>
    withWorkspace(db, workspaceId, async (tx) => {
      const [row] = await tx
        .select({ siteUrl: schema.workspaces.siteUrl })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);
      return row?.siteUrl ?? '';
    });

  /* ------------------------------------------------------------------ list */

  app.get(
    '/v1/cms/content',
    { config: { bosAccess: requirePermission('content.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const query = z
        .object({
          type: z.enum(schema.contentType.enumValues).optional(),
          status: z.enum(['draft', 'scheduled', 'published', 'archived']).optional(),
          locale: localeParam.optional(),
          search: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          cursor: z.string().max(512).optional(),
        })
        .parse(request.query);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const conditions = [isNull(schema.contentEntries.deletedAt)];
        if (query.type) conditions.push(eq(schema.contentEntries.type, query.type));
        if (query.status) conditions.push(eq(schema.contentEntries.status, query.status));
        if (query.locale) conditions.push(eq(schema.contentEntries.locale, query.locale));
        if (query.search) {
          conditions.push(sql`${schema.contentEntries.title} ilike ${`%${query.search}%`}`);
        }

        const cursorClause = query.cursor
          ? cursorCondition(
              schema.contentEntries.updatedAt,
              schema.contentEntries.id,
              decodeCursor(query.cursor),
              'desc',
            )
          : undefined;

        const rows = await tx
          .select({
            id: schema.contentEntries.id,
            type: schema.contentEntries.type,
            slug: schema.contentEntries.slug,
            path: schema.contentEntries.path,
            locale: schema.contentEntries.locale,
            title: schema.contentEntries.title,
            status: schema.contentEntries.status,
            publishedAt: schema.contentEntries.publishedAt,
            updatedAt: schema.contentEntries.updatedAt,
          })
          .from(schema.contentEntries)
          .where(withCursor(conditions, cursorClause))
          .orderBy(...orderFor(schema.contentEntries.updatedAt, schema.contentEntries.id, 'desc'))
          .limit(query.limit + 1);

        const page = buildPage(rows, query.limit, (row) => ({
          value: row.updatedAt.toISOString(),
          id: row.id,
        }));

        return {
          items: page.items.map((row) => ({
            ...row,
            publishedAt: row.publishedAt?.toISOString() ?? null,
            updatedAt: row.updatedAt.toISOString(),
          })),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
      });
    },
  );

  /* ------------------------------------------------------------------- get */

  app.get(
    '/v1/cms/content/:id',
    { config: { bosAccess: requirePermission('content.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [row] = await tx
          .select({ entry: schema.contentEntries, seo: schema.seoMetadata })
          .from(schema.contentEntries)
          .leftJoin(
            schema.seoMetadata,
            eq(schema.seoMetadata.contentEntryId, schema.contentEntries.id),
          )
          .where(and(eq(schema.contentEntries.id, id), isNull(schema.contentEntries.deletedAt)))
          .limit(1);

        // Row-level security already scoped the query to this workspace, so an
        // id from another tenant genuinely returns nothing — and 404 is both
        // the honest answer and the one that does not confirm the id exists.
        if (!row) throw ApiError.hidden('Content');

        return {
          ...row.entry,
          publishedAt: row.entry.publishedAt?.toISOString() ?? null,
          createdAt: row.entry.createdAt.toISOString(),
          updatedAt: row.entry.updatedAt.toISOString(),
          seo: row.seo
            ? {
                title: row.seo.title,
                description: row.seo.description,
                canonicalUrl: row.seo.canonicalUrl,
                noindex: row.seo.noindex,
                nofollow: row.seo.nofollow,
                ogImageMediaId: row.seo.ogImageMediaId,
              }
            : null,
        };
      });
    },
  );

  /* ---------------------------------------------------------------- create */

  app.post(
    '/v1/cms/content',
    { config: { bosAccess: requirePermission('content.write') } },
    async (request, reply) => {
      const workspace = requireWorkspace(request);
      const input = entryInput.parse(request.body);
      const userId = requireUserId(request);

      const { document, warnings } = sanitizeDocument(
        input.document,
        await siteOriginFor(workspace.workspaceId),
      );

      const created = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [entry] = await tx
          .insert(schema.contentEntries)
          .values({
            workspaceId: workspace.workspaceId,
            type: input.type,
            slug: input.slug,
            path: input.path,
            locale: input.locale,
            title: input.title,
            excerpt: input.excerpt ?? null,
            // New content is always a draft. There is no "create published"
            // path, so publishing is always a deliberate second action with
            // its own permission.
            status: 'draft',
            document,
            fields: input.fields,
            authorId: userId,
          })
          .returning({ id: schema.contentEntries.id });

        await upsertSeo(tx, workspace.workspaceId, entry!.id, input.seo);
        return entry!.id;
      }).catch(rethrowUniqueViolation);

      return reply.status(201).send({ id: created, warnings });
    },
  );

  /* ---------------------------------------------------------------- update */

  app.patch(
    '/v1/cms/content/:id',
    { config: { bosAccess: requirePermission('content.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const input = entryUpdateInput.parse(request.body);
      const userId = requireUserId(request);

      const sanitised = input.document
        ? sanitizeDocument(input.document, await siteOriginFor(workspace.workspaceId))
        : null;

      const result = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [existing] = await tx
          .select()
          .from(schema.contentEntries)
          .where(and(eq(schema.contentEntries.id, id), isNull(schema.contentEntries.deletedAt)))
          .limit(1);

        if (!existing) throw ApiError.hidden('Content');

        /*
         * Snapshot before overwriting.
         *
         * The revision is what makes "when did this page's answer change?"
         * answerable when a ranking moves, and it is also the undo button an
         * editor reaches for after pasting over the wrong section.
         */
        const [latest] = await tx
          .select({ revision: schema.contentRevisions.revision })
          .from(schema.contentRevisions)
          .where(eq(schema.contentRevisions.contentEntryId, id))
          .orderBy(sql`${schema.contentRevisions.revision} desc`)
          .limit(1);

        await tx.insert(schema.contentRevisions).values({
          workspaceId: workspace.workspaceId,
          contentEntryId: id,
          revision: (latest?.revision ?? 0) + 1,
          document: existing.document,
          fields: existing.fields,
          title: existing.title,
          createdBy: userId,
        });

        // A published page whose slug moves needs a redirect, or the URL that
        // is currently ranking starts returning 404.
        if (input.path && input.path !== existing.path && existing.status === 'published') {
          await tx
            .insert(schema.redirects)
            .values({
              workspaceId: workspace.workspaceId,
              fromPath: existing.path,
              toPath: input.path,
              statusCode: 301,
              contentEntryId: id,
            })
            .onConflictDoNothing({
              target: [schema.redirects.workspaceId, schema.redirects.fromPath],
            });
        }

        await tx
          .update(schema.contentEntries)
          .set({
            ...(input.title ? { title: input.title } : {}),
            ...(input.slug ? { slug: input.slug } : {}),
            ...(input.path ? { path: input.path } : {}),
            ...(input.locale ? { locale: input.locale } : {}),
            ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
            ...(sanitised ? { document: sanitised.document } : {}),
            ...(input.fields ? { fields: input.fields } : {}),
            updatedAt: new Date(),
          })
          .where(eq(schema.contentEntries.id, id));

        if (input.seo) await upsertSeo(tx, workspace.workspaceId, id, input.seo);

        /*
         * An edit to a page that is already live has to reach the public site,
         * and publishing is not the only moment that happens — a typo fixed on
         * a published page is the common case. The event carries both paths so
         * a rename expires the old cache entry as well as filling the new one.
         */
        if (existing.status === 'published') {
          const paths = [input.path ?? existing.path];
          if (input.path && input.path !== existing.path) paths.push(existing.path);

          await appendOutboxEvent(tx, workspace.workspaceId, {
            name: 'content.published',
            correlationId: randomUUID(),
            // Keyed on the revision, so each save produces exactly one
            // revalidation and a retried save produces none.
            idempotencyKey: `content.revalidate:${id}:${(latest?.revision ?? 0) + 1}`,
            actorUserId: userId,
            payload: {
              contentEntryId: id,
              path: paths[0],
              paths,
              locale: input.locale ?? existing.locale,
              type: existing.type,
            },
          });
        }

        return { id, previousPath: existing.path };
      }).catch(rethrowUniqueViolation);

      return { ...result, warnings: sanitised?.warnings ?? [] };
    },
  );

  /* --------------------------------------------------------------- publish */

  /**
   * Change status.
   *
   * Separate from the update endpoint and behind its own permission, because
   * "may edit a page" and "may put it in front of the public" are different
   * decisions — the whole point of having a `manager` role at all.
   */
  app.post(
    '/v1/cms/content/:id/status',
    { config: { bosAccess: requirePermission('content.publish') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const input = statusInput.parse(request.body);
      const userId = requireUserId(request);

      if (input.status === 'scheduled' && !input.publishAt) {
        throw ApiError.badRequest('A scheduled page needs a publish time.');
      }

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [existing] = await tx
          .select()
          .from(schema.contentEntries)
          .where(and(eq(schema.contentEntries.id, id), isNull(schema.contentEntries.deletedAt)))
          .limit(1);

        if (!existing) throw ApiError.hidden('Content');

        /*
         * The scaffold marks every fact only the owner can supply as
         * `[OWNER: …]`. Publishing (or scheduling) a page still carrying one
         * would put a visible placeholder — or worse, an implied claim — in
         * front of the public, so the marker is a hard stop here, at the one
         * gate every route to "live" passes through.
         */
        if (input.status === 'published' || input.status === 'scheduled') {
          const text = `${existing.title} ${JSON.stringify(existing.document)}`;
          if (text.includes('[OWNER:')) {
            throw ApiError.badRequest(
              'This page still contains [OWNER: …] placeholders. Replace them with the ' +
                'real information before publishing — placeholders must never go live.',
            );
          }
        }

        const publishedAt =
          input.status === 'published'
            ? (existing.publishedAt ?? new Date())
            : input.status === 'scheduled'
              ? new Date(input.publishAt!)
              : existing.publishedAt;

        await tx
          .update(schema.contentEntries)
          .set({ status: input.status, publishedAt, updatedAt: new Date() })
          .where(eq(schema.contentEntries.id, id));

        /*
         * The publish event, in the same transaction as the status change.
         *
         * Cache revalidation and IndexNow submission both hang off it, and
         * both must happen exactly when the page actually became public —
         * firing before the commit would submit a URL that still 404s.
         */
        if (input.status === 'published') {
          await appendOutboxEvent(tx, workspace.workspaceId, {
            name: 'content.published',
            correlationId: randomUUID(),
            // Keyed on the publish moment so re-publishing after an edit
            // produces a new event, while a retry of *this* publish does not.
            idempotencyKey: `content.published:${id}:${publishedAt?.toISOString() ?? ''}`,
            actorUserId: userId,
            payload: {
              contentEntryId: id,
              path: existing.path,
              locale: existing.locale,
              type: existing.type,
            },
          });
        }

        return { id, status: input.status, publishedAt: publishedAt?.toISOString() ?? null };
      });
    },
  );

  /* ---------------------------------------------------------------- delete */

  app.delete(
    '/v1/cms/content/:id',
    { config: { bosAccess: requirePermission('content.delete') } },
    async (request, reply) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);

      await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [existing] = await tx
          .select({ path: schema.contentEntries.path, status: schema.contentEntries.status })
          .from(schema.contentEntries)
          .where(and(eq(schema.contentEntries.id, id), isNull(schema.contentEntries.deletedAt)))
          .limit(1);

        if (!existing) throw ApiError.hidden('Content');

        // Soft delete: a page removed by mistake is recoverable, and the
        // revision history stays attached to something.
        await tx
          .update(schema.contentEntries)
          .set({ deletedAt: new Date(), status: 'archived' })
          .where(eq(schema.contentEntries.id, id));
      });

      await context.auth.audit(
        workspace.workspaceId,
        requireUserId(request),
        'content.deleted',
        requestContext(request),
        { contentEntryId: id },
      );

      return reply.status(204).send();
    },
  );

  /* -------------------------------------------------------------- revisions */

  app.get(
    '/v1/cms/content/:id/revisions',
    { config: { bosAccess: requirePermission('content.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const rows = await tx
          .select({
            id: schema.contentRevisions.id,
            revision: schema.contentRevisions.revision,
            title: schema.contentRevisions.title,
            createdAt: schema.contentRevisions.createdAt,
            createdBy: schema.contentRevisions.createdBy,
          })
          .from(schema.contentRevisions)
          .where(eq(schema.contentRevisions.contentEntryId, id))
          .orderBy(sql`${schema.contentRevisions.createdAt} desc`)
          .limit(50);

        return {
          items: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
        };
      });
    },
  );
}

async function upsertSeo(
  tx: Database,
  workspaceId: string,
  contentEntryId: string,
  seo: z.infer<typeof seoInput>,
): Promise<void> {
  await tx
    .insert(schema.seoMetadata)
    .values({
      workspaceId,
      contentEntryId,
      title: seo.title ?? null,
      description: seo.description ?? null,
      canonicalUrl: seo.canonicalUrl ?? null,
      noindex: seo.noindex,
      nofollow: seo.nofollow,
      ogImageMediaId: seo.ogImageMediaId ?? null,
    })
    .onConflictDoUpdate({
      target: schema.seoMetadata.contentEntryId,
      set: {
        title: seo.title ?? null,
        description: seo.description ?? null,
        canonicalUrl: seo.canonicalUrl ?? null,
        noindex: seo.noindex,
        nofollow: seo.nofollow,
        ogImageMediaId: seo.ogImageMediaId ?? null,
        updatedAt: new Date(),
      },
    });
}

/**
 * Turn a unique-constraint violation into a message an editor can act on.
 *
 * The raw error names the index, which tells a caller about the schema and
 * tells an editor nothing. The two constraints that a person actually hits are
 * translated; everything else stays a 500 and is logged.
 */
function rethrowUniqueViolation(error: unknown): never {
  /*
   * Drizzle wraps the driver's error in one of its own, so `code` and
   * `constraint` are on `cause` rather than on the error itself. Reading only
   * the outer error is why this translation quietly does nothing and every
   * duplicate path is reported to the editor as a 500.
   */
  const driverError = (error as { cause?: unknown }).cause ?? error;
  const code = (driverError as { code?: string }).code;
  const constraint = (driverError as { constraint?: string }).constraint ?? '';

  if (code === '23505') {
    if (constraint.includes('locale_path')) {
      throw ApiError.conflict('Another page already uses that path in this language.');
    }
    if (constraint.includes('locale_slug')) {
      throw ApiError.conflict('Another page of this type already uses that slug.');
    }
    throw ApiError.conflict('That value is already in use.');
  }

  throw error;
}
