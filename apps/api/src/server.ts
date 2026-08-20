import { closeDatabase } from '@bos/database';
import { buildApp } from './app.ts';
import { loadApiConfig } from './lib/env.ts';

const config = loadApiConfig();
const { app } = buildApp({ config });

/**
 * Graceful shutdown. Without it, a deploy drops in-flight requests and leaves
 * Postgres holding connections until they time out.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'Shutting down');
    void app
      .close()
      .then(() => closeDatabase())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        app.log.error({ err: error }, 'Shutdown failed');
        process.exit(1);
      });
  });
}

try {
  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
} catch (error) {
  app.log.error({ err: error }, 'Failed to start');
  process.exit(1);
}
