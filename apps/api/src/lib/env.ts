import {
  apiEnvSchema,
  cacheEnvSchema,
  databaseEnvSchema,
  emailEnvSchema,
  loadEnv,
  resolvePort,
  runtimeEnvSchema,
  storageEnvSchema,
  whatsappEnvSchema,
  type ApiEnv,
  type CacheEnv,
  type DatabaseEnv,
  type EmailEnv,
  type RuntimeEnv,
  type StorageEnv,
  type WhatsappEnv,
} from '@bos/config';

/**
 * Validated once, at boot. If anything is missing the process exits before it
 * ever accepts a request — a misconfigured deploy should fail loudly at start,
 * not as a 500 three days later on an untested code path.
 *
 * Storage is optional in the type because a deployment with document upload
 * switched off has no R2 credentials to give, and demanding them would make
 * the simplest possible install impossible.
 */
export type ApiConfig = RuntimeEnv &
  DatabaseEnv &
  ApiEnv &
  CacheEnv &
  EmailEnv &
  WhatsappEnv & {
    readonly storage: StorageEnv | undefined;
    /** The port to bind: PORT when the host set one, API_PORT otherwise. */
    readonly port: number;
    readonly allowedOrigins: readonly string[];
    /** Resolved TLS mode: the explicit setting, or the default for this NODE_ENV. */
    readonly databaseSsl: 'disable' | 'require' | 'verify-full';
  };

export function loadApiConfig(source: NodeJS.ProcessEnv = process.env): ApiConfig {
  const runtime = loadEnv(runtimeEnvSchema, source, 'api:runtime');
  const database = loadEnv(databaseEnvSchema, source, 'api:database');
  const http = loadEnv(apiEnvSchema, source, 'api:http');
  const cache = loadEnv(cacheEnvSchema, source, 'api:cache');
  const email = loadEnv(emailEnvSchema, source, 'api:email');
  const whatsapp = loadEnv(whatsappEnvSchema, source, 'api:whatsapp');

  /*
   * Storage is validated only when it is configured at all. Half-configured is
   * the dangerous state — three of six R2 variables set means somebody meant
   * to enable uploads — so any one of them present makes all of them required.
   */
  const storageKeys = [
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_PUBLIC_BUCKET',
    'R2_PRIVATE_BUCKET',
    'R2_PUBLIC_BASE_URL',
  ] as const;
  const storageConfigured = storageKeys.some((key) => (source[key] ?? '').length > 0);
  const storage = storageConfigured ? loadEnv(storageEnvSchema, source, 'api:storage') : undefined;

  const allowedOrigins = http.API_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  /*
   * TLS defaults to on in production and off elsewhere, because a local
   * Postgres does not speak it and requiring it would mean every developer
   * setting the same override. Production is the case that must not depend on
   * anybody remembering.
   */
  const databaseSsl =
    database.DATABASE_SSL ?? (runtime.NODE_ENV === 'production' ? 'verify-full' : 'disable');

  return {
    ...runtime,
    ...database,
    ...http,
    ...cache,
    ...email,
    ...whatsapp,
    storage,
    port: resolvePort(http, http.API_PORT),
    allowedOrigins,
    databaseSsl,
  };
}

/**
 * Configuration that would be a mistake in production but is convenient in
 * development. Surfaced at boot as warnings rather than silently tolerated,
 * and as a hard failure when NODE_ENV is production.
 */
export function assertProductionSafe(config: ApiConfig): readonly string[] {
  const problems: string[] = [];

  if (config.EMAIL_PROVIDER === 'log') {
    problems.push('EMAIL_PROVIDER=log writes messages to the log instead of sending them.');
  }
  if (config.WHATSAPP_PROVIDER === 'log') {
    problems.push('WHATSAPP_PROVIDER=log writes messages to the log instead of sending them.');
  }
  if (!config.TURNSTILE_SECRET_KEY) {
    problems.push('TURNSTILE_SECRET_KEY is unset, so public forms have no CAPTCHA.');
  }
  if (config.allowedOrigins.length === 0) {
    problems.push('API_ALLOWED_ORIGINS is empty, so no browser origin may call the API.');
  }
  if (config.databaseSsl !== 'verify-full') {
    problems.push(`DATABASE_SSL=${config.databaseSsl} does not verify the database's certificate.`);
  }

  if (config.NODE_ENV === 'production' && problems.length > 0) {
    throw new Error(
      `Refusing to start in production with an unsafe configuration:\n${problems
        .map((problem) => `  - ${problem}`)
        .join('\n')}`,
    );
  }

  return problems;
}
