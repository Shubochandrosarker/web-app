/** Report which migrations the target database has applied. */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString, max: 1 });
const db = drizzle(pool);

try {
  const applied = await db.execute<{ hash: string; created_at: string }>(
    sql`select hash, created_at from drizzle.__drizzle_migrations order by created_at`,
  );
  const rows = applied.rows ?? [];

  if (rows.length === 0) {
    console.log('No migrations applied yet.');
  } else {
    console.log(`${rows.length} migration(s) applied:`);
    for (const row of rows) console.log(`  ${row.created_at}  ${row.hash}`);
  }

  const tables = await db.execute<{ count: string }>(
    sql`select count(*)::text as count from information_schema.tables where table_schema = 'public'`,
  );
  console.log(`public schema holds ${tables.rows?.[0]?.count ?? '0'} table(s).`);
} catch (error) {
  console.error('Could not read migration status:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
