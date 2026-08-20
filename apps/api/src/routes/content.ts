import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace, type Database } from '@bos/database';
import type { ContentEntry, ContentRoute } from '@bos/content';
import { ApiError } from '../lib/errors.ts';
import { resolveWorkspaceId } from '../lib/workspace.ts';

/**
 * Content read API — what `InternalContentProvider` in @bos/content consumes.
 *
 * Implemented in Phase 1 rather than stubbed, because it is the one seam most
 * likely to be wrong on paper: it proves the database schema, the content
 * contract and the site's renderer actually agree on a shape.
 *
 * Read-only. Authoring endpoints are Phase 2 (TASK-201).
 */

const byPathQuery = z.object({
  workspace: z.string().min(1),
  path: z.string().startsWith('/'),
  locale: z.string().min(2).max(10),
});

const listQuery = z.object({
  workspace: z.string().min(1),
  type: z.enum(schema.contentType.enumValues).optional(),
  locale: z.string().min(2).max(10).optional(),
  status: z.enum(schema.publishStatus.enumValues).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

const routesQuery = z.object({
  workspace: z.string().min(1),
  locale: z.string().min(2).max(10).optional(),
});

type EntryRow = typeof schema.contentEntries.$inferSelect;
type SeoRow = typeof schema.seoMetadata.$inferSelect;

/** Map a database row onto the provider-agnostic content shape. */
function toContentEntry(entry: EntryRow, seo: SeoRow | null): ContentEntry {
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
  };
}

export function registerContentRoutes(app: FastifyInstance, db: Database): void {
  app.get('/v1/content/by-path', async (request) => {
    const query = byPathQuery.parse(request.query);
    const workspaceId = await resolveWorkspaceId(db, query.workspace);

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
            isNull(schema.contentEntries.deletedAt),
          ),
        )
        .limit(1);

      if (!row) throw ApiError.notFound('Content');
      return toContentEntry(row.entry, row.seo);
    });
  });

  app.get('/v1/content/routes', async (request) => {
    const query = routesQuery.parse(request.query);
    const workspaceId = await resolveWorkspaceId(db, query.workspace);

    return withWorkspace(db, workspaceId, async (tx) => {
      const conditions = [
        eq(schema.contentEntries.status, 'published'),
        isNull(schema.contentEntries.deletedAt),
      ];
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
        .where(and(...conditions));

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

  app.get('/v1/content', async (request) => {
    const query = listQuery.parse(request.query);
    const workspaceId = await resolveWorkspaceId(db, query.workspace);

    return withWorkspace(db, workspaceId, async (tx) => {
      const conditions = [isNull(schema.contentEntries.deletedAt)];
      if (query.type) conditions.push(eq(schema.contentEntries.type, query.type));
      if (query.locale) conditions.push(eq(schema.contentEntries.locale, query.locale));
      if (query.status) conditions.push(eq(schema.contentEntries.status, query.status));

      // Fetch one extra row to decide whether a next page exists, rather than
      // running a second COUNT over the same predicate.
      const rows = await tx
        .select({ entry: schema.contentEntries, seo: schema.seoMetadata })
        .from(schema.contentEntries)
        .leftJoin(
          schema.seoMetadata,
          eq(schema.seoMetadata.contentEntryId, schema.contentEntries.id),
        )
        .where(and(...conditions))
        .limit(query.limit + 1);

      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;

      return {
        items: page.map((row) => toContentEntry(row.entry, row.seo)),
        ...(hasMore ? { nextCursor: page.at(-1)?.entry.id } : {}),
      };
    });
  });
}
