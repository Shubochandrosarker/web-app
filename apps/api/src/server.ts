import { closeDatabase } from '@bos/database';
import { buildApp } from './app.ts';
import { loadApiConfig } from './lib/env.ts';
import { closeRedis } from './lib/redis.ts';

const config = loadApiConfig();
const { app, dispatcher } = buildApp({ config });

/**
 * Graceful shutdown.
 *
 * Without it, a deploy drops in-flight requests and leaves Postgres holding
 * connections until they time out. The order matters: stop accepting new
 * requests, let the in-flight ones finish, then release the pools.
 */
let shuttingDown = false;

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    // A second signal during shutdown is an operator losing patience, not a
    // reason to run the teardown twice.
    if (shuttingDown) return;
    shuttingDown = true;

    app.log.info({ signal }, 'Shutting down');
    dispatcher.stop();
    void app
      .close()
      .then(() => Promise.allSettled([closeDatabase(), closeRedis()]))
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        app.log.error({ err: error }, 'Shutdown failed');
        process.exit(1);
      });
  });
}

/**
 * An unhandled rejection leaves the process in an unknown state. Logging and
 * continuing means serving requests from a process that has already failed
 * once in a way nobody understood.
 */
process.on('unhandledRejection', (reason) => {
  app.log.fatal({ err: reason }, 'Unhandled promise rejection — exiting');
  process.exit(1);
});

try {
  /*
   * `0.0.0.0`, not `localhost`.
   *
   * A managed host routes to the container's external interface; binding to
   * the loopback address is the other classic reason a working build serves
   * nothing. The port comes from PORT when the host set one — see
   * `resolvePort`.
   */
  await app.listen({ port: config.port, host: '0.0.0.0' });

  /*
   * Started after `listen` succeeds. Draining the outbox from a process that
   * then fails to bind its port would mean sending confirmations from an
   * instance nobody can reach — and, worse, doing it twice if a supervisor
   * restarts it.
   */
  dispatcher.start();
} catch (error) {
  app.log.error({ err: error }, 'Failed to start');
  process.exit(1);
}
