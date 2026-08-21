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
import { registerCrmRoutes } from './routes/crm.ts';
import { registerPublicFormRoutes } from './routes/forms-public.ts';
import { registerDocumentRoutes } from './routes/documents.ts';
import { createOutboxHandler, registerInternalRoutes } from './routes/internal.ts';
import { createEmailProvider, createWhatsappProvider } from './providers/notifications.ts';
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
}

export function buildApp({
  config,
  enabledModules,
  database,
  redis: redisOverride,
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
    trustProxy: true,
    bodyLimit: 1_048_576,
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
  const storage = createStorage(config, app.log);
  const leads = createLeadService({ db, redis, config });

  const context: AppContext = { config, db, redis, auth, resolveWorkspaceId, leads, storage };

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

      // Reported but not fatal: a backed-up outbox means messages are late,
      // not that this instance should be taken out of rotation.
      const outbox = await outboxHealth(db).catch(() => null);

      return reply.status(200).send({
        status: 'ready',
        checks,
        ...(outbox ? { outbox } : {}),
      });
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
        turnstileSiteKey: undefined,
        resolveWorkspaceId: ctx.resolveWorkspaceId,
      });
      registerCmsRoutes(instance, ctx);
    },
    'marketing.forms': (instance, ctx) => registerPublicFormRoutes(instance, ctx),
    'crm.leads': (instance, ctx) => registerCrmRoutes(instance, ctx),
    'ops.documents': (instance, ctx) => registerDocumentRoutes(instance, ctx),
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
  const internalDependencies = { email, whatsapp };
  registerInternalRoutes(app, context, internalDependencies);

  /*
   * The in-process dispatcher shares one handler definition with the cron
   * endpoint, so a confirmation email behaves identically whether it was sent
   * five seconds after the form was submitted or by the nightly sweep.
   */
  const dispatcher = createDispatcher({
    db,
    redis,
    logger: app.log,
    handler: createOutboxHandler(context, internalDependencies),
  });

  /*
   * The guard that makes "forgot to add auth" impossible.
   *
   * Collected as routes register and asserted in `onReady`, which runs after
   * every plugin has finished and before the server accepts a connection — so
   * an unclassified route is a failed boot in CI, not a public endpoint in
   * production.
   */
  const routes: RouteOptions[] = [];
  app.addHook('onRoute', (route) => {
    routes.push(route);
  });
  app.addHook('onReady', async () => {
    assertEveryRouteIsClassified(routes);
    app.log.info({ routes: routes.length }, 'Every route declares how it is protected');
  });

  for (const warning of warnings) app.log.warn({ warning }, 'Configuration warning');

  return { app, db, redis, context, warnings, dispatcher };
}
