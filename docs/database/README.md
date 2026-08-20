# Database

Postgres 16+. The schema is defined in TypeScript with Drizzle
(`packages/database/src/schema/`), and SQL migrations are **generated** from it
— the TypeScript is the source of truth, the SQL in `packages/database/drizzle/`
is the artefact. CI fails if the two disagree.

```
packages/database/
├── src/schema/          Drizzle table definitions, split by domain
├── drizzle/             Generated migrations + journal (committed)
├── sql/
│   ├── rls.sql          Row-level security policies (idempotent, re-applied)
│   └── grants.sql       The bos_app application role and its grants
├── scripts/migrate.ts   Migrate → apply RLS → apply grants
└── tests/rls.test.ts    Tenant isolation, verified against a real database
```

## Commands

```bash
pnpm db:generate     # after editing a schema file — writes a new migration
pnpm db:migrate      # apply migrations + RLS + grants (run as the owner role)
pnpm db:status       # which migrations the target database has applied
```

## Conventions

| Decision                                                   | Why                                                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UUID primary keys, `gen_random_uuid()`                     | Ids can be minted before the row exists, which the event outbox and offline forms both need.                                                           |
| `TIMESTAMPTZ` everywhere                                   | Multi-tenant across time zones; a naive timestamp is a latent bug.                                                                                     |
| `workspace_id` on every tenant-scoped table                | It is what RLS keys on. Repeating it keeps the tenant predicate on one index instead of a join.                                                        |
| Money as integer minor units                               | No floats, no `numeric` read into a JS number.                                                                                                         |
| Enums for platform behaviour, tables for tenant vocabulary | A client renaming a pipeline stage must never require a migration. Stages are rows; `lead_status` is an enum.                                          |
| `deleted_at` only where restore is real                    | A soft-delete column nobody restores from is a permanent source of forgotten `WHERE deleted_at IS NULL` bugs.                                          |
| Partial indexes on work queues                             | `event_outbox`, `automation_runs.resume_at` and `appointment_reminders` are scanned only for pending rows, so the indexes stay small as history grows. |

## Multi-tenancy

Every tenant-scoped table has RLS enabled **and forced**, with one policy:

```sql
USING (
    current_setting('bos.bypass_rls', true) = 'on'
    OR workspace_id = NULLIF(current_setting('bos.workspace_id', true), '')::uuid
)
```

`packages/database/sql/rls.sql` discovers the tables to protect by looking for a
`workspace_id` column rather than listing them, so a new table cannot ship
without the policy. `workspaces` itself is handled explicitly, because it is
keyed on `id`.

Application code sets the context through `withWorkspace()`, which uses
`set_config(..., true)` — transaction-local, so a pooled connection cannot leak
one tenant's context into the next request that borrows it. With no context
set, `current_setting` returns NULL, every row fails the predicate, and the
query returns nothing. **The failure mode is "sees nothing", not "sees
everything".**

### The application must not connect as a superuser

This is the part that is easy to get wrong and impossible to see from the
application: **RLS does not apply to superusers, to roles with `BYPASSRLS`, or
(without `FORCE`) to the table owner.** Policies can be perfect and every
tenant boundary still wide open, purely because `DATABASE_URL` points at the
wrong role.

`sql/grants.sql` provisions `bos_app` — `NOSUPERUSER`, `NOBYPASSRLS`, no
`CREATE`, DML only — and `pnpm db:migrate` re-applies it every run. Migrations
run as the owner; **`apps/api`, `apps/site` and every Worker must connect as
`bos_app`.**

`tests/rls.test.ts` asserts this from both directions: tenant-scoped queries run
under `SET LOCAL ROLE bos_app` and see exactly one tenant, and one test
deliberately connects as the superuser and asserts that it _does_ see
everything — so the day someone changes how the app connects, a test explains
why it matters instead of silently passing.

### What `bos.bypass_rls` is and is not

It is a discipline boundary, not a privilege boundary. Any role can set a
custom GUC, so a compromised application could set it too. Its job is to make
cross-tenant access **conspicuous in review** — `withoutTenantScope()` is named
to be greppable, and it belongs only in the outbox dispatcher, the retention
sweeper and migrations. A request handler calling it is a bug.

## Sensitive documents

`documents` holds pointers, never files and never URLs. Objects live in the
private R2 bucket keyed by `object_key`; the only read path is an authorised
request that mints a short-lived signed URL and writes a `document_access_log`
row **before** returning it. `retain_until` drives automatic deletion. See
`docs/architecture/07-security-and-data-protection.md`.

## Schema map

| Module             | Tables                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Identity & tenancy | `users`, `workspaces`, `workspace_members`, `workspace_invitations`, `sessions`, `api_keys`, `audit_log`                  |
| Business           | `brands`, `locations`, `service_categories`, `services`, `staff_profiles`                                                 |
| Content            | `content_entries`, `content_revisions`, `media`, `navigation_menus`, `redirects`                                          |
| SEO                | `seo_metadata`, `seo_entities`, `seo_entity_relations`, `content_entities`, `indexing_events`, `search_performance_daily` |
| CRM                | `companies`, `contacts`, `pipelines`, `pipeline_stages`, `leads`, `tags`, `taggables`, `notes`, `tasks`, `activities`     |
| Forms & documents  | `forms`, `form_submissions`, `documents`, `document_access_log`                                                           |
| Scheduling         | `availability_rules`, `availability_exceptions`, `appointments`, `appointment_reminders`                                  |
| Messaging          | `message_templates`, `message_sequences`, `campaigns`, `messages`, `message_events`, `suppressions`                       |
| Automation         | `automations`, `automation_versions`, `automation_runs`, `automation_run_steps`, `event_outbox`, `webhook_deliveries`     |
| Analytics          | `analytics_sessions`, `analytics_events`, `attribution_touches`, `analytics_daily`, `reviews`                             |

58 tables, 19 enums.

## Verifying locally

```bash
# any Postgres 16 will do
export DATABASE_URL=postgresql://bos@localhost:5432/bos_dev
pnpm db:migrate
pnpm --filter @bos/database test

# which tables are unprotected?
psql "$DATABASE_URL" -c "SELECT * FROM rls_coverage WHERE NOT rls_enabled;"
```

Only `users` and `sessions` should appear — both are keyed to a person rather
than a tenant, and are documented as such in `sql/rls.sql`. Anything else in
that list is a finding.
