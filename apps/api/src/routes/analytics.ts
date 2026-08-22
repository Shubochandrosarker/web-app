import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace } from '@bos/database';
import { requirePermission } from '../lib/permissions.ts';
import { requireWorkspace } from '../lib/context.ts';
import type { AppContext } from '../app.ts';

/**
 * The analytics read API.
 *
 * Two sources with different freshness, used for what each is good at:
 * headline numbers and breakdowns are computed live from the raw session and
 * event tables (so today exists), while the day-by-day series reads the
 * nightly rollup plus a live count of leads — the one metric the rollup does
 * not carry. Everything is scoped by the workspace transaction; there is no
 * cross-tenant read path here at all.
 */

const windowQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

function windowStart(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

export function registerAnalyticsRoutes(app: FastifyInstance, context: AppContext): void {
  const { db, config } = context;

  /* -------------------------------------------------------------- overview */

  app.get(
    '/v1/analytics/overview',
    { config: { bosAccess: requirePermission('analytics.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { days } = windowQuery.parse(request.query);
      const start = windowStart(days);
      const previousStart = windowStart(days * 2);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const totalsFor = async (from: Date, to: Date | null) => {
          const upper = to ?? new Date(Date.now() + 60_000);
          const result = await tx.execute<{
            sessions: number;
            page_views: number;
            conversions: number;
            leads: number;
          }>(sql`
            select
              (select count(*)::int from analytics_sessions
                where started_at >= ${from} and started_at < ${upper})   as sessions,
              (select count(*)::int from analytics_events
                where name = 'page_view'
                  and occurred_at >= ${from} and occurred_at < ${upper}) as page_views,
              (select count(*)::int from analytics_events
                where name = 'form_submit'
                  and occurred_at >= ${from} and occurred_at < ${upper}) as conversions,
              (select count(*)::int from leads
                where created_at >= ${from} and created_at < ${upper}
                  and deleted_at is null)                                as leads
          `);
          return result.rows[0]!;
        };

        const [current, previous] = [
          await totalsFor(start, null),
          await totalsFor(previousStart, start),
        ];

        // Day series: rollup for traffic, live for leads (the rollup does
        // not carry them), merged on the day key.
        const daily = await tx
          .select({
            date: schema.analyticsDaily.date,
            sessions: schema.analyticsDaily.sessions,
            pageViews: schema.analyticsDaily.pageViews,
            conversions: schema.analyticsDaily.conversions,
          })
          .from(schema.analyticsDaily)
          .where(
            and(
              eq(schema.analyticsDaily.dimension, 'total'),
              gte(schema.analyticsDaily.date, start.toISOString().slice(0, 10)),
            ),
          )
          .orderBy(schema.analyticsDaily.date);

        const leadRows = await tx.execute<{ day: string; leads: number }>(sql`
          select to_char(created_at, 'YYYY-MM-DD') as day, count(*)::int as leads
          from leads
          where created_at >= ${start} and deleted_at is null
          group by 1 order by 1
        `);
        const leadsByDay = new Map(leadRows.rows.map((row) => [row.day, row.leads]));

        return {
          window: { days },
          current,
          previous,
          series: daily.map((row) => ({
            date: row.date,
            sessions: row.sessions,
            pageViews: row.pageViews,
            conversions: row.conversions,
            leads: leadsByDay.get(row.date) ?? 0,
          })),
        };
      });
    },
  );

  /* --------------------------------------------------------------- sources */

  app.get(
    '/v1/analytics/sources',
    { config: { bosAccess: requirePermission('analytics.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { days } = windowQuery.parse(request.query);
      const start = windowStart(days);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const channels = await tx.execute<{
          channel: string;
          sessions: number;
          conversions: number;
        }>(sql`
          select
            s.channel,
            count(*)::int as sessions,
            count(*) filter (where s.contact_id is not null)::int as conversions
          from analytics_sessions s
          where s.started_at >= ${start}
          group by s.channel
          order by sessions desc
        `);

        // Which AI assistant, which search engine, which campaign — the
        // level under the channel, where "what should we do more of" lives.
        const sources = await tx.execute<{
          channel: string;
          source: string;
          sessions: number;
        }>(sql`
          select
            channel,
            coalesce(nullif(source_key, ''), nullif(utm_source, ''),
                     nullif(split_part(coalesce(referrer, ''), '/', 3), ''), 'direct') as source,
            count(*)::int as sessions
          from analytics_sessions
          where started_at >= ${start}
          group by 1, 2
          order by sessions desc
          limit 50
        `);

        const campaigns = await tx.execute<{
          campaign: string;
          sessions: number;
        }>(sql`
          select utm_campaign as campaign, count(*)::int as sessions
          from analytics_sessions
          where started_at >= ${start} and utm_campaign is not null
          group by 1 order by sessions desc limit 25
        `);

        return {
          window: { days },
          channels: channels.rows,
          sources: sources.rows,
          campaigns: campaigns.rows,
        };
      });
    },
  );

  /* ----------------------------------------------------------------- pages */

  app.get(
    '/v1/analytics/pages',
    { config: { bosAccess: requirePermission('analytics.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { days } = windowQuery.parse(request.query);
      const start = windowStart(days);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const pages = await tx.execute<{
          path: string;
          page_views: number;
          sessions: number;
          conversions: number;
        }>(sql`
          select
            e.path,
            count(*) filter (where e.name = 'page_view')::int  as page_views,
            count(distinct e.session_id)::int                   as sessions,
            count(*) filter (where e.name = 'form_submit')::int as conversions
          from analytics_events e
          where e.occurred_at >= ${start}
          group by e.path
          order by page_views desc
          limit 100
        `);
        return { window: { days }, pages: pages.rows };
      });
    },
  );

  /* ------------------------------------------------------------ conversions */

  app.get(
    '/v1/analytics/conversions',
    { config: { bosAccess: requirePermission('analytics.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { days } = windowQuery.parse(request.query);
      const start = windowStart(days);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const funnel = await tx.execute<{
          status: string;
          count: number;
          value: number;
        }>(sql`
          select status, count(*)::int as count, coalesce(sum(value_amount), 0)::int as value
          from leads
          where created_at >= ${start} and deleted_at is null
          group by status
        `);

        const bySource = await tx.execute<{ source: string; leads: number; won: number }>(sql`
          select source, count(*)::int as leads,
                 count(*) filter (where status = 'won')::int as won
          from leads
          where created_at >= ${start} and deleted_at is null
          group by source order by leads desc limit 25
        `);

        const byService = await tx.execute<{ service: string; leads: number; won: number }>(sql`
          select coalesce(sv.name, '(none)') as service,
                 count(*)::int as leads,
                 count(*) filter (where l.status = 'won')::int as won
          from leads l
          left join services sv on sv.id = l.service_id
          where l.created_at >= ${start} and l.deleted_at is null
          group by 1 order by leads desc limit 25
        `);

        const byLandingPath = await tx.execute<{ path: string; conversions: number }>(sql`
          select path, count(*)::int as conversions
          from analytics_events
          where name = 'form_submit' and occurred_at >= ${start}
          group by path order by conversions desc limit 25
        `);

        return {
          window: { days },
          funnel: funnel.rows,
          bySource: bySource.rows,
          byService: byService.rows,
          byLandingPath: byLandingPath.rows,
        };
      });
    },
  );

  /* ---------------------------------------------------------- search console */

  app.get(
    '/v1/analytics/search',
    { config: { bosAccess: requirePermission('analytics.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const query = windowQuery
        .extend({ dimension: z.enum(['query', 'page', 'device', 'country']).default('query') })
        .parse(request.query);
      const start = windowStart(query.days).toISOString().slice(0, 10);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const rows = await tx
          .select({
            value: schema.searchConsoleDaily.dimensionValue,
            clicks: sql<number>`sum(${schema.searchConsoleDaily.clicks})::int`,
            impressions: sql<number>`sum(${schema.searchConsoleDaily.impressions})::int`,
            // Impression-weighted average position, the way GSC itself does.
            position: sql<number>`
              case when sum(${schema.searchConsoleDaily.impressions}) = 0 then 0
              else round(
                sum(${schema.searchConsoleDaily.positionTimes100}::bigint
                    * ${schema.searchConsoleDaily.impressions})::numeric
                / nullif(sum(${schema.searchConsoleDaily.impressions}), 0) / 100.0, 1)::float
              end`,
          })
          .from(schema.searchConsoleDaily)
          .where(
            and(
              eq(schema.searchConsoleDaily.dimension, query.dimension),
              gte(schema.searchConsoleDaily.date, start),
            ),
          )
          .groupBy(schema.searchConsoleDaily.dimensionValue)
          .orderBy(desc(sql`sum(${schema.searchConsoleDaily.clicks})`))
          .limit(100);

        const [latest] = await tx
          .select({ date: schema.searchConsoleDaily.date })
          .from(schema.searchConsoleDaily)
          .orderBy(desc(schema.searchConsoleDaily.date))
          .limit(1);

        return {
          window: { days: query.days },
          dimension: query.dimension,
          // Configured = credentials exist; connected = rows actually arrived.
          configured: Boolean(config.GSC_CLIENT_EMAIL && config.GSC_PRIVATE_KEY),
          latestDate: latest?.date ?? null,
          rows: rows.map((row) => ({
            ...row,
            ctr: row.impressions > 0 ? row.clicks / row.impressions : 0,
          })),
        };
      });
    },
  );

  /* ---------------------------------------------------------- attribution */

  /**
   * Which channel gets the credit for each lead — under a model the viewer
   * picks, because the honest answer is that both are defensible: first
   * touch credits discovery, last touch credits conversion. The touches are
   * precomputed at capture time; this only aggregates them.
   */
  app.get(
    '/v1/analytics/attribution',
    { config: { bosAccess: requirePermission('analytics.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const query = windowQuery
        .extend({ model: z.enum(['first_touch', 'last_touch']).default('last_touch') })
        .parse(request.query);
      const start = windowStart(query.days);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const flag =
          query.model === 'first_touch'
            ? schema.attributionTouches.isFirstTouch
            : schema.attributionTouches.isLastTouch;

        const rows = await tx
          .select({
            channel: schema.attributionTouches.channel,
            sourceKey: schema.attributionTouches.sourceKey,
            leads: sql<number>`count(distinct ${schema.attributionTouches.leadId})::int`,
          })
          .from(schema.attributionTouches)
          .where(
            and(
              eq(flag, true),
              sql`${schema.attributionTouches.leadId} is not null`,
              gte(schema.attributionTouches.occurredAt, start),
            ),
          )
          .groupBy(schema.attributionTouches.channel, schema.attributionTouches.sourceKey)
          .orderBy(desc(sql`count(distinct ${schema.attributionTouches.leadId})`));

        return { window: { days: query.days }, model: query.model, rows };
      });
    },
  );

  /* -------------------------------------------------------------- revenue */

  /**
   * Money actually verified, from the orders module: staff-verified payments
   * summed per day and per currency. No projection, no pipeline-weighted
   * guesses — this is the number the bank statement will agree with.
   */
  app.get(
    '/v1/analytics/revenue',
    { config: { bosAccess: requirePermission('analytics.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { days } = windowQuery.parse(request.query);
      const start = windowStart(days);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const totals = await tx
          .select({
            currency: schema.payments.currency,
            amount: sql<number>`coalesce(sum(${schema.payments.amount}), 0)::int`,
            payments: sql<number>`count(*)::int`,
          })
          .from(schema.payments)
          .where(and(eq(schema.payments.status, 'verified'), gte(schema.payments.createdAt, start)))
          .groupBy(schema.payments.currency);

        const daily = await tx
          .select({
            day: sql<string>`to_char(${schema.payments.createdAt}, 'YYYY-MM-DD')`,
            currency: schema.payments.currency,
            amount: sql<number>`coalesce(sum(${schema.payments.amount}), 0)::int`,
          })
          .from(schema.payments)
          .where(and(eq(schema.payments.status, 'verified'), gte(schema.payments.createdAt, start)))
          .groupBy(
            sql`to_char(${schema.payments.createdAt}, 'YYYY-MM-DD')`,
            schema.payments.currency,
          )
          .orderBy(sql`to_char(${schema.payments.createdAt}, 'YYYY-MM-DD')`);

        const orders = await tx
          .select({
            completed: sql<number>`count(*) filter (where ${schema.orders.status} = 'completed')::int`,
            total: sql<number>`count(*)::int`,
          })
          .from(schema.orders)
          .where(and(gte(schema.orders.createdAt, start), sql`${schema.orders.deletedAt} is null`));

        return {
          window: { days },
          totals,
          daily,
          orders: orders[0] ?? { completed: 0, total: 0 },
        };
      });
    },
  );
}
