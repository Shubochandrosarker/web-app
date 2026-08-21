import { z } from 'zod';

/**
 * Environment contract.
 *
 * Every process validates the slice it needs at boot and crashes loudly if a
 * value is missing or malformed. The alternative — reading `process.env.X`
 * inline — turns a misconfigured deploy into a 500 three days later on the one
 * code path nobody exercised.
 *
 * Slices are separate schemas because the public site must not require the
 * database URL, and the Worker must not require SMTP credentials.
 */

const nodeEnv = z.enum(['development', 'test', 'production']).default('development');
const logLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info');

/**
 * A managed host (Hostinger, Render, Fly) tells the process which port to bind
 * by exporting PORT. It is optional because a local `pnpm dev` has no host to
 * be told by, and each app falls back to its own documented default.
 */
const hostPort = z.coerce.number().int().min(1).max(65535).optional();

export const runtimeEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
});

export const databaseEnvSchema = z.object({
  DATABASE_URL: z.string().startsWith('postgres', 'must be a postgres:// or postgresql:// URL'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /**
   * Managed Postgres almost always terminates TLS with a certificate chained
   * to a provider root the container does not carry, so verification is a
   * separate decision from "use TLS at all". Defaulting to on means the
   * insecure choice has to be written down.
   */
  DATABASE_SSL: z.enum(['disable', 'require', 'verify-full']).optional(),
});

export const cacheEnvSchema = z.object({
  REDIS_URL: z.string().startsWith('redis', 'must be a redis:// or rediss:// URL'),
});

/** 32 bytes of entropy, base64. Short secrets are a silent downgrade. */
const secret = (label: string) =>
  z.string().min(32, `${label} needs at least 32 characters of entropy`);

export const apiEnvSchema = z.object({
  /** Local default. Production reads PORT first — see `resolvePort`. */
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  PORT: hostPort,
  API_PUBLIC_URL: z.url(),
  /** Origins allowed to call the API with credentials. Comma-separated. */
  API_ALLOWED_ORIGINS: z.string().default(''),
  AUTH_SESSION_SECRET: secret('AUTH_SESSION_SECRET'),
  AUTH_ACCESS_TOKEN_TTL: z.coerce.number().int().min(60).default(900),
  AUTH_REFRESH_TOKEN_TTL: z.coerce.number().int().min(3600).default(2_592_000),
  /** Domain the session cookies are scoped to, e.g. `.nuesheba.com`. */
  AUTH_COOKIE_DOMAIN: z.string().optional(),
  /** Issuer shown in an authenticator app next to the TOTP code. */
  AUTH_MFA_ISSUER: z.string().min(1).default('Business OS'),
  /**
   * Shared secret the edge Worker signs its calls with. Required in
   * production: without it `/v1/internal/*` would be reachable by anyone who
   * guesses the path.
   */
  EDGE_SHARED_SECRET: secret('EDGE_SHARED_SECRET'),
  /** Salt for the analytics visitor HMAC. Rotated on the documented schedule. */
  ANALYTICS_HASH_SECRET: secret('ANALYTICS_HASH_SECRET'),
  /** Server-side Turnstile key. Absent disables the check — logged at boot. */
  TURNSTILE_SECRET_KEY: z.string().optional(),
  DASHBOARD_URL: z.url().optional(),
});

export const siteEnvSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z.url(),
  NEXT_PUBLIC_API_URL: z.url(),
  BOS_WORKSPACE_SLUG: z.string().min(1),
  /**
   * The launch switch. A preview build is a production build, so indexability
   * is keyed on an explicit variable rather than on NODE_ENV — the two are not
   * the same question, and getting them confused indexes staging.
   */
  BOS_ALLOW_INDEXING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  PORT: hostPort,
  /** Public site key for Turnstile. Safe to ship to the browser. */
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().optional(),
});

export const dashboardEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.url(),
  NEXT_PUBLIC_DASHBOARD_URL: z.url(),
  BOS_WORKSPACE_SLUG: z.string().min(1),
  PORT: hostPort,
});

export const contentEnvSchema = z
  .object({
    CONTENT_PROVIDER: z.enum(['internal', 'wordpress', 'markdown']).default('internal'),
    WORDPRESS_API_URL: z.url().optional(),
    WORDPRESS_APP_USER: z.string().optional(),
    WORDPRESS_APP_PASSWORD: z.string().optional(),
  })
  .refine((env) => env.CONTENT_PROVIDER !== 'wordpress' || Boolean(env.WORDPRESS_API_URL), {
    message: 'WORDPRESS_API_URL is required when CONTENT_PROVIDER=wordpress',
    path: ['WORDPRESS_API_URL'],
  });

export const storageEnvSchema = z.object({
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_PUBLIC_BUCKET: z.string().min(1),
  R2_PRIVATE_BUCKET: z.string().min(1),
  R2_PUBLIC_BASE_URL: z.url(),
  /** Seconds a signed document URL stays valid. Minutes, not hours. */
  R2_SIGNED_URL_TTL: z.coerce.number().int().min(30).max(3600).default(300),
});

export const emailEnvSchema = z
  .object({
    EMAIL_PROVIDER: z.enum(['resend', 'smtp', 'ses', 'log']).default('log'),
    EMAIL_FROM_ADDRESS: z.email(),
    EMAIL_FROM_NAME: z.string().min(1),
    RESEND_API_KEY: z.string().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
  })
  .refine((env) => env.EMAIL_PROVIDER !== 'resend' || Boolean(env.RESEND_API_KEY), {
    message: 'RESEND_API_KEY is required when EMAIL_PROVIDER=resend',
    path: ['RESEND_API_KEY'],
  })
  .refine((env) => env.EMAIL_PROVIDER !== 'smtp' || Boolean(env.SMTP_HOST), {
    message: 'SMTP_HOST is required when EMAIL_PROVIDER=smtp',
    path: ['SMTP_HOST'],
  });

export const whatsappEnvSchema = z
  .object({
    WHATSAPP_PROVIDER: z.enum(['meta_cloud', 'log']).default('log'),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
    WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  })
  .refine(
    (env) =>
      env.WHATSAPP_PROVIDER !== 'meta_cloud' ||
      (Boolean(env.WHATSAPP_PHONE_NUMBER_ID) && Boolean(env.WHATSAPP_ACCESS_TOKEN)),
    {
      message:
        'WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN are required when WHATSAPP_PROVIDER=meta_cloud',
      path: ['WHATSAPP_PHONE_NUMBER_ID'],
    },
  );

export const edgeEnvSchema = z.object({
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1),
  EDGE_SHARED_SECRET: secret('EDGE_SHARED_SECRET'),
});

export type RuntimeEnv = z.infer<typeof runtimeEnvSchema>;
export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;
export type CacheEnv = z.infer<typeof cacheEnvSchema>;
export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type SiteEnv = z.infer<typeof siteEnvSchema>;
export type DashboardEnv = z.infer<typeof dashboardEnvSchema>;
export type ContentEnv = z.infer<typeof contentEnvSchema>;
export type StorageEnv = z.infer<typeof storageEnvSchema>;
export type EmailEnv = z.infer<typeof emailEnvSchema>;
export type WhatsappEnv = z.infer<typeof whatsappEnvSchema>;
export type EdgeEnv = z.infer<typeof edgeEnvSchema>;

export class EnvValidationError extends Error {
  // Declared explicitly rather than as constructor parameter properties: these
  // packages ship as source and are loaded by Node's type-stripping mode,
  // which rejects parameter properties outright.
  readonly issues: readonly { path: string; message: string }[];

  constructor(issues: readonly { path: string; message: string }[], processName: string) {
    const detail = issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join('\n');
    super(`Invalid environment for "${processName}":\n${detail}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * Validate a slice of the environment or throw. Call once, at process start,
 * and pass the result down — do not re-read `process.env` deeper in the stack.
 */
export function loadEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined>,
  processName: string,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
      processName,
    );
  }
  return result.data;
}

/**
 * The port to bind.
 *
 * A managed host assigns the port and expects the process to use it; ignoring
 * PORT in favour of a hard-coded number is the single most common reason a
 * working build serves nothing. The app's own default is the fallback for
 * local development, where nothing has assigned anything.
 */
export function resolvePort(env: { PORT?: number | undefined }, fallback: number): number {
  return env.PORT ?? fallback;
}
