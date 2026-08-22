# Final test report

Verification evidence for the state described in
[`FINAL-BUILD-REPORT.md`](./FINAL-BUILD-REPORT.md). Every number below is
from a full local run against real Postgres 16 and Redis on 2026-08-22; CI
runs the same suites on every push.

## Totals

| Suite                                     | Tests   | Result         |
| ----------------------------------------- | ------- | -------------- |
| `@bos/api` (integration, real DB + Redis) | 127     | ✅ all passing |
| `@bos/sanitize`                           | 20      | ✅             |
| `@bos/content` (WordPress adapter)        | 6       | ✅             |
| `@bos/database` (RLS isolation)           | 5       | ✅             |
| `@bos/business-types` (tenant configs)    | 3       | ✅             |
| Playwright e2e (desktop + mobile)         | 10      | ✅             |
| **Total**                                 | **171** | **✅**         |

Also green on the same run: `pnpm typecheck` (14 projects), `pnpm lint`
(eslint, zero warnings surfaced as errors), `pnpm build` (site, dashboard,
API bundle), `prettier --check`, and the compiled API bundle
(`node dist/server.js`) booting and serving `/health`.

## What the API suite actually proves (by area)

Integration tests run against real Postgres with RLS enforced under the
least-privilege `bos_app` role — the harness **refuses** superuser
connections so isolation tests cannot pass vacuously.

- **Auth & sessions** — password auth, MFA challenge, refresh rotation with
  family-reuse revocation under concurrency, cookie-only browser transport
  (no token ever in JSON for cookie clients), session list/revoke,
  cross-user revocation is 404.
- **Route classification** — the collector-before-registration guarantee,
  boot failure on unclassified or zero collected routes, runtime fail-closed 403.
- **Tenant isolation** — RLS proofs per table pattern; cross-workspace reads
  return 404; the second-workspace fixtures exercise real cross-tenant
  attempts.
- **Documents** — claim-token lifecycle, content verification, scan
  gating, clean-only downloads, audit-before-URL, denial audit surviving
  rollback, retention sweep under RLS (a real latent bug this suite caught).
- **Forms & leads** — stored-definition validation, spam scoring, idempotent
  lead creation, attribution, notification via outbox exactly once, internal
  endpoints refusing a wrong secret, **tenant-neutral phone handling** (a
  tenant with no configured country code accepts only international
  numbers — the no-Bangladesh-assumption regression test).
- **CMS** — draft/publish/schedule flows, revisions, preview tokens,
  sanitisation at the write boundary.
- **Communications** — Meta webhook handshake, signature refusal, delivery
  receipts walking status, failed receipts carrying the provider reason,
  inbound replies matched to contact and their single open lead, replay
  producing one row.
- **Automation** (9 tests) — enrollment from a real outbox event with
  context templating, re-entry dedupe, branch decisions recorded and the
  right tag applied, a durable wait parked in the database and resumed by
  the job, retry → backoff → dead-letter with reason → manual retry to
  completion with exactly one idempotent send, RBAC (staff 403 / manager
  read / admin write), immutable versioning, duplicate-step-id refusal.
- **Analytics** (4 tests) — live overview totals merged with the rollup's
  day series, channel/source breakdowns including AI referrals, funnel
  attribution, and GSC ingestion against a scripted Google (really-signed
  JWT, real upsert, idempotent re-ingest, aggregation with
  impression-weighted position).
- **SEO** (3 tests) — the audit over a deliberately imperfect content set
  (planted orphan, thin page, duplicate titles, broken link, FAQ-less
  service — each caught, healthy pages not), GSC opportunity
  classification, and the unconfigured-AI path explaining itself.

## End-to-end (Playwright, against the running stack)

Run on desktop Chrome and a Pixel 7 viewport, 10/10 passing:

- Home page, service page (with the live request form) and dashboard
  sign-in have **zero serious or critical axe violations** against
  WCAG 2.1/2.2 A+AA rulesets.
- The request form is completable with the keyboard alone (focus walk to
  submit, no pointer events).
- Dashboard sign-in is keyboard-operable.

CI additionally runs Lighthouse on `/` and the smoke service page:
accessibility ≥ 95 is binding (observed 100); the performance score is
printed on every run but advisory there — shared runners scored identical
code 90 and 81 back to back — with the binding ≥ 95 performance bar being
the staging run in the go-live checklist. The SEO category is only
meaningful on an indexable deployment, so it too belongs to staging.

## Honest limits of this report

- Automated accessibility scanning catches roughly half of WCAG; a manual
  screen-reader pass is on the go-live checklist.
- The smoke stack runs the compiled API with `NODE_ENV=development` (the
  production guard rightly refuses CI's fake providers); the guard itself is
  unit-tested.
- Provider integrations (Meta send, Resend/SMTP, Google) are tested against
  scripted counterparts; the first real-credential sends are a staging
  checklist item.
- The restore drill has a procedure and a record table but has not been
  executed against production infrastructure, because none exists yet —
  recorded as a launch blocker, not glossed.
