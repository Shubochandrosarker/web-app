import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  closeDatabase,
  createDatabase,
  schema,
  withoutTenantScope,
  type Database,
} from '@bos/database';
import { buildApp } from '../src/app.ts';
import type { ApiConfig } from '../src/lib/env.ts';
import { closeRedis, createRedis, type RedisClient } from '../src/lib/redis.ts';
import { hashPassword } from '../src/lib/crypto.ts';

/**
 * Test harness.
 *
 * The suite runs against a **real** Postgres and a real Redis rather than
 * doubles, because the things most worth testing here are the ones a double
 * would fake away: row-level security, unique-index deduplication, `FOR UPDATE
 * SKIP LOCKED`, and transactional atomicity. A mocked database would pass
 * every one of those tests while the real one failed.
 *
 * Each suite gets a workspace with a random slug, so tests do not have to
 * coordinate over shared rows and can run against a database that already has
 * data in it.
 */

export const TEST_PASSWORD = 'correct-horse-battery-staple';

/**
 * The connection the suite uses.
 *
 * `TEST_DATABASE_URL` should point at the **application** role (`bos_app`),
 * not the migration owner. That is not a detail: row-level security does not
 * apply to a superuser, to a role with `BYPASSRLS`, or (without `FORCE`) to
 * the table owner — so a suite connected as the owner would pass every
 * cross-tenant test while the boundary was wide open.
 *
 * `assertRlsApplies` below turns that from a silent false pass into a loud
 * failure.
 */
function testDatabaseUrl(): string {
  return (
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgresql://bos_app:bos_app@localhost:5432/bos_dev'
  );
}

/**
 * Refuse to run against a connection that row-level security does not bind.
 *
 * Every tenant-isolation assertion in this suite is vacuous under a superuser:
 * the query returns the other tenant's row, the test asserts it does not, and
 * the failure looks like an application bug rather than a test-environment
 * one. Checking up front means the message says which it is.
 */
async function assertRlsApplies(db: Database): Promise<void> {
  const result = await db.execute<{
    is_superuser: string;
    bypassrls: boolean;
    current_user: string;
  }>(
    sql`
      select
        current_setting('is_superuser')                        as is_superuser,
        (select rolbypassrls from pg_roles where rolname = current_user) as bypassrls,
        current_user
      from pg_roles limit 1
    `,
  );

  const row = result.rows[0];
  if (row?.is_superuser === 'on' || row?.bypassrls === true) {
    throw new Error(
      `The test suite is connected as "${row.current_user}", which row-level security does not ` +
        'bind (superuser or BYPASSRLS). Every tenant-isolation test would pass regardless of ' +
        'whether isolation works.\n\n' +
        'Point TEST_DATABASE_URL at the least-privilege application role:\n' +
        "  ALTER ROLE bos_app WITH LOGIN PASSWORD '<password>';\n" +
        '  TEST_DATABASE_URL=postgresql://bos_app:<password>@host:5432/<db>',
    );
  }
}

export interface Harness {
  readonly app: FastifyInstance;
  readonly db: Database;
  readonly redis: RedisClient;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly close: () => Promise<void>;
}

export function testConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    DATABASE_URL: testDatabaseUrl(),
    DATABASE_POOL_MAX: 5,
    REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    API_PORT: 4000,
    API_PUBLIC_URL: 'http://localhost:4000',
    API_ALLOWED_ORIGINS: 'http://localhost:3000',
    AUTH_SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    AUTH_ACCESS_TOKEN_TTL: 900,
    AUTH_REFRESH_TOKEN_TTL: 2_592_000,
    AUTH_MFA_ISSUER: 'Business OS Test',
    EDGE_SHARED_SECRET: 'test-edge-shared-secret-at-least-32-characters',
    ANALYTICS_HASH_SECRET: 'test-analytics-secret-at-least-32-characters-ok',
    EMAIL_PROVIDER: 'log',
    EMAIL_FROM_ADDRESS: 'noreply@example.com',
    EMAIL_FROM_NAME: 'Business OS Test',
    WHATSAPP_PROVIDER: 'log',
    storage: undefined,
    port: 4000,
    allowedOrigins: ['http://localhost:3000'],
    databaseSsl: 'disable',
    ...overrides,
  } as ApiConfig;
}

export async function createHarness(overrides: Partial<ApiConfig> = {}): Promise<Harness> {
  const config = testConfig(overrides);
  const db = createDatabase({ connectionString: config.DATABASE_URL, maxConnections: 5 });
  const redis = createRedis(config.REDIS_URL);

  /*
   * Everything past this point can throw, and by now a connection pool and a
   * Redis client are open. Node does not exit while either is holding a
   * socket, so a setup failure that leaves them open does not fail the run —
   * it hangs it, until whatever timeout is furthest out kills the job. In CI
   * that turned a thirty-second failure into a twenty-minute one and buried
   * the error message at the top of a log nobody reaches.
   *
   * Failing loudly is the whole point of `assertRlsApplies`; it is worth
   * making sure the failure can actually be seen.
   */
  try {
    return await buildHarness(config, db, redis);
  } catch (error) {
    await closeRedis().catch(() => undefined);
    await closeDatabase().catch(() => undefined);
    throw error;
  }
}

async function buildHarness(config: ApiConfig, db: Database, redis: RedisClient): Promise<Harness> {
  await assertRlsApplies(db);

  const { app } = buildApp({ config, database: db, redis });
  await app.ready();

  const workspaceSlug = `test-${randomUUID().slice(0, 8)}`;
  const workspaceId = await withoutTenantScope(db, async (tx) => {
    const [row] = await tx
      .insert(schema.workspaces)
      .values({
        slug: workspaceSlug,
        name: 'Test Workspace',
        businessType: 'education_service',
        siteUrl: 'https://test.example.com',
        defaultLocale: 'en',
        supportedLocales: ['en'],
        timeZone: 'Asia/Dhaka',
        currency: 'BDT',
        enabledModules: [],
        status: 'active',
      })
      .returning({ id: schema.workspaces.id });
    return row!.id;
  });

  return {
    app,
    db,
    redis,
    workspaceId,
    workspaceSlug,
    close: async () => {
      // Delete the workspace rather than truncating: the cascade removes
      // everything the suite created and leaves any other data alone, which is
      // what lets two suites run against the same database concurrently.
      await withoutTenantScope(db, (tx) =>
        tx.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)),
      ).catch(() => undefined);

      await app.close();
      await closeRedis();
      await closeDatabase();
    },
  };
}

/**
 * A second workspace the harness's members are *not* in.
 *
 * Used by the cross-tenant tests. A whole second harness would work too, until
 * its `close()` tore down the connection-pool singletons that the first
 * harness is still using — these are process-wide by design, so the tests must
 * share them.
 */
export async function createSecondaryWorkspace(
  harness: Harness,
): Promise<{ workspaceId: string; workspaceSlug: string; drop: () => Promise<void> }> {
  const workspaceSlug = `other-${randomUUID().slice(0, 8)}`;

  const workspaceId = await withoutTenantScope(harness.db, async (tx) => {
    const [row] = await tx
      .insert(schema.workspaces)
      .values({
        slug: workspaceSlug,
        name: 'Other Workspace',
        businessType: 'agency',
        siteUrl: 'https://other.example.com',
        defaultLocale: 'en',
        supportedLocales: ['en'],
        timeZone: 'UTC',
        currency: 'USD',
        enabledModules: [],
        status: 'active',
      })
      .returning({ id: schema.workspaces.id });
    return row!.id;
  });

  return {
    workspaceId,
    workspaceSlug,
    drop: async () => {
      await withoutTenantScope(harness.db, (tx) =>
        tx.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)),
      ).catch(() => undefined);
    },
  };
}

/** Create a user and give them a role in the harness workspace. */
export async function createMember(
  harness: Harness,
  role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer',
  extraPermissions: readonly string[] = [],
): Promise<{ userId: string; email: string }> {
  const email = `${randomUUID().slice(0, 8)}@example.test`;
  const passwordHash = await hashPassword(TEST_PASSWORD);

  const userId = await withoutTenantScope(harness.db, async (tx) => {
    const [user] = await tx
      .insert(schema.users)
      .values({
        email,
        passwordHash,
        fullName: `Test ${role}`,
        status: 'active',
        emailVerifiedAt: new Date(),
      })
      .returning({ id: schema.users.id });

    await tx.insert(schema.workspaceMembers).values({
      workspaceId: harness.workspaceId,
      userId: user!.id,
      role,
      extraPermissions,
      joinedAt: new Date(),
    });

    return user!.id;
  });

  return { userId, email };
}

/** Log in and return the tokens, so a test can act as that member. */
export async function login(
  harness: Harness,
  email: string,
  password = TEST_PASSWORD,
): Promise<{ accessToken: string; refreshToken: string }> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password },
  });

  const body = response.json() as { accessToken?: string; refreshToken?: string };
  if (!body.accessToken || !body.refreshToken) {
    throw new Error(`Login failed (${response.statusCode}): ${response.body}`);
  }

  return { accessToken: body.accessToken, refreshToken: body.refreshToken };
}

export function authHeaders(harness: Harness, accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    'x-bos-workspace': harness.workspaceSlug,
  };
}

/** Remove any Redis keys a test left behind, so reruns are not rate-limited. */
export async function clearRateLimits(harness: Harness): Promise<void> {
  const keys = await harness.redis.keys('rl:*');
  if (keys.length > 0) await harness.redis.del(...keys);
}

/** Seed a published page with the given sections. */
export async function seedContent(
  harness: Harness,
  entry: {
    path: string;
    slug: string;
    title: string;
    type?: 'page' | 'service' | 'post';
    status?: 'draft' | 'scheduled' | 'published' | 'archived';
    publishedAt?: Date | null;
    sections?: unknown[];
  },
): Promise<string> {
  return withoutTenantScope(harness.db, async (tx) => {
    await tx.execute(sql`select set_config('bos.workspace_id', ${harness.workspaceId}, true)`);
    const [row] = await tx
      .insert(schema.contentEntries)
      .values({
        workspaceId: harness.workspaceId,
        type: entry.type ?? 'page',
        slug: entry.slug,
        path: entry.path,
        locale: 'en',
        title: entry.title,
        status: entry.status ?? 'published',
        publishedAt:
          entry.publishedAt === undefined
            ? entry.status === 'published' || entry.status === undefined
              ? new Date()
              : null
            : entry.publishedAt,
        document: { sections: entry.sections ?? [] },
      })
      .returning({ id: schema.contentEntries.id });
    return row!.id;
  });
}

/** Seed the service-request form the public submission tests use. */
export async function seedForm(harness: Harness): Promise<string> {
  return withoutTenantScope(harness.db, async (tx) => {
    const [row] = await tx
      .insert(schema.forms)
      .values({
        workspaceId: harness.workspaceId,
        slug: 'service-request',
        name: 'Service request',
        fields: [
          { name: 'name', label: 'Name', type: 'text', required: true, options: [] },
          { name: 'phone', label: 'Phone', type: 'tel', required: true, options: [] },
          { name: 'email', label: 'Email', type: 'email', required: false, options: [] },
          { name: 'message', label: 'Message', type: 'textarea', required: false, options: [] },
        ],
        submitLabel: 'Send',
        successMessage: 'Thanks',
        outcome: 'lead',
        notifyEmails: ['staff@example.test'],
        spamConfig: { honeypotField: 'company_website', minFillMs: 2000 },
        requiresConsent: true,
        enabled: true,
      })
      .returning({ id: schema.forms.id });
    return row!.id;
  });
}

/** A default pipeline, so captured leads land in a stage. */
export async function seedPipeline(
  harness: Harness,
): Promise<{ pipelineId: string; stageIds: string[] }> {
  return withoutTenantScope(harness.db, async (tx) => {
    const [pipeline] = await tx
      .insert(schema.pipelines)
      .values({
        workspaceId: harness.workspaceId,
        slug: 'sales',
        name: 'Service requests',
        isDefault: true,
      })
      .returning({ id: schema.pipelines.id });

    const stages = await tx
      .insert(schema.pipelineStages)
      .values([
        {
          workspaceId: harness.workspaceId,
          pipelineId: pipeline!.id,
          slug: 'new',
          name: 'New',
          position: 0,
        },
        {
          workspaceId: harness.workspaceId,
          pipelineId: pipeline!.id,
          slug: 'done',
          name: 'Done',
          position: 1,
          isWon: true,
        },
      ])
      .returning({ id: schema.pipelineStages.id });

    return { pipelineId: pipeline!.id, stageIds: stages.map((stage) => stage.id) };
  });
}
