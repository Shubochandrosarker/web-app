# Backup and restore

> A backup nobody has restored from is a hypothesis, not a backup. The restore
> drill below is the part that makes the rest of this document true.

## What has to survive

|                       | Where               | Recoverable from a backup?         | Consequence of loss                                                          |
| --------------------- | ------------------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| Postgres              | Managed instance    | **Yes — and it must be**           | Every lead, contact, page and account. Unrecoverable by any other means.     |
| R2 private documents  | `bos-documents`     | Yes, via versioning                | Somebody's transcript. They can re-upload, but only if you can tell them to. |
| R2 public media       | `bos-assets`        | Yes, via versioning                | Images. Re-uploadable from originals.                                        |
| Redis                 | Managed instance    | **No, and it does not need to be** | Rate-limit counters and caches. Rebuilt on demand.                           |
| Environment variables | Host and Cloudflare | Only from your secret store        | The deployment cannot start.                                                 |

The Redis row is a design property rather than an accepted risk: nothing
durable is stored there. A flush resets some counters, empties a cache and
invalidates any half-finished MFA challenge. See `apps/api/src/lib/redis.ts`.

## Objectives

|                                            | Target      | How it is met                                                              |
| ------------------------------------------ | ----------- | -------------------------------------------------------------------------- |
| **RPO** — how much data a failure may cost | ≤ 5 minutes | Managed Postgres with point-in-time recovery and continuous WAL archiving. |
| **RTO** — how long recovery may take       | ≤ 2 hours   | Restore to a new instance, repoint `DATABASE_URL`, redeploy.               |

Both are targets for the _platform_. If the host's own restore is slower, the
RTO is the host's, not this document's — measure it in the drill rather than
assuming it.

## Postgres

**Required of the provider:**

- Automated daily full backups, retained 30 days.
- Point-in-time recovery with a window of at least 7 days.
- Backups stored in a different region from the primary.

**Additionally, a weekly logical dump**, because a provider snapshot is only
restorable _into that provider_:

```bash
pg_dump \
  --format=custom --no-owner --no-privileges \
  --dbname="$DATABASE_URL_OWNER" \
  --file="bos-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Encrypt it, then store it somewhere that is not the database provider and not
the host:

```bash
age -r "$BACKUP_PUBLIC_KEY" -o bos-….dump.age bos-….dump
```

A dump is a complete copy of every lead, contact and document reference in the
system. It is exactly as sensitive as the database, and encrypting it at rest
is not optional.

**Before a schema change**, take a dump by hand. Migrations here are
expand-only, so the previous version tolerates the new schema — but "expand
only" is a discipline, not a guarantee, and the dump costs a minute.

## R2

**Versioning on for both buckets.** It is the whole backup strategy for
`bos-assets`, whose objects are content-addressed and immutable.

For `bos-documents`, versioning covers a mistaken delete. It does not cover a
compromised API token, so:

- The token is scoped to those two buckets and nothing else.
- Rotate it quarterly and after any staff change.
- Weekly, sync the private bucket to storage the API token cannot reach:

```bash
rclone sync r2:bos-documents /secure/offsite/bos-documents \
  --backup-dir "/secure/offsite/bos-documents-$(date -u +%Y%m%d)"
```

Retention on that copy must respect the same clock as `documents.retain_until`.
A document deleted by the retention sweep and then kept indefinitely in a
backup has not been deleted — it has been moved somewhere with no audit log.

## Configuration

Not in Git, and therefore not in any of the above:

- Hostinger environment variables, per app.
- Cloudflare Worker secrets.
- Database credentials, R2 keys, SMTP and WhatsApp tokens.

Keep them in a password manager or secret store with the deployment. Record
_which_ variables exist for which app — `.env.example` is that list, and it is
in Git precisely so the values do not have to be.

---

## The restore drill

Run before go-live, and every quarter after. It is timed, and the time is the
RTO — a drill that is not timed measures nothing.

### 1. Provision a scratch database

Never restore into production to "check the backup". A restore into the live
database is not a test, it is an outage.

```bash
createdb bos_restore_test
```

### 2. Restore

```bash
time pg_restore \
  --dbname=postgresql://bos:<password>@<host>:5432/bos_restore_test \
  --no-owner --no-privileges \
  bos-<timestamp>.dump
```

### 3. Verify the data is actually there

Row counts alone prove very little. Check the things whose loss would matter:

```sql
-- Every workspace, and its module list intact.
select slug, business_type, jsonb_array_length(enabled_modules) as modules
from workspaces;

-- Leads, and how recent the newest one is. This number is the real RPO.
select count(*) as leads, max(created_at) as newest from leads;

-- Content, and how much of it is live.
select status, count(*) from content_entries group by status;

-- Document rows must match what is in the bucket. A row whose object is gone
-- is a broken promise to whoever uploaded it.
select count(*) as documents, count(*) filter (where deleted_from_storage_at is null) as live
from documents;

-- Accounts, and whether their second factor survived.
select count(*) as users, count(*) filter (where mfa_enabled_at is not null) as with_mfa
from users;
```

### 4. Verify row-level security survived

The most easily lost property in a restore, because policies and roles are not
table data. `pg_restore --no-owner --no-privileges` deliberately drops
ownership and grants, so they have to be re-applied:

```bash
DATABASE_URL=postgresql://bos:<password>@<host>:5432/bos_restore_test pnpm db:migrate
```

That re-applies `rls.sql` and `grants.sql`, both idempotent. Then check:

```sql
select table_name, rls_enabled, rls_forced
from rls_coverage
where has_workspace_id and not (rls_enabled and rls_forced);
-- Zero rows. Anything here is a table restored without its tenant boundary.
```

And confirm the application role exists and is still least-privilege:

```sql
select rolname, rolsuper, rolbypassrls, rolcanlogin
from pg_roles where rolname = 'bos_app';
-- rolsuper = f, rolbypassrls = f. Anything else and RLS does not bind it.
```

### 5. Run the isolation tests against the restored database

```bash
DATABASE_URL=postgresql://bos:<password>@<host>:5432/bos_restore_test \
  pnpm --filter @bos/database run test
```

### 6. Point a real API at it

The check that catches everything the queries above miss:

```bash
DATABASE_URL=postgresql://bos_app:<password>@<host>:5432/bos_restore_test \
  pnpm --filter @bos/api start
curl -s localhost:4000/ready
```

### 7. Write it down and tear it down

Record the date, the backup's timestamp, the wall-clock restore time, and
anything that did not work. Then:

```bash
dropdb bos_restore_test
```

A drill whose result is not written down is a drill that will be run from
memory next time, under pressure, by somebody who was not there.

---

## Recovering from an actual failure

**Database lost or corrupted**

1. Stop the API — every write from here on is a write you will lose.
2. Restore to a new instance (point-in-time, to just before the failure).
3. Re-apply `pnpm db:migrate` for policies, grants and the app role.
4. Verify with the queries above, particularly `rls_coverage`.
5. Repoint `DATABASE_URL` and restart.
6. `pnpm smoke` before announcing recovery.

**A document deleted by mistake**

R2 versioning. The `documents` row and the `document_access_log` will show what
happened and when.

**A leaked credential**

- `EDGE_SHARED_SECRET`: rotate on the API, the site and the Worker together.
  They must match, so there is an overlap window of exactly zero — do it in a
  maintenance minute.
- `AUTH_SESSION_SECRET`: rotating it invalidates every cookie signature, so
  everybody is signed out. That is the intended effect.
- Database or R2 credentials: rotate at the provider, then update the host.
- Then read `audit_log` and `document_access_log` for the window the credential
  was exposed. That is what they are for.
