-- ---------------------------------------------------------------------------
-- Row-level security.
--
-- Re-applied on every `pnpm db:migrate`, and idempotent by construction.
--
-- Rather than listing tables (a list that goes stale the first time someone
-- adds one), this discovers every table in `public` carrying a `workspace_id`
-- column and applies the same policy. A new tenant-scoped table therefore
-- cannot ship without the tenant predicate — the worst case is that someone
-- forgets the column, which is loud, instead of forgetting the policy, which
-- is silent.
--
-- The policy reads two transaction-local settings, both set by
-- @bos/database's `withWorkspace` / `withoutTenantScope`:
--
--   bos.workspace_id  the tenant this transaction may see
--   bos.bypass_rls    'on' for cross-tenant jobs (outbox dispatch, retention)
--
-- Both are set with `set_config(..., true)`, so they are scoped to the
-- transaction and cannot leak across a pooled connection. When neither is set,
-- `current_setting(..., true)` returns NULL and every row fails the predicate:
-- the failure mode is "sees nothing", not "sees everything".
--
-- FORCE ROW LEVEL SECURITY is applied so the policy binds even for the table
-- owner. The application should still connect as a dedicated non-owner role;
-- this is the second lock, not the first.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    target RECORD;
BEGIN
    FOR target IN
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND a.attname = 'workspace_id'
          AND a.attnum > 0
          AND NOT a.attisdropped
        ORDER BY c.relname
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target.table_name);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', target.table_name);

        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'tenant_isolation', target.table_name);
        EXECUTE format(
            'CREATE POLICY %I ON public.%I
                 USING (
                     current_setting(''bos.bypass_rls'', true) = ''on''
                     OR workspace_id = NULLIF(current_setting(''bos.workspace_id'', true), '''')::uuid
                 )
                 WITH CHECK (
                     current_setting(''bos.bypass_rls'', true) = ''on''
                     OR workspace_id = NULLIF(current_setting(''bos.workspace_id'', true), '''')::uuid
                 )',
            'tenant_isolation',
            target.table_name
        );
    END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- `workspaces` is the tenant table itself, so it is keyed on `id` rather than
-- `workspace_id` and the discovery loop above cannot see it. Without this
-- explicit policy, a query against `workspaces` would return every tenant —
-- the one table where that mistake would be most damaging.
-- ---------------------------------------------------------------------------

ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON public.workspaces;
CREATE POLICY tenant_isolation ON public.workspaces
    USING (
        current_setting('bos.bypass_rls', true) = 'on'
        OR id = NULLIF(current_setting('bos.workspace_id', true), '')::uuid
    )
    WITH CHECK (
        current_setting('bos.bypass_rls', true) = 'on'
        OR id = NULLIF(current_setting('bos.workspace_id', true), '')::uuid
    );

-- ---------------------------------------------------------------------------
-- Tables deliberately left outside tenant isolation, with the reason:
--
--   users      A person may belong to several workspaces, so a workspace_id
--              column here would be a lie. Access is mediated by
--              workspace_members at the application layer.
--   sessions   Keyed to a user, not a workspace.
--
-- `webhook_deliveries` does carry a nullable workspace_id and so is covered by
-- the loop above. Rows whose tenant is not yet known hold NULL and therefore
-- match no tenant — ingestion and dispatch run under withoutTenantScope(),
-- which is the intended and only way to read them.
--
-- Any other table without workspace_id should be treated as a review finding.
-- The `rls_coverage` view below is what makes that checkable.
-- ---------------------------------------------------------------------------

-- A convenience view for auditing: which public tables are unprotected?
CREATE OR REPLACE VIEW public.rls_coverage AS
SELECT
    c.relname                                            AS table_name,
    c.relrowsecurity                                     AS rls_enabled,
    c.relforcerowsecurity                                AS rls_forced,
    EXISTS (
        SELECT 1
        FROM pg_attribute a
        WHERE a.attrelid = c.oid
          AND a.attname = 'workspace_id'
          AND a.attnum > 0
          AND NOT a.attisdropped
    )                                                    AS has_workspace_id
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
ORDER BY c.relname;
