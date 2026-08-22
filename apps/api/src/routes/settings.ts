import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, ilike, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, withWorkspace } from '@bos/database';
import { ApiError } from '../lib/errors.ts';
import { requirePermission } from '../lib/permissions.ts';
import { requireWorkspace } from '../lib/context.ts';
import type { AppContext } from '../app.ts';

/**
 * Integration status for the settings screen: what is connected, what the
 * last sync did, and a button to run one now — so checking Search Console or
 * the content provider never requires a terminal.
 *
 * Never returned from here: keys, tokens, or Application Passwords. Status
 * only, and hostnames rather than full credentials-bearing URLs.
 */

export function registerSettingsRoutes(app: FastifyInstance, context: AppContext): void {
  const { db, config } = context;

  app.get(
    '/v1/settings/integrations',
    { config: { bosAccess: requirePermission('settings.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);

      const searchConsole = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [latest] = await tx
          .select({ date: schema.searchConsoleDaily.date })
          .from(schema.searchConsoleDaily)
          .orderBy(desc(schema.searchConsoleDaily.date))
          .limit(1);
        const [count] = await tx
          .select({ rows: sql<number>`count(*)::int` })
          .from(schema.searchConsoleDaily);
        return {
          configured: Boolean(config.GSC_CLIENT_EMAIL && config.GSC_PRIVATE_KEY),
          /** The ingest targets one workspace by slug; say whether it is this one. */
          targetsThisWorkspace: config.GSC_WORKSPACE === workspace.workspaceSlug,
          property: config.GSC_PROPERTY ?? null,
          serviceAccount: config.GSC_CLIENT_EMAIL ?? null,
          latestDate: latest?.date ?? null,
          totalRows: count?.rows ?? 0,
        };
      });

      // The content provider is the *site's* configuration; this API reports
      // what its own environment shows, which in a standard deployment is
      // the same values. Absent here + wordpress on the site would itself be
      // a deployment inconsistency worth seeing on this screen.
      const provider = process.env.CONTENT_PROVIDER ?? 'internal';
      const wordpressUrl = process.env.WORDPRESS_API_URL ?? null;
      const contentProvider = {
        provider,
        wordpressHost: wordpressUrl ? new URL(wordpressUrl).host : null,
      };

      return { searchConsole, contentProvider };
    },
  );

  /**
   * Run a Search Console ingest now instead of waiting for the nightly
   * cron. Same code path, same idempotent upserts; the response carries the
   * outcome (or the error, normalized) so a failed sync is visible on the
   * screen rather than in a log.
   */
  app.post(
    '/v1/settings/search-console/sync',
    { config: { bosAccess: requirePermission('settings.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      if (!config.GSC_CLIENT_EMAIL || !config.GSC_PRIVATE_KEY) {
        throw ApiError.badRequest(
          'Search Console is not configured. Set GSC_CLIENT_EMAIL, GSC_PRIVATE_KEY and ' +
            'GSC_WORKSPACE in the API environment.',
        );
      }
      if (config.GSC_WORKSPACE !== workspace.workspaceSlug) {
        throw ApiError.badRequest(
          `The configured ingest targets workspace "${config.GSC_WORKSPACE ?? '(none)'}", ` +
            'not this one.',
        );
      }

      const { ingestSearchConsole } = await import('../services/search-console.ts');
      try {
        const result = await ingestSearchConsole({
          db,
          config,
          resolveWorkspaceId: context.resolveWorkspaceId,
          logger: request.log,
        });
        return { ok: true, result };
      } catch (error) {
        // Normalized: the message may name the API's HTTP status, never keys.
        const message = error instanceof Error ? error.message.slice(0, 300) : 'Sync failed';
        return { ok: false, error: message };
      }
    },
  );

  /**
   * Probe the WordPress REST API the adapter would use: reachability and
   * shape, not content. The Application Password never leaves the server —
   * the probe hits the public posts endpoint, which is what the adapter
   * reads.
   */
  app.post(
    '/v1/settings/content-provider/check',
    { config: { bosAccess: requirePermission('settings.read') } },
    async () => {
      const provider = process.env.CONTENT_PROVIDER ?? 'internal';
      if (provider !== 'wordpress') {
        return {
          provider,
          reachable: null,
          detail:
            provider === 'internal'
              ? 'Content is served from the built-in CMS; nothing external to check.'
              : 'The markdown provider reads local files; nothing external to check.',
        };
      }

      const base = process.env.WORDPRESS_API_URL;
      if (!base) {
        return { provider, reachable: false, detail: 'WORDPRESS_API_URL is not set.' };
      }

      const probeUrl = `${base.replace(/\/+$/, '')}/wp-json/wp/v2/posts?per_page=1&_fields=id,modified`;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(probeUrl, { signal: controller.signal });
        clearTimeout(timer);
        if (!response.ok) {
          return {
            provider,
            reachable: false,
            detail: `The WordPress REST API answered HTTP ${response.status}.`,
          };
        }
        const body = (await response.json().catch(() => null)) as unknown;
        const shapeOk = Array.isArray(body);
        return {
          provider,
          reachable: shapeOk,
          detail: shapeOk
            ? `Reachable; ${response.headers.get('x-wp-total') ?? 'unknown'} posts visible.`
            : 'Reachable, but the response is not the WordPress REST shape.',
        };
      } catch (error) {
        return {
          provider,
          reachable: false,
          detail:
            error instanceof Error && error.name === 'AbortError'
              ? 'Timed out after 8 seconds.'
              : 'Connection failed.',
        };
      }
    },
  );
}

/**
 * The audit trail, readable. Filters by action and time; rows carry who,
 * what, when, from where. The detail JSON is what the writers stored —
 * request context and before/after summaries, never tokens or secrets (the
 * audit writers are reviewed on exactly that property).
 */
export function registerAuditRoutes(app: FastifyInstance, context: AppContext): void {
  const { db } = context;

  app.get(
    '/v1/settings/audit',
    { config: { bosAccess: requirePermission('audit.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const query = z
        .object({
          action: z.string().max(120).optional(),
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const conditions = [];
        if (query.action) conditions.push(ilike(schema.auditLog.action, `%${query.action}%`));
        if (query.from) conditions.push(gte(schema.auditLog.createdAt, new Date(query.from)));
        if (query.to) conditions.push(lte(schema.auditLog.createdAt, new Date(query.to)));

        const rows = await tx
          .select({
            id: schema.auditLog.id,
            action: schema.auditLog.action,
            entityType: schema.auditLog.entityType,
            entityId: schema.auditLog.entityId,
            ipAddress: schema.auditLog.ipAddress,
            detail: schema.auditLog.detail,
            createdAt: schema.auditLog.createdAt,
            actorEmail: schema.users.email,
            actorName: schema.users.fullName,
          })
          .from(schema.auditLog)
          .leftJoin(schema.users, eq(schema.users.id, schema.auditLog.actorUserId))
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(schema.auditLog.createdAt))
          .limit(query.limit);

        return {
          items: rows.map((row) => ({
            ...row,
            createdAt: row.createdAt.toISOString(),
          })),
        };
      });
    },
  );
}
