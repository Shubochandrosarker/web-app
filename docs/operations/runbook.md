# Operations runbook

The boring commands for when something is wrong at 2am. Everything here is
executable as written; if a step stops matching reality, fix the step in the
same change that changed reality.

## The moving parts

| Component   | What it is                                 | Health check                                            |
| ----------- | ------------------------------------------ | ------------------------------------------------------- |
| API         | Fastify, `apps/api/dist/server.js`         | `GET /health` (process), `GET /ready` (DB+Redis+outbox) |
| Site        | Next.js, `apps/site`                       | `GET /` returns 200                                     |
| Dashboard   | Next.js, `apps/dashboard`                  | `GET /sign-in` returns 200                              |
| Edge Worker | Cloudflare Worker (collector, cron, queue) | `wrangler tail`                                         |
| Postgres 16 | The system of record, RLS enforced         | `pg_isready`                                            |
| Redis       | Access tokens, rate limits, dispatch lease | `redis-cli ping`                                        |

## Internal job endpoints

All under `/v1/internal/jobs/*`, authenticated by `x-bos-edge-secret`. The
cron calls them nightly; **you can call any of them manually** during an
incident — they are idempotent by construction.

```sh
SECRET='<EDGE_SHARED_SECRET>'
API='https://<api-host>'
for job in outbox.dispatch automations.resume analytics.rollup gsc.ingest \
           documents.retention_sweep seo.audit_refresh; do
  curl -fsS -X POST -H "x-bos-edge-secret: $SECRET" "$API/v1/internal/jobs/$job"
done
```

## Scenarios

### Confirmations are not going out

1. `GET /ready` — the outbox section reports queue depth and dead count.
2. Depth growing? The in-process dispatcher may have died with the instance:
   `POST /v1/internal/jobs/outbox.dispatch` drains manually; restarting the
   API restarts the loop.
3. Dead events (`status = dead` in `event_outbox`): read `last_error` on the
   rows — it carries the provider's rejection verbatim. Fix the cause
   (provider credentials, template id), then
   `POST /v1/internal/jobs/outbox.requeue` with `{"workspace": "<slug>"}`.

### An automation is misbehaving

- Dashboard → Automations → the run history names the failed step, the
  attempt count and the exact failure reason; **Retry** re-arms only the
  failed step. Turning an automation **off** stops new enrollments
  immediately without touching in-flight runs.
- Runs stuck `waiting` past their time: `POST /v1/internal/jobs/automations.resume`
  (the dispatcher does this every few seconds when healthy).

### Documents stuck "being checked"

- `POST /v1/internal/jobs/documents.retention_sweep` re-queues errored scans
  and pays down the verdict debt. If ClamAV is down, `DOCUMENT_SCANNER`'s
  host/port and the clamd service are the first things to check — downloads
  stay blocked (fail closed) until scans succeed, which is correct.

### Redis is gone

Sessions' access tokens and rate limits live there. Refresh tokens are in
Postgres, so signed-in users recover on their next silent refresh once Redis
returns. Nothing needs rebuilding; start Redis, watch `/ready`.

### Postgres failover / restore

Follow docs/operations/backup-restore.md. After any restore:
`pnpm run db:migrate` is a no-op when current (safe to run), then walk the
smoke test against the restored stack before opening traffic.

### A deploy went wrong

Roll back to the previous artifact (both Next apps and the API bundle are
stateless); migrations are additive by policy, so the previous code runs
against the new schema. Never roll back the database to undo a deploy.

### Search Console stopped ingesting

`POST /v1/internal/jobs/gsc.ingest` returns per-dimension counts or the
error verbatim. A `403` from Google means the service account lost access to
the property; re-grant it in Search Console (Settings → Users).

## Logs

The API logs JSON to stdout with request ids; every error response carries
the same id, so "it failed, id abc123" is a log query
(`… | grep abc123`). Credentials are redacted at the logger level.
`audit_log` records who did what to which record — first stop for "who
changed this".

## Routine maintenance

- Nightly (cron, automatic): outbox drain, automation resume, analytics
  rollup, GSC ingest, document retention sweep, scheduled publishing.
- Weekly (a person, five minutes): dashboard → Automations for failed runs;
  `/seo` for new criticals; Dependabot PRs.
- Monthly: restore drill per docs/operations/backup-restore.md; review
  `audit_log` for surprises; rotate the edge shared secret if staff changed.
