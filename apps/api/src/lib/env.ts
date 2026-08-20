import {
  apiEnvSchema,
  databaseEnvSchema,
  loadEnv,
  runtimeEnvSchema,
  type ApiEnv,
  type DatabaseEnv,
  type RuntimeEnv,
} from '@bos/config';

/**
 * Validated once, at boot. If anything is missing the process exits before it
 * ever accepts a request — a misconfigured deploy should fail loudly at start,
 * not as a 500 three days later on an untested code path.
 */
export type ApiConfig = RuntimeEnv & DatabaseEnv & ApiEnv;

export function loadApiConfig(source: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    ...loadEnv(runtimeEnvSchema, source, 'api:runtime'),
    ...loadEnv(databaseEnvSchema, source, 'api:database'),
    ...loadEnv(apiEnvSchema, source, 'api:http'),
  };
}
