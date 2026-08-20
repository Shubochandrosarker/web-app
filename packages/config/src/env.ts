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

export const runtimeEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
});

export const databaseEnvSchema = z.object({
  DATABASE_URL: z.string().startsWith('postgres', 'must be a postgres:// or postgresql:// URL'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
});

export const cacheEnvSchema = z.object({
  REDIS_URL: z.string().startsWith('redis', 'must be a redis:// or rediss:// URL'),
});

export const apiEnvSchema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_PUBLIC_URL: z.url(),
  /** 32 bytes of entropy, base64-encoded. Short secrets are a silent downgrade. */
  AUTH_SESSION_SECRET: z.string().min(32, 'needs at least 32 characters of entropy'),
  AUTH_ACCESS_TOKEN_TTL: z.coerce.number().int().min(60).default(900),
  AUTH_REFRESH_TOKEN_TTL: z.coerce.number().int().min(3600).default(2_592_000),
});

export const siteEnvSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z.url(),
  NEXT_PUBLIC_API_URL: z.url(),
  BOS_WORKSPACE_SLUG: z.string().min(1),
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
});

export const emailEnvSchema = z
  .object({
    EMAIL_PROVIDER: z.enum(['resend', 'smtp', 'ses']).default('smtp'),
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

export const edgeEnvSchema = z.object({
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1),
  EDGE_SHARED_SECRET: z.string().min(32),
});

export type RuntimeEnv = z.infer<typeof runtimeEnvSchema>;
export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;
export type CacheEnv = z.infer<typeof cacheEnvSchema>;
export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type SiteEnv = z.infer<typeof siteEnvSchema>;
export type ContentEnv = z.infer<typeof contentEnvSchema>;
export type StorageEnv = z.infer<typeof storageEnvSchema>;
export type EmailEnv = z.infer<typeof emailEnvSchema>;
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
