import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { createDatabase, type Database } from '@bos/database';
import { MODULE_REGISTRY, type ModuleId } from '@bos/business-types';
import type { ApiConfig } from './lib/env.ts';
import { assertProductionSafe } from './lib/env.ts';
import { registerErrorHandler } from './lib/errors.ts';
import { createRedis, type RedisClient } from './lib/redis.ts';
import { assertEveryRouteIsClassified, registerContext } from './lib/context.ts';
import { publicRoute } from './lib/permissions.ts';
import { outboxHealth } from './lib/outbox.ts';
import { AuthService } from './auth/service.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { registerPublicContentRoutes } from './routes/content-public.ts';
import { registerCmsRoutes } from './routes/cms.ts';
import { registerCmsReferenceRoutes } from './routes/cms-references.ts';
import { registerCrmRoutes } from './routes/crm.ts';
import { registerPublicFormRoutes } from './routes/forms-public.ts';
import { registerFormAdminRoutes } from './routes/forms-admin.ts';
import { registerCommunicationRoutes } from './routes/communications.ts';
import { registerAutomationRoutes } from './routes/automations.ts';
import { registerAnalyticsRoutes } from './routes/analytics.ts';
import { registerSeoRoutes } from './routes/seo.ts';
import { registerWhatsappWebhookRoutes } from './routes/webhooks-whatsapp.ts';
import { registerMediaRoutes } from './routes/media.ts';
import { registerDocumentRoutes } from './routes/documents.ts';
import { registerServicesRoutes } from './routes/services.ts';
import { registerLocationRoutes } from './routes/locations.ts';
import { registerAppointmentRoutes } from './routes/appointments.ts';
import { registerReviewRoutes } from './routes/reviews.ts';
import {
  buildAutomationEngine,
  createOutboxHandler,
  registerInternalRoutes,
} from './routes/internal.ts';
import {
  createEmailProvider,
  createWhatsappProvider,
  type WhatsappProvider,
} from './providers/notifications.ts';
import { createScanner, type DocumentScanner } from './providers/scanner.ts';
import { createStorage } from './providers/storage.ts';
import { createDispatcher, type Dispatcher } from './services/dispatcher.ts';
import { createLeadService } from './services/leads.ts';
import { createNotificationDispatcher } from './services/notifications.ts';

/**
 * The API is a set of modules, not a set of routes.
 *
 * A module registers its routes only when the workspace has it enabled, so a
 * client without scheduling has no scheduling endpoints at all — not endpoints
 * that return 403. Smaller surface, and no route can be reached by a tenant
 * that never bought the capability.
 *
 * Two things are *not* modules and are always mounted: authentication (a
 * workspace that cannot log in cannot enable anything) and the health probes.
 */
type ModuleRegistrar = (app: FastifyInstance, context: AppContext) => void;

export interface AppContext {
  readonly config: ApiConfig;
  readonly db: Database;
  readonly redis: RedisClient;
  readonly auth: AuthService;
  readonly resolveWorkspaceId: (slug: string) => Promise<string>;
  readonly leads: ReturnType<typeof createLeadService>;
  readonly storage: ReturnType<typeof createStorage>;
  readonly scanner: DocumentScanner;
  readonly whatsapp: WhatsappProvider;
}

export interface BuildAppOptions {
  readonly config: ApiConfig;
  /**
   * Modules to mount. In production this is the union of every active
   * workspace's modules; it is a parameter so a test can mount exactly one.
   */
  readonly enabledModules?: readonly ModuleId[];
  readonly database?: Database;
  readonly redis?: RedisClient;
  /** Test seam: an in-memory storage double for the document lifecycle. */
  readonly storage?: ReturnType<typeof createStorage>;
  /** Test seam: a deterministic scanner. */
  readonly scanner?: DocumentScanner;
}

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly db: Database;
  readonly redis: RedisClient;
  readonly context: AppContext;
  readonly warnings: readonly string[];
  /**
   * Drains the outbox every few seconds.
   *
   * Returned rather than started here so a test can build the app without a
   * background loop racing its assertions — `server.ts` starts it.
   */
  readonly dispatcher: Dispatcher;
  /**
   * How many routes the classification guard collected. Exposed so a test can
   * prove the guard is not vacuous — an empty collection passing the
   * assertion is precisely the failure mode this build fixed.
   */
  readonly classifiedRoutes: () => number;
}

export function buildApp({
  config,
  enabledModules,
  database,
  redis: redisOverride,
  storage: storageOverride,
  scanner: scannerOverride,
}: BuildAppOptions): BuiltApp {
  const warnings = assertProductionSafe(config);

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Never log credentials, even at trace. Redaction belongs in the logger
      // config rather than in every call site that might log a request.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-bos-edge-secret"]',
          'res.headers["set-cookie"]',
          '*.password',
          '*.newPassword',
          '*.currentPassword',
          '*.token',
          '*.accessToken',
          '*.refreshToken',
          '*.challengeToken',
          '*.secret',
          '*.mfaSecret',
          '*.passwordHash',
        ],
        censor: '[redacted]',
      },
    },
    /**
     * One id per request, echoed in every log line and in every error body.
     * A user reporting "it failed" with an id turns an unreproducible bug into
     * a log query.
     */
    genReqId: (request) => {
      const upstream = request.headers['x-request-id'];
      return typeof upstream === 'string' && upstream.length <= 200 ? upstream : randomUUID();
    },
    requestIdHeader: 'x-request-id',
    trustProxy: resolveTrustProxy(config.API_TRUST_PROXY),
    bodyLimit: 1_048_576,
  });

  /*
   * The guard that makes "forgot to add auth" impossible.
   *
   * The collector MUST be installed before any route registers: Fastify's
   * `onRoute` fires only for routes added after the hook exists, so a
   * collector added at the end of this function would see none of the routes
   * above it and the boot assertion would pass against an empty list — which
   * is exactly what it did, silently, until a test registered an unclassified
   * route and the boot succeeded. The runtime fail-closed check in
   * `registerContext` was the only thing standing behind it.
   *
   * Asserted in `onReady`, which runs after every plugin has finished and
   * before the server accepts a connection — so an unclassified route is a
   * failed boot in CI, not a public endpoint in production.
   */
  const routes: RouteOptions[] = [];
  app.addHook('onRoute', (route) => {
    routes.push(route);
  });
  app.addHook('onReady', async () => {
    assertEveryRouteIsClassified(routes);
    if (routes.length === 0) {
      // A guard that guards nothing is worse than no guard: it reads as
      // assurance. Zero collected routes means the collector was installed
      // too late or the hook API changed underneath it.
      throw new Error('The route-classification guard collected zero routes. It is not wired.');
    }
    app.log.info({ routes: routes.length }, 'Every route declares how it is protected');
  });

  const db =
    database ??
    createDatabase({
      connectionString: config.DATABASE_URL,
      maxConnections: config.DATABASE_POOL_MAX,
      ssl: config.databaseSsl,
    });

  const redis = redisOverride ?? createRedis(config.REDIS_URL);

  registerErrorHandler(app);

  // Echo the request id so a client can quote it, and so a Cloudflare trace
  // and an application log can be lined up after the fact.
  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', String(request.id));
  });

  void app.register(helmet, {
    // The API serves JSON to two known origins. There is no document to apply
    // a script policy to, so the useful headers here are the transport and
    // framing ones — a CSP on a JSON response is decoration.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts:
      config.NODE_ENV === 'production' ? { maxAge: 63_072_000, includeSubDomains: true } : false,
  });

  void app.register(cors, {
    /**
     * An explicit allow-list, and `credentials: true` requires it: the two
     * together are what let the dashboard send its session cookie, and a
     * wildcard origin with credentials is both rejected by browsers and a
     * CSRF hole if it were not.
     */
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      callback(null, config.allowedOrigins.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-bos-workspace', 'x-request-id'],
    maxAge: 86_400,
  });

  void app.register(cookie, { secret: config.AUTH_SESSION_SECRET });

  void app.register(multipart, {
    limits: {
      // A transcript scan is measured in megabytes, not tens of them. The cap
      // is the first line of defence against an upload endpoint being used as
      // free storage.
      fileSize: 20 * 1024 * 1024,
      files: 5,
      fields: 40,
    },
  });

  const auth = new AuthService(db, redis, {
    accessTokenTtl: config.AUTH_ACCESS_TOKEN_TTL,
    refreshTokenTtl: config.AUTH_REFRESH_TOKEN_TTL,
    mfaIssuer: config.AUTH_MFA_ISSUER,
    sessionSecret: config.AUTH_SESSION_SECRET,
  });

  registerContext(app, {
    db,
    redis,
    auth,
    edgeSharedSecret: config.EDGE_SHARED_SECRET,
  });

  const resolveWorkspaceId = (slug: string): Promise<string> =>
    (app as unknown as { resolveWorkspaceId: (s: string) => Promise<string> }).resolveWorkspaceId(
      slug,
    );

  const email = createEmailProvider(config, app.log);
  const whatsapp = createWhatsappProvider(config, app.log);
  const storage = storageOverride ?? createStorage(config, app.log);
  const scanner = scannerOverride ?? createScanner(config, app.log);
  const leads = createLeadService({ db, redis, config });

  const context: AppContext = {
    config,
    db,
    redis,
    auth,
    resolveWorkspaceId,
    leads,
    storage,
    scanner,
    whatsapp,
  };

  /* ------------------------------------------------------------- probes */

  /**
   * Liveness. Deliberately does not touch the database or Redis.
   *
   * The question `/health` answers is "should this process be restarted?", and
   * the answer is no just because Postgres is briefly unreachable — restarting
   * every instance during a database blip is how a small outage becomes a
   * large one.
   */
  app.get(
    '/health',
    { config: { bosAccess: publicRoute('Process liveness. Touches no dependency.') } },
    async () => ({ status: 'ok' }),
  );

  /**
   * Readiness. Answers "should this instance receive traffic?", which is a
   * different question — so it does check the dependencies a request needs.
   */
  app.get(
    '/ready',
    { config: { bosAccess: publicRoute('Dependency readiness for the load balancer.') } },
    async (_request, reply) => {
      const checks: Record<string, 'ok' | 'failed'> = {};

      const [dbResult, redisResult] = await Promise.allSettled([
        db.execute('select 1'),
        redis.ping(),
      ]);
      checks.database = dbResult.status === 'fulfilled' ? 'ok' : 'failed';
      checks.redis = redisResult.status === 'fulfilled' ? 'ok' : 'failed';

      if (Object.values(checks).some((value) => value === 'failed')) {
        app.log.error({ checks }, 'Readiness check failed');
        return reply.status(503).send({ status: 'unavailable', checks });
      }

      /*
       * Reported but not fatal: a backed-up outbox means messages are late,
       * not that this instance should be taken out of rotation.
       *
       * It says `unavailable` rather than dropping the key, and logs. Omitting
       * it made a permanently broken check look exactly like a healthy one —
       * the query had a syntax error and threw on every call, so this endpoint
       * had never once reported an outbox depth, and nothing said so. A
       * dead-letter queue nobody can see is the failure this check exists to
       * prevent.
       */
      const outbox = await outboxHealth(db).catch((error: unknown) => {
        app.log.error({ err: error }, 'Outbox health check failed');
        return 'unavailable' as const;
      });

      return reply.status(200).send({ status: 'ready', checks, outbox });
    },
  );

  /* ------------------------------------------------------------- modules */

  registerAuthRoutes(app, {
    auth,
    redis,
    cookieDomain: config.AUTH_COOKIE_DOMAIN,
    isProduction: config.NODE_ENV === 'production',
    accessTokenTtl: config.AUTH_ACCESS_TOKEN_TTL,
    refreshTokenTtl: config.AUTH_REFRESH_TOKEN_TTL,
    sendAuthEmail: createNotificationDispatcher({ config, email, whatsapp, db }).sendAuthEmail,
  });

  const MODULE_ROUTES: Partial<Record<ModuleId, ModuleRegistrar>> = {
    'marketing.cms': (instance, ctx) => {
      registerPublicContentRoutes(instance, ctx.db, {
        publicMediaBaseUrl: ctx.config.storage?.R2_PUBLIC_BASE_URL,
        // The site key is public by design — it ships in the page — but it is
        // the API's configuration that decides it, so the widget the site
        // renders and the verification this API performs cannot drift apart.
        turnstileSiteKey: ctx.config.TURNSTILE_SITE_KEY,
        resolveWorkspaceId: ctx.resolveWorkspaceId,
      });
      registerCmsRoutes(instance, ctx);
      registerCmsReferenceRoutes(instance, ctx);
      registerMediaRoutes(instance, ctx);
    },
    'marketing.forms': (instance, ctx) => {
      registerPublicFormRoutes(instance, ctx);
      registerFormAdminRoutes(instance, ctx);
    },
    'crm.leads': (instance, ctx) => {
      registerCrmRoutes(instance, ctx);
      registerCommunicationRoutes(instance, ctx);
    },
    'ops.documents': (instance, ctx) => registerDocumentRoutes(instance, ctx),
    'ops.services': (instance, ctx) => registerServicesRoutes(instance, ctx),
    'ops.scheduling': (instance, ctx) => registerAppointmentRoutes(instance, ctx),
    'reputation.local_seo': (instance, ctx) => registerLocationRoutes(instance, ctx),
    'reputation.reviews': (instance, ctx) => registerReviewRoutes(instance, ctx),
    'analytics.traffic': (instance, ctx) => registerAnalyticsRoutes(instance, ctx),
    'marketing.seo': (instance, ctx) => registerSeoRoutes(instance, ctx),
    'ops.workflows': (instance, ctx) =>
      registerAutomationRoutes(instance, ctx, {
        engine: buildAutomationEngine(ctx, { email, whatsapp, logger: app.log }),
      }),
  };

  const modules = enabledModules ?? (Object.keys(MODULE_ROUTES) as ModuleId[]);
  for (const moduleId of modules) {
    const register = MODULE_ROUTES[moduleId];
    if (!register) continue;
    register(app, context);
    app.log.info({ module: moduleId, label: MODULE_REGISTRY[moduleId].label }, 'Module mounted');
  }

  // Always mounted: the edge Worker's callbacks are infrastructure, not a
  // tenant capability, and a Worker whose ingest endpoint is missing retries
  // until its messages reach the dead-letter queue.
  const internalDependencies = { email, whatsapp, logger: app.log };
  registerInternalRoutes(app, context, internalDependencies);

  // The WhatsApp webhook is infrastructure, like the internal routes: Meta
  // must be able to reach it whether or not any module is mounted.
  registerWhatsappWebhookRoutes(app, context);

  /*
   * The in-process dispatcher shares one handler definition with the cron
   * endpoint, so a confirmation email behaves identically whether it was sent
   * five seconds after the form was submitted or by the nightly sweep.
   */
  const automationEngine = buildAutomationEngine(context, internalDependencies);
  const dispatcher = createDispatcher({
    db,
    redis,
    logger: app.log,
    handler: createOutboxHandler(context, internalDependencies, automationEngine),
    resumeAutomations: () => automationEngine.resumeDueRuns(),
  });

  for (const warning of warnings) app.log.warn({ warning }, 'Configuration warning');

  return { app, db, redis, context, warnings, dispatcher, classifiedRoutes: () => routes.length };
}

/**
 * Map the configured trust policy to Fastify's `trustProxy` value.
 *
 * `true` — trust any `X-Forwarded-For` — is only safe when the origin is
 * unreachable except through the proxy, which is an infrastructure guarantee
 * this process cannot verify. Anywhere the origin can be reached directly, a
 * spoofed header re-keys the rate limits and falsifies the audit trail. So
 * the trust is explicit:
 *
 *  - `none`      — trust nothing; `request.ip` is the socket peer.
 *  - `loopback`  — trust a reverse proxy on this host (the documented
 *                  Hostinger topology: nginx in front, API bound to
 *                  localhost). The default.
 *  - CSV of addresses/CIDRs — trust exactly those hops, e.g. a private LB.
 *
 * Hop counts are deliberately not supported: "trust N hops" trusts whatever
 * happens to be N hops out, which is a topology assumption nobody re-checks
 * when the topology changes. Name the proxies instead.
 */
export function resolveTrustProxy(setting: string | undefined): boolean | string[] {
  const value = (setting ?? 'loopback').trim();
  if (value === 'none' || value === 'false') return false;
  if (value === 'loopback') return ['127.0.0.1', '::1'];
  if (value === 'all' || value === 'true') return true;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
