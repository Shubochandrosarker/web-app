import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace, type Database } from '@bos/database';
import type { ContentEntry, ContentRoute, SectionReferences } from '@bos/content';
import { EMPTY_REFERENCES } from '@bos/content';
import { parsePageDocument, pageDocumentSchema } from '@bos/sections';
import { ApiError } from '../lib/errors.ts';
import { publicRoute } from '../lib/permissions.ts';
import {
  buildPage,
  cursorCondition,
  decodeCursor,
  orderFor,
  withCursor,
  type SortDirection,
} from '../lib/pagination.ts';
import { resolveSectionReferences } from '../lib/references.ts';

/**
 * The **public** content API.
 *
 * The invariant, and the reason this file is separate from the CMS routes:
 * every query here filters on `status = 'published'` and it is not a parameter.
 * A caller cannot ask for drafts, because there is no way to express the
 * request — not because a check rejects it. Draft access lives in
 * `routes/cms.ts`, behind `content.read`.
 *
 * A scheduled entry is not published either. `published_at <= now()` is part
 * of the same predicate, so a post scheduled for next Tuesday is invisible
 * until Tuesday even though its status says `published` the moment it is
 * queued.
 */

const localeParam = z.string().min(2).max(10);

const byPathQuery = z.object({
  workspace: z.string().min(1).max(140),
  path: z.string().startsWith('/').max(2048),
  locale: localeParam,
});

const listQuery = z.object({
  workspace: z.string().min(1).max(140),
  type: z.enum(schema.contentType.enumValues).optional(),
  locale: localeParam.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(512).optional(),
  sort: z.enum(['publishedAt', 'updatedAt', 'title']).default('publishedAt'),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

const routesQuery = z.object({
  workspace: z.string().min(1).max(140),
  locale: localeParam.optional(),
});

type EntryRow = typeof schema.contentEntries.$inferSelect;
type SeoRow = typeof schema.seoMetadata.$inferSelect;

/**
 * The predicate that defines "public".
 *
 * One function, called by every route in this file, so there is exactly one
 * definition of publicly visible content. Three separate route handlers each
 * writing their own `eq(status, 'published')` is how one of them ends up
 * missing the `published_at` half.
 */
function publiclyVisible() {
  return and(
    eq(schema.contentEntries.status, 'published'),
    isNull(schema.contentEntries.deletedAt),
    or(
      isNull(schema.contentEntries.publishedAt),
      lte(schema.contentEntries.publishedAt, sql`now()`),
    ),
  );
}

/**
 * Map a row onto the provider-agnostic shape.
 *
 * `authorId`, `metadata`, `parentId` and the revision history are all absent —
 * a public response carries what a page renders and nothing about how it was
 * made.
 */
export function toContentEntry(
  entry: EntryRow,
  seo: SeoRow | null,
  references: SectionReferences,
): ContentEntry {
  return {
    id: entry.id,
    workspaceId: entry.workspaceId,
    type: entry.type,
    slug: entry.slug,
    path: entry.path,
    locale: entry.locale,
    title: entry.title,
    ...(entry.excerpt ? { excerpt: entry.excerpt } : {}),
    status: entry.status,
    ...(entry.publishedAt ? { publishedAt: entry.publishedAt.toISOString() } : {}),
    updatedAt: entry.updatedAt.toISOString(),
    document: entry.document as ContentEntry['document'],
    seo: {
      ...(seo?.title ? { title: seo.title } : {}),
      ...(seo?.description ? { description: seo.description } : {}),
      ...(seo?.canonicalUrl ? { canonicalUrl: seo.canonicalUrl } : {}),
      noindex: seo?.noindex ?? false,
      nofollow: seo?.nofollow ?? false,
      ...(seo?.ogImageMediaId ? { ogImageMediaId: seo.ogImageMediaId } : {}),
      schemaOverrides: (seo?.schemaOverrides as Record<string, unknown>[] | undefined) ?? [],
    },
    fields: (entry.fields as Record<string, unknown>) ?? {},
    translations: {},
    references,
  };
}

/** Which column a sort key maps to, and the cursor value it produces. */
const SORT_COLUMNS = {
  publishedAt: schema.contentEntries.publishedAt,
  updatedAt: schema.contentEntries.updatedAt,
  title: schema.contentEntries.title,
} as const;

function cursorValueFor(entry: EntryRow, sort: keyof typeof SORT_COLUMNS): string {
  switch (sort) {
    case 'publishedAt':
      return (entry.publishedAt ?? entry.updatedAt).toISOString();
    case 'updatedAt':
      return entry.updatedAt.toISOString();
    case 'title':
      return entry.title;
  }
}

export interface PublicContentOptions {
  readonly publicMediaBaseUrl: string | undefined;
  readonly turnstileSiteKey: string | undefined;
  readonly resolveWorkspaceId: (slug: string) => Promise<string>;
}

export function registerPublicContentRoutes(
  app: FastifyInstance,
  db: Database,
  options: PublicContentOptions,
): void {
  const why = 'Serves the published website. No authentication by design.';

  app.get('/v1/content/by-path', { config: { bosAccess: publicRoute(why) } }, async (request) => {
    const query = byPathQuery.parse(request.query);
    const workspaceId = await options.resolveWorkspaceId(query.workspace);

    return withWorkspace(db, workspaceId, async (tx) => {
      const [row] = await tx
        .select({ entry: schema.contentEntries, seo: schema.seoMetadata })
        .from(schema.contentEntries)
        .leftJoin(
          schema.seoMetadata,
          eq(schema.seoMetadata.contentEntryId, schema.contentEntries.id),
        )
        .where(
          and(
            eq(schema.contentEntries.path, query.path),
            eq(schema.contentEntries.locale, query.locale),
            publiclyVisible(),
          ),
        )
        .limit(1);

      if (!row) throw ApiError.notFound('Content');

      // Resolve only what this page's sections actually reference, so a page
      // with no service grid never touches the services table.
      const { sections } = parsePageDocument(pageDocumentSchema.parse(row.entry.document));
      const references = await resolveSectionReferences(tx, workspaceId, sections, {
        publicMediaBaseUrl: options.publicMediaBaseUrl,
        turnstileSiteKey: options.turnstileSiteKey,
        defaultLocale: query.locale,
      });

      return toContentEntry(row.entry, row.seo, references);
    });
  });

  /**
   * Every renderable route, for sitemaps and static params.
   *
   * `noindex` travels with the route so the sitemap generator can exclude it —
   * a URL that is both in a sitemap and `noindex` is a contradictory signal,
   * and Search Console reports it as an error rather than ignoring it.
   */
  app.get('/v1/content/routes', { config: { bosAccess: publicRoute(why) } }, async (request) => {
    const query = routesQuery.parse(request.query);
    const workspaceId = await options.resolveWorkspaceId(query.workspace);

    return withWorkspace(db, workspaceId, async (tx) => {
      const conditions = [publiclyVisible()];
      if (query.locale) conditions.push(eq(schema.contentEntries.locale, query.locale));

      const rows = await tx
        .select({
          path: schema.contentEntries.path,
          locale: schema.contentEntries.locale,
          type: schema.contentEntries.type,
          updatedAt: schema.contentEntries.updatedAt,
          noindex: schema.seoMetadata.noindex,
        })
        .from(schema.contentEntries)
        .leftJoin(
          schema.seoMetadata,
          eq(schema.seoMetadata.contentEntryId, schema.contentEntries.id),
        )
        .where(and(...conditions))
        // Bounded so one workspace with fifty thousand pages cannot turn the
        // sitemap route into a full-table scan on every request.
        .limit(50_000);

      const routes: ContentRoute[] = rows.map((row) => ({
        path: row.path,
        locale: row.locale,
        type: row.type,
        updatedAt: row.updatedAt.toISOString(),
        noindex: row.noindex ?? false,
      }));

      return { routes };
    });
  });

  app.get('/v1/content', { config: { bosAccess: publicRoute(why) } }, async (request) => {
    const query = listQuery.parse(request.query);
    const workspaceId = await options.resolveWorkspaceId(query.workspace);
    const direction: SortDirection = query.direction;
    const sortColumn = SORT_COLUMNS[query.sort];

    return withWorkspace(db, workspaceId, async (tx) => {
      const conditions = [publiclyVisible()];
      if (query.type) conditions.push(eq(schema.contentEntries.type, query.type));
      if (query.locale) conditions.push(eq(schema.contentEntries.locale, query.locale));

      const cursorClause = query.cursor
        ? cursorCondition(
            sortColumn,
            schema.contentEntries.id,
            decodeCursor(query.cursor),
            direction,
          )
        : undefined;

      const rows = await tx
        .select({ entry: schema.contentEntries, seo: schema.seoMetadata })
        .from(schema.contentEntries)
        .leftJoin(
          schema.seoMetadata,
          eq(schema.seoMetadata.contentEntryId, schema.contentEntries.id),
        )
        .where(withCursor(conditions, cursorClause))
        .orderBy(...orderFor(sortColumn, schema.contentEntries.id, direction))
        // One extra row decides whether a next page exists, without a second
        // COUNT over the same predicate.
        .limit(query.limit + 1);

      const page = buildPage(rows, query.limit, (row) => ({
        value: cursorValueFor(row.entry, query.sort),
        id: row.entry.id,
      }));

      return {
        // A list is a set of cards, not a set of rendered pages, so section
        // references are deliberately not resolved here — doing so would turn
        // one list request into a reference query per item.
        items: page.items.map((row) => toContentEntry(row.entry, row.seo, EMPTY_REFERENCES)),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    });
  });

  /**
   * Redirect lookup for the site's middleware.
   *
   * Served from the database rather than baked into the build so an editor
   * changing a slug does not need a deploy — the most common cause of
   * self-inflicted 404s after a migration.
   */
  app.get('/v1/redirects', { config: { bosAccess: publicRoute(why) } }, async (request) => {
    const query = z.object({ workspace: z.string().min(1).max(140) }).parse(request.query);
    const workspaceId = await options.resolveWorkspaceId(query.workspace);

    return withWorkspace(db, workspaceId, async (tx) => {
      const rows = await tx
        .select({
          fromPath: schema.redirects.fromPath,
          toPath: schema.redirects.toPath,
          statusCode: schema.redirects.statusCode,
        })
        .from(schema.redirects)
        .where(eq(schema.redirects.enabled, true))
        .limit(10_000);

      return { redirects: rows };
    });
  });
}
