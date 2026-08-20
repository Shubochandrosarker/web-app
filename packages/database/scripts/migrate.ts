/**
 * Apply migrations, then re-apply row-level security and the application role.
 *
 * Three phases because they are different kinds of change. Drizzle owns table
 * DDL and tracks it in its journal; RLS policies and role grants are
 * hand-written, idempotent, and re-applied every run so a new table can never
 * quietly ship without the tenant predicate that makes it safe, nor without
 * the grants the application needs to read it.
 *
 * Run this as the owner/admin role. The application itself must connect as
 * `bos_app` — see sql/grants.sql for why that distinction is load-bearing.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString, max: 1 });
const db = drizzle(pool);

try {
  console.log('Applying schema migrations…');
  await migrate(db, { migrationsFolder: resolve(packageRoot, 'drizzle') });

  console.log('Applying row-level security policies…');
  const rls = await readFile(resolve(packageRoot, 'sql/rls.sql'), 'utf8');
  await db.execute(sql.raw(rls));

  console.log('Applying application role grants…');
  const grants = await readFile(resolve(packageRoot, 'sql/grants.sql'), 'utf8');
  await db.execute(sql.raw(grants));

  console.log('Migrations complete.');
} catch (error) {
  console.error('Migration failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
