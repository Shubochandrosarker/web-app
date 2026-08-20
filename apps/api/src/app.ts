import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabase, type Database } from '@bos/database';
import { MODULE_REGISTRY, type ModuleId } from '@bos/business-types';
import type { ApiConfig } from './lib/env.ts';
import { registerErrorHandler } from './lib/errors.ts';
import { registerContentRoutes } from './routes/content.ts';

/**
 * The API is a set of modules, not a set of routes.
 *
 * A module registers its routes only when the workspace has it enabled, so a
 * client without scheduling has no scheduling endpoints at all — not endpoints
 * that return 403. Smaller surface, and no route can be reached by a tenant
 * that never bought the capability.
 *
 * Phase 1 registers the content module. Each remaining module arrives with its
 * own task; see docs/tasks/.
 */
type ModuleRegistrar = (app: FastifyInstance, db: Database) => void;

const MODULE_ROUTES: Partial<Record<ModuleId, ModuleRegistrar>> = {
  'marketing.cms': registerContentRoutes,
};

export interface BuildAppOptions {
  readonly config: ApiConfig;
  /**
   * Modules to mount. In production this comes from the workspace record; it
   * is a parameter so tests can mount exactly one module.
   */
  readonly enabledModules?: readonly ModuleId[];
  readonly database?: Database;
}

export function buildApp({ config, enabledModules, database }: BuildAppOptions): {
  app: FastifyInstance;
  db: Database;
} {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Never log credentials, even at trace. Redaction belongs in the logger
      // config rather than in every call site that might log a request.
      redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
    },
    trustProxy: true,
    bodyLimit: 1_048_576,
    disableRequestLogging: config.NODE_ENV === 'production',
  });

  const db =
    database ??
    createDatabase({
      connectionString: config.DATABASE_URL,
      maxConnections: config.DATABASE_POOL_MAX,
      ssl: config.NODE_ENV === 'production',
    });

  registerErrorHandler(app);

  /** Liveness only — deliberately does not touch the database. */
  app.get('/health', async () => ({ status: 'ok' }));

  /**
   * Readiness. Checks the database, because a process that cannot reach
   * Postgres should be taken out of the load balancer rather than serving
   * 500s. Separate from /health so a slow database does not trigger a restart
   * loop.
   */
  app.get('/ready', async (_request, reply) => {
    try {
      await db.execute('select 1');
      return { status: 'ready' };
    } catch (error) {
      app.log.error({ err: error }, 'Readiness check failed');
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  const modules = enabledModules ?? (Object.keys(MODULE_ROUTES) as ModuleId[]);
  for (const moduleId of modules) {
    const register = MODULE_ROUTES[moduleId];
    if (!register) continue;
    register(app, db);
    app.log.info({ module: moduleId, label: MODULE_REGISTRY[moduleId].label }, 'Module mounted');
  }

  return { app, db };
}
