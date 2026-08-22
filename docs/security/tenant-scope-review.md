# Tenant-scope review — every `withoutTenantScope`

Reviewed 2026-08-22 against the closeout head. `withoutTenantScope` opens a
transaction with the RLS bypass flag set; every use is either **pre-tenant**
(identity, before a workspace exists in the request), **cross-tenant by
design** (background sweeps that serve every workspace and stamp each row
with its own `workspace_id`), or **deliberately global** (identity rows that
are not tenant-scoped at all). Anything that reads or writes tenant data on
behalf of a request goes through `withWorkspace` — the RLS predicate — and
is not in this list.

The review rule for future changes: a new `withoutTenantScope` call must
fall into one of the three categories below and say so in a comment;
"the query was easier this way" is not a category.

## Identity and authentication (`auth/service.ts` — 26 sites)

Users, sessions, refresh tokens, MFA secrets and password resets are
**global identity rows** — they exist before and across workspace
memberships, and the tables carry no `workspace_id`. Every call site is
inside the audited AuthService, which is also where the audit log writes
(`audit`, line ~1018) — audit entries carry the workspace they concern but
are written by a service that must function during login, before any
workspace is resolved.

## Request plumbing (`lib/context.ts` — 2 sites)

Resolving a workspace **slug to an id** must run before the tenant is
known — it is the lookup that makes tenant scoping possible. Read-only,
returns only the id, cached.

## The outbox (`lib/outbox.ts` — 7 sites)

Claim/dispatch/retry **spans tenants by design**: one dispatcher drains
every workspace's events. Each row carries its `workspace_id`, handlers
that touch tenant data re-enter `withWorkspace` with the row's own
workspace, and the claim uses `FOR UPDATE SKIP LOCKED` so instances never
double-deliver.

## Background sweeps

- `services/automation-engine.ts` (2): resuming due runs and enrolling
  schedule-triggered automations sweep all workspaces; each run is then
  processed under `withWorkspace(run.workspaceId)`.
- `services/scheduling.ts` (1): the reminder dispatcher claims due reminder
  rows across tenants and stamps each emitted event with the reminder's own
  `workspace_id`.
- `routes/internal.ts` (3): cron entry points (rollups, retention,
  scheduled publishing) — same pattern, per-row workspace re-entry, and the
  routes are reachable only with the edge shared secret.

## Narrow, commented exceptions in routes

- `routes/documents.ts` (3): the claim-token download path — the token, not
  the session, is the authority, and it encodes the workspace; the handler
  verifies the token before touching the row.
- `routes/forms-public.ts` (1): public submission accepts a workspace slug
  from the URL and must resolve it pre-auth; the insert itself re-enters
  the resolved workspace.
- `routes/webhooks-whatsapp.ts` (1): Meta's webhook authenticates with an
  app-secret signature, not a session; the phone-number id maps to exactly
  one workspace and processing re-enters it.
- `routes/members.ts` (3): inviting creates/looks up a **user** (global
  identity) and suspension flips **user status** — identity writes, with
  the membership row itself written against the workspace and the
  last-owner guard evaluated inside `withWorkspace`. The session-count read
  aggregates the sessions table (global identity) grouped by user.

## What keeps this honest

- `packages/database/sql/rls.sql` auto-discovers every table with a
  `workspace_id` column and applies + `FORCE`s the tenant policy — a new
  tenant table cannot ship without the predicate.
- The test harness refuses superuser/BYPASSRLS connections, and
  `packages/database/tests/rls.test.ts` proves isolation as the real
  application role.
- Cross-tenant reads in API tests (`createSecondaryWorkspace`) pin the
  boundary for contacts, services, categories, locations, appointments,
  reviews, orders and search.
