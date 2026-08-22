import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace, withoutTenantScope } from '@bos/database';
import { visitorPseudonym } from '../lib/crypto.ts';
import { internalRoute } from '../lib/permissions.ts';
import { dispatchOutbox, pruneOutbox, type OutboxHandler } from '../lib/outbox.ts';
import { rescanPendingDocuments, sweepExpiredDocuments } from './documents.ts';
import {
  createNotificationDispatcher,
  type LeadCreatedPayload,
} from '../services/notifications.ts';
import {
  createAutomationEngine,
  type AutomationEngine,
} from '../services/automation-engine.ts';
import { createRevalidator } from '../services/revalidation.ts';
import type { EmailProvider, WhatsappProvider } from '../providers/notifications.ts';
import type { AppContext } from '../app.ts';
import { ApiError } from '../lib/errors.ts';

/**
 * Endpoints the edge Worker calls.
 *
 * These exist because the Worker already called them. The queue consumer was
 * posting to `/v1/internal/ingest` and the cron to `/v1/internal/jobs/*`, and
 * neither route existed — so every message retried five times and landed in
 * the dead-letter queue. A Worker deployed against a missing endpoint is not a
 * missing feature, it is a queue that fills up.
 *
 * Every route here is `internalRoute()`: authenticated by a shared secret
 * compared in constant time, never reachable with a session, and never
 * exposed to a browser (the CORS allow-list does not include the Worker,
 * which has no origin).
 */

const eventNameSchema = z
  .string()
  .min(1)
  .max(64)
  // An allow-list rather than free text. Without it, anything that reaches the
  // collector can mint event names and the analytics table becomes a
  // write-anything endpoint with a shared secret in front of it.
  .refine(
    (value) =>
      [
        'page_view',
        'cta_click',
        'whatsapp_click',
        'phone_click',
        'form_view',
        'form_start',
        'form_submit',
        'scroll_depth',
        'outbound_click',
        'conversion',
      ].includes(value),
    'is not a recognised event name',
  );

const analyticsEventSchema = z.object({
  name: eventNameSchema,
  path: z.string().max(2048),
  referrer: z.string().max(2048).optional(),
  visitorHash: z.string().max(64).optional(),
  country: z.string().max(2).optional(),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  properties: z.record(z.string(), z.unknown()).default({}),
  utm: z
    .object({
      source: z.string().max(255).optional(),
      medium: z.string().max(255).optional(),
      campaign: z.string().max(255).optional(),
      term: z.string().max(255).optional(),
      content: z.string().max(255).optional(),
    })
    .default({}),
});

const ingestBody = z.object({
  kind: z.enum(['analytics.batch', 'webhook.received']),
  /**
   * Resolved by the Worker from the request's Origin, never taken from the
   * page's JavaScript. See `apps/edge/src/collect.ts` — a client-supplied slug
   * would let any page on the internet write into any tenant's analytics.
   */
  workspace: z.string().min(1).max(140),
  events: z.array(analyticsEventSchema).max(50).optional(),
  source: z.string().max(64).optional(),
  body: z.string().max(200_000).optional(),
  receivedAt: z.iso.datetime({ offset: true }).optional(),
});

/**
 * Properties that must never be stored on an analytics event.
 *
 * A `form_submit` event legitimately says which form was submitted. It must
 * not say what was in it — a registration number in an analytics row is a
 * personal identifier in a table built to be queried loosely and retained
 * long.
 */
const FORBIDDEN_PROPERTY_KEYS = [
  'email',
  'phone',
  'whatsapp',
  'name',
  'fullname',
  'full_name',
  'message',
  'registration',
  'registration_number',
  'roll',
  'nid',
  'passport',
  'address',
  'dob',
  'password',
  'token',
];

function stripSensitiveProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(properties)) {
    const lowered = key.toLowerCase();
    if (FORBIDDEN_PROPERTY_KEYS.some((forbidden) => lowered.includes(forbidden))) continue;
    // Values are capped as well as filtered: a long string in a property bag
    // is either a mistake or a payload.
    clean[key] = typeof value === 'string' ? value.slice(0, 500) : value;
  }

  return clean;
}

export interface InternalRouteDependencies {
  readonly email: EmailProvider;
  readonly whatsapp: WhatsappProvider;
  readonly logger: {
    info(payload: Record<string, unknown>, message: string): void;
    warn(payload: Record<string, unknown>, message: string): void;
    error(payload: Record<string, unknown>, message: string): void;
  };
}

/** One engine per handler; stateless, so instances can coexist freely. */
export function buildAutomationEngine(
  context: AppContext,
  deps: InternalRouteDependencies,
): AutomationEngine {
  return createAutomationEngine({
    db: context.db,
    config: context.config,
    email: deps.email,
    whatsapp: deps.whatsapp,
    logger: deps.logger,
  });
}

/**
 * The one outbox handler.
 *
 * Shared by the cron endpoint and the in-process dispatcher, so there is
 * exactly one definition of what each event does. Two copies would drift, and
 * the copy that drifted would be the one that runs at 2am.
 */
export function createOutboxHandler(
  context: AppContext,
  deps: InternalRouteDependencies,
  engine: AutomationEngine = buildAutomationEngine(context, deps),
): OutboxHandler {
  const notifications = createNotificationDispatcher({
    config: context.config,
    email: deps.email,
    whatsapp: deps.whatsapp,
    db: context.db,
  });
  const revalidate = createRevalidator(context.config);

  return async (event) => {
    /*
     * Automations see every event, before the built-in reactions: enrollment
     * starts new runs, and delivery wakes runs paused on a wait_for_event.
     * Both are idempotent (dedupe key, claim-on-wake), so the outbox's
     * at-least-once delivery is safe to point straight at them.
     */
    await engine.enrollFromEvent(event);
    await engine.resumeWaitingForEvent(event);

    switch (event.name) {
      case 'lead.created':
        await notifications.handleLeadCreated(
          event.workspaceId,
          event.payload as unknown as LeadCreatedPayload,
        );
        return;

      case 'content.published': {
        /*
         * Expire the page's cache tag on the site, and submit the URL for
         * indexing if the deployment is indexable.
         *
         * Done through the outbox rather than inline in the publish handler so
         * it inherits the retry: a site that is redeploying when somebody
         * publishes does not end up serving the previous version until the
         * cache window closes.
         */
        const payload = event.payload as {
          path?: string;
          paths?: string[];
          locale?: string;
        };
        const paths = payload.paths ?? (payload.path ? [payload.path] : []);
        if (paths.length > 0) {
          await revalidate({ paths, locale: payload.locale ?? 'en' });
        }
        return;
      }

      default:
        /*
         * Acknowledged rather than retried. An event nobody handles is a gap
         * in the code, not a transient failure, and retrying it eight times
         * helps nobody — it just delays the events behind it.
         */
        return;
    }
  };
}

export function registerInternalRoutes(
  app: FastifyInstance,
  context: AppContext,
  deps: InternalRouteDependencies,
): void {
  const { db, config, resolveWorkspaceId } = context;
  const engine = buildAutomationEngine(context, deps);
  const outboxHandler = createOutboxHandler(context, deps, engine);

  /* --------------------------------------------------------------- ingest */

  app.post(
    '/v1/internal/ingest',
    { config: { bosAccess: internalRoute() } },
    async (request, reply) => {
      const body = ingestBody.parse(request.body);
      const workspaceId = await resolveWorkspaceId(body.workspace);

      if (body.kind === 'analytics.batch') {
        const events = body.events ?? [];
        if (events.length === 0) return reply.status(202).send({ accepted: 0 });

        /*
         * Re-derive the visitor pseudonym here rather than trusting the one
         * the Worker computed. The Worker holds a secret and is trusted, but
         * the pseudonym is the privacy guarantee — deriving it once, at the
         * only place that holds the long-lived secret, means rotating that
         * secret rotates every pseudonym.
         */
        const day = new Date().toISOString().slice(0, 10);

        const accepted = await withWorkspace(db, workspaceId, async (tx) => {
          let count = 0;

          for (const event of events) {
            const pseudonym = event.visitorHash
              ? visitorPseudonym(
                  config.ANALYTICS_HASH_SECRET,
                  workspaceId,
                  event.visitorHash,
                  '',
                  day,
                )
              : visitorPseudonym(config.ANALYTICS_HASH_SECRET, workspaceId, 'unknown', '', day);

            const [session] = await tx
              .insert(schema.analyticsSessions)
              .values({
                workspaceId,
                visitorHash: pseudonym,
                landingPath: event.path,
                ...(event.referrer ? { referrer: event.referrer } : {}),
                channel: channelFor(event.referrer, event.utm.medium),
                ...(event.utm.source ? { utmSource: event.utm.source } : {}),
                ...(event.utm.medium ? { utmMedium: event.utm.medium } : {}),
                ...(event.utm.campaign ? { utmCampaign: event.utm.campaign } : {}),
                ...(event.utm.term ? { utmTerm: event.utm.term } : {}),
                ...(event.utm.content ? { utmContent: event.utm.content } : {}),
                ...(event.country ? { country: event.country } : {}),
                pageViewCount: 1,
              })
              .returning({ id: schema.analyticsSessions.id });

            await tx.insert(schema.analyticsEvents).values({
              workspaceId,
              sessionId: session?.id ?? null,
              name: event.name,
              path: event.path,
              properties: stripSensitiveProperties(event.properties),
              ...(event.occurredAt ? { occurredAt: new Date(event.occurredAt) } : {}),
            });

            count += 1;
          }

          return count;
        });

        return reply.status(202).send({ accepted });
      }

      /*
       * A webhook. Stored raw before anything parses it, so a signature
       * mismatch or a malformed body is diagnosable afterwards rather than
       * vanishing into a log line.
       */
      await withoutTenantScope(db, (tx) =>
        tx
          .insert(schema.webhookDeliveries)
          .values({
            workspaceId,
            source: body.source ?? 'unknown',
            signatureValid: true,
            body: safeJson(body.body ?? ''),
          })
          .onConflictDoNothing(),
      );

      return reply.status(202).send({ accepted: 1 });
    },
  );

  /* ----------------------------------------------------------------- jobs */

  /**
   * The outbox dispatcher, triggered by the Worker's cron.
   *
   * Also reachable manually, which matters during an incident: after fixing a
   * provider outage, a single POST drains everything that backed up.
   */
  app.post(
    '/v1/internal/jobs/outbox.dispatch',
    { config: { bosAccess: internalRoute() } },
    async () => dispatchOutbox(db, outboxHandler),
  );

  /**
   * Wake automation runs whose sleep, retry backoff or wait-timeout is due.
   *
   * The in-process dispatcher does this every few seconds; the cron calls it
   * too as the backstop that still runs when every instance's loop has died.
   */
  app.post(
    '/v1/internal/jobs/automations.resume',
    { config: { bosAccess: internalRoute() } },
    async () => {
      const resumed = await engine.resumeDueRuns();
      return { resumed };
    },
  );

  app.post(
    '/v1/internal/jobs/analytics.rollup',
    { config: { bosAccess: internalRoute() } },
    async () => {
      /*
       * Rebuild yesterday's daily rollups from raw events.
       *
       * Idempotent by construction — it deletes and rewrites the day rather
       * than incrementing — so a cron that fires twice, or a manual backfill,
       * produces the same numbers rather than doubled ones.
       */
      const rebuilt = await withoutTenantScope(db, async (tx) => {
        const result = await tx.execute<{ workspace_id: string }>(sql`
          with bounds as (
            select
              (current_date - interval '1 day')::date as day_start,
              (current_date)::date                    as day_end
          ),
          rolled as (
            select
              e.workspace_id,
              (select day_start from bounds)                            as date,
              -- Two dimensions per day: an overall row and one per landing
              -- path. The overall row is what the dashboard reads; the
              -- per-path rows are what "which pages convert" needs.
              'total'::varchar                                          as dimension,
              ''::varchar                                               as dimension_value,
              count(*) filter (where e.name = 'page_view')::int          as page_views,
              count(distinct e.session_id)::int                          as sessions,
              count(*) filter (where e.name = 'form_submit')::int        as conversions
            from analytics_events e
            where e.occurred_at >= (select day_start from bounds)
              and e.occurred_at <  (select day_end   from bounds)
            group by e.workspace_id

            union all

            select
              e.workspace_id,
              (select day_start from bounds),
              'landing_path'::varchar,
              left(e.path, 512)::varchar,
              count(*) filter (where e.name = 'page_view')::int,
              count(distinct e.session_id)::int,
              count(*) filter (where e.name = 'form_submit')::int
            from analytics_events e
            where e.occurred_at >= (select day_start from bounds)
              and e.occurred_at <  (select day_end   from bounds)
            group by e.workspace_id, left(e.path, 512)
          )
          insert into analytics_daily
            (workspace_id, date, dimension, dimension_value, page_views, sessions, conversions)
          select
            workspace_id, date, dimension, dimension_value, page_views, sessions, conversions
          from rolled
          -- Overwrite rather than increment, which is what makes a second run
          -- (a retried cron, a manual backfill) produce the same numbers
          -- rather than doubled ones.
          on conflict (workspace_id, date, dimension, dimension_value)
          do update set
            page_views  = excluded.page_views,
            sessions    = excluded.sessions,
            conversions = excluded.conversions,
            updated_at  = now()
          returning workspace_id
        `);
        return result.rows.length;
      }).catch((error: unknown) => {
        // Reported rather than thrown: a rollup failure must not stop the
        // retention sweep from running for another night.
        app.log.error({ err: error }, 'Analytics rollup failed');
        return -1;
      });

      return { workspacesRolledUp: rebuilt };
    },
  );

  app.post(
    '/v1/internal/jobs/documents.retention_sweep',
    { config: { bosAccess: internalRoute() } },
    async () => {
      const swept = await sweepExpiredDocuments(context);
      // Documents whose scan errored are owed a verdict; the sweep is where
      // that debt is paid off, before anything expires around them.
      const rescan = await rescanPendingDocuments(context);
      const pruned = await pruneOutbox(db);
      return { ...swept, rescan, outboxRowsPruned: pruned };
    },
  );

  app.post(
    '/v1/internal/jobs/seo.audit_refresh',
    { config: { bosAccess: internalRoute() } },
    async () => {
      /*
       * Publishes any content whose scheduled time has arrived.
       *
       * A scheduled page is invisible to the public API until `published_at`
       * passes — that predicate is what actually gates it — so this job only
       * needs to move the status, and being late costs nothing.
       */
      const published = await withoutTenantScope(db, async (tx) => {
        const rows = await tx
          .update(schema.contentEntries)
          .set({ status: 'published' })
          .where(
            and(
              eq(schema.contentEntries.status, 'scheduled'),
              sql`${schema.contentEntries.publishedAt} <= now()`,
            ),
          )
          .returning({ id: schema.contentEntries.id, path: schema.contentEntries.path });
        return rows;
      });

      return { scheduledPagesPublished: published.length, paths: published.map((row) => row.path) };
    },
  );

  /** Requeue everything a workspace has in the dead-letter state. */
  app.post(
    '/v1/internal/jobs/outbox.requeue',
    { config: { bosAccess: internalRoute() } },
    async (request) => {
      const body = z
        .object({ workspace: z.string().max(140).optional() })
        .parse(request.body ?? {});
      const workspaceId = body.workspace ? await resolveWorkspaceId(body.workspace) : undefined;

      const { requeueDeadEvents } = await import('../lib/outbox.ts');
      const requeued = await requeueDeadEvents(db, workspaceId);
      return { requeued };
    },
  );
}

/**
 * Resolve a traffic channel from the referrer and the UTM medium.
 *
 * Deliberately coarse. The distinction that earns its keep is organic search
 * versus an AI assistant versus paid versus direct; splitting "social" into
 * eleven networks is a report nobody reads.
 */
function channelFor(referrer: string | undefined, utmMedium: string | undefined): string {
  if (utmMedium) {
    const medium = utmMedium.toLowerCase();
    if (['cpc', 'ppc', 'paid', 'paidsearch'].includes(medium)) return 'paid_search';
    if (['email', 'newsletter'].includes(medium)) return 'email';
    if (['social', 'social-paid', 'paid-social'].includes(medium)) return 'social';
    if (medium === 'referral') return 'referral';
  }

  if (!referrer) return 'direct';

  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return 'direct';
  }

  if (
    /(^|\.)(chatgpt\.com|chat\.openai\.com|perplexity\.ai|claude\.ai|copilot\.microsoft\.com|gemini\.google\.com)$/.test(
      host,
    )
  ) {
    return 'ai_assistant';
  }
  if (/(^|\.)(google\.|bing\.|duckduckgo\.|yahoo\.|yandex\.|baidu\.)/.test(host)) {
    return 'organic_search';
  }
  if (
    /(^|\.)(facebook\.com|instagram\.com|x\.com|twitter\.com|linkedin\.com|youtube\.com|t\.co|tiktok\.com)$/.test(
      host,
    )
  ) {
    return 'social';
  }

  return 'referral';
}

/** Store a webhook body as JSON when it parses, and as a wrapped string when it does not. */
function safeJson(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { raw: raw.slice(0, 100_000) };
  }
}

/** Re-exported so a test can assert the filter without booting the app. */
export const __testing = { stripSensitiveProperties, channelFor, ApiError };
