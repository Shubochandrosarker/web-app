/**
 * Row-level security integration test.
 *
 * Asserts the property the whole multi-tenant design rests on: with a tenant
 * context set, a query cannot see another tenant's rows — and with no context
 * set, it sees nothing at all. A unit test cannot check this, because the
 * behaviour lives in Postgres policies rather than in application code.
 *
 * The tenant-scoped queries run under `SET LOCAL ROLE bos_app`, because that
 * is the whole point: RLS does not apply to superusers, to BYPASSRLS roles, or
 * to the table owner without FORCE. Testing as the migration role would pass
 * with the policies deleted. See sql/grants.sql.
 *
 * Requires DATABASE_URL pointing at a migrated database, as a role that owns
 * the tables and may `SET ROLE bos_app`. Skips when unset so a developer
 * without Postgres running still gets a green `pnpm test`.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;

describe('row-level security', { skip: connectionString ? false : 'DATABASE_URL not set' }, () => {
  let pool: pg.Pool;
  const workspaceA = '11111111-1111-4111-8111-111111111111';
  const workspaceB = '22222222-2222-4222-8222-222222222222';

  before(async () => {
    pool = new pg.Pool({ connectionString, max: 2 });

    // Seeding spans tenants, so it runs with the bypass — the same escape
    // hatch the outbox dispatcher and retention sweeper use.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`select set_config('bos.bypass_rls', 'on', true)`);
      await client.query(
        `INSERT INTO workspaces (id, slug, name, business_type, site_url)
         VALUES ($1, 'tenant-a', 'Tenant A', 'agency', 'https://a.example.com'),
                ($2, 'tenant-b', 'Tenant B', 'agency', 'https://b.example.com')
         ON CONFLICT (id) DO NOTHING`,
        [workspaceA, workspaceB],
      );
      await client.query(
        `INSERT INTO contacts (workspace_id, full_name, email)
         VALUES ($1, 'Contact A', 'a@example.com'),
                ($2, 'Contact B', 'b@example.com')
         ON CONFLICT DO NOTHING`,
        [workspaceA, workspaceB],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  after(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`select set_config('bos.bypass_rls', 'on', true)`);
      await client.query('DELETE FROM workspaces WHERE id = ANY($1)', [[workspaceA, workspaceB]]);
      await client.query('COMMIT');
    } finally {
      client.release();
      await pool.end();
    }
  });

  /** Run a query the way a request handler does: as bos_app, tenant scoped. */
  async function asTenant<T>(
    workspaceId: string,
    query: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE bos_app');
      await client.query(`select set_config('bos.workspace_id', $1, true)`, [workspaceId]);
      const result = await client.query(query, params);
      await client.query('COMMIT');
      return result.rows as T[];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it('shows a tenant only its own contacts', async () => {
    const rows = await asTenant<{ full_name: string }>(
      workspaceA,
      'SELECT full_name FROM contacts',
    );
    assert.deepEqual(
      rows.map((row) => row.full_name),
      ['Contact A'],
    );
  });

  it('shows a tenant only its own workspace row', async () => {
    const rows = await asTenant<{ slug: string }>(workspaceB, 'SELECT slug FROM workspaces');
    assert.deepEqual(
      rows.map((row) => row.slug),
      ['tenant-b'],
    );
  });

  it('returns nothing when no tenant context is set', async () => {
    // Fail-closed is the important half: a forgotten withWorkspace() must
    // produce an empty result, never a cross-tenant leak.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE bos_app');
      const result = await client.query('SELECT count(*)::int AS count FROM contacts');
      await client.query('COMMIT');
      assert.equal(result.rows[0].count, 0);
    } finally {
      client.release();
    }
  });

  it('does not apply policies to a superuser, which is why the app role exists', async () => {
    // Documents the failure mode rather than hiding it: connect as the
    // migration role and every tenant is visible. If this ever starts
    // returning one row, someone has changed how the app connects.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`select set_config('bos.workspace_id', $1, true)`, [workspaceA]);
      const result = await client.query('SELECT count(*)::int AS count FROM contacts');
      await client.query('COMMIT');
      assert.ok(result.rows[0].count >= 2, 'superuser should bypass RLS entirely');
    } finally {
      client.release();
    }
  });

  it('refuses to write a row belonging to another tenant', async () => {
    await assert.rejects(
      () =>
        asTenant(
          workspaceA,
          `INSERT INTO contacts (workspace_id, full_name) VALUES ($1, 'Smuggled')`,
          [workspaceB],
        ),
      /row-level security/i,
    );
  });
});
