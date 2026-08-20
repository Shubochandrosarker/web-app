import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from './schema/index.ts';

export type Database = NodePgDatabase<typeof schema>;

export interface CreateDatabaseOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly ssl?: boolean;
}

let pool: pg.Pool | undefined;

/**
 * Create (or reuse) the connection pool.
 *
 * A module-level singleton on purpose: Next.js dev reloads and serverless
 * re-invocations would otherwise open a new pool per reload and exhaust
 * Postgres' connection limit long before any real traffic arrives.
 */
export function createDatabase(options: CreateDatabaseOptions): Database {
  pool ??= new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    ...(options.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    // Fail fast rather than queueing behind a database that is already gone.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  return drizzle(pool, { schema, casing: 'snake_case' });
}

export async function closeDatabase(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/**
 * Run `fn` with the tenant context set, so row-level security applies.
 *
 * Every request-scoped query must go through this. The setting is applied with
 * `set_config(..., true)` — transaction-local — so a pooled connection cannot
 * leak one tenant's context into the next request that borrows it.
 */
export async function withWorkspace<T>(
  db: Database,
  workspaceId: string,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('bos.workspace_id', ${workspaceId}, true)`);
    return fn(tx as unknown as Database);
  });
}

/**
 * Escape hatch for jobs that legitimately span tenants — the outbox
 * dispatcher, the retention sweeper, migrations. Named to be conspicuous in
 * review: a request handler calling this is a bug.
 */
export async function withoutTenantScope<T>(
  db: Database,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('bos.bypass_rls', 'on', true)`);
    return fn(tx as unknown as Database);
  });
}
