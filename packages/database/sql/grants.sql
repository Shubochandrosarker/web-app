-- ---------------------------------------------------------------------------
-- The application database role.
--
-- This file exists because of a failure mode that is easy to ship and hard to
-- notice: **row-level security does not apply to superusers, to roles with
-- BYPASSRLS, or (without FORCE) to the table owner.** Policies can be perfect
-- and every tenant boundary still open, purely because the connection string
-- points at the wrong role. Nothing in the application would look wrong.
--
-- So the role is provisioned here, alongside the policies it depends on, and
-- `pnpm db:migrate` re-applies it every run.
--
--   bos_app   NOSUPERUSER, NOBYPASSRLS, no CREATE, not the table owner.
--             DML only. Every policy in rls.sql binds it.
--
-- Migrations continue to run as the owner/admin role. The application must
-- not: DATABASE_URL for apps/api, apps/site and every Worker points at
-- bos_app, and `docs/architecture/07-security-and-data-protection.md` records
-- that as a deployment requirement.
--
-- No password is set here — a committed password is not a password. The
-- operator assigns one out of band:
--
--   ALTER ROLE bos_app WITH LOGIN PASSWORD '<from the secret store>';
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bos_app') THEN
        CREATE ROLE bos_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    ELSE
        -- Re-assert the attributes that matter, in case someone widened them.
        ALTER ROLE bos_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO bos_app;

-- DML only. The application never issues DDL; migrations do, as the owner.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bos_app;

-- Tables created by future migrations inherit the same grants, so a new table
-- is never accidentally unreadable — or accidentally ungoverned.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO bos_app;

-- Drizzle's own migration bookkeeping stays out of reach of the app role.
REVOKE ALL ON SCHEMA drizzle FROM bos_app;
