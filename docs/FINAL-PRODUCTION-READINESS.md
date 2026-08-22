# Final production readiness

The single answer to "can this go live, and what exactly is in the way?" —
split the only honest way: what engineering has finished and verified, what
waits on the owner, and what waits on infrastructure that does not exist
yet. Companion documents: [`FINAL-BUILD-REPORT.md`](./FINAL-BUILD-REPORT.md)
(what was built), [`FINAL-TEST-REPORT.md`](./FINAL-TEST-REPORT.md)
(how it is verified), [`owner-input-required.md`](./owner-input-required.md)
(every owner item, with config fields and verification steps),
[`security/tenant-scope-review.md`](./security/tenant-scope-review.md) and
[`operations/accessibility-review.md`](./operations/accessibility-review.md).

## Engineering — complete and verified

| Area                | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Proof                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Module completeness | Every Business OS module is built — services, scheduling (availability/capacity/conflict engine + reminders), **orders with manual payments**, reviews, local SEO, locations, landing pages, CRM, CMS, media, forms, documents, comms, automations (event + cron triggers, clone, metrics, failed-run queue, send ceiling), analytics (attribution, revenue), SEO/AEO/GEO audit, AI assistant, global search, notifications, team ops, audit log. Nothing is marked pending. | Dashboard navigation; module registry; this branch's commits                                 |
| Multi-tenant proof  | Three tenants from one build: `nuesheba` (education, bn-BD/en, BDT), `demo-consultancy` (US professional service), `demo-tours` (NZ tour operator exercising the full ops stack — services, capacity scheduling, orders in a third currency, reviews)                                                                                                                                                                                                                        | `configs/`; provisioning run recorded in the closeout                                        |
| Tenant isolation    | RLS on all 63 tables carrying `workspace_id`, `FORCE`d, auto-discovered so a new table cannot ship without the predicate; app role least-privilege; every `withoutTenantScope` reviewed and categorised                                                                                                                                                                                                                                                                      | `packages/database/sql/rls.sql`; `security/tenant-scope-review.md`; RLS + cross-tenant tests |
| Release gate        | `environment.releaseEligible` decides who can be released; naming an unknown or fixture tenant fails loudly; `release.yml` names `nuesheba`; policy and `owner-input-required.md` state one identical policy                                                                                                                                                                                                                                                                 | `packages/business-types/src/release.ts` + 18 package tests; the workflows                   |
| Placeholder safety  | Placeholder facts fail readiness; `[OWNER: …]` markers refuse publish **and** schedule; log-mode providers send nothing                                                                                                                                                                                                                                                                                                                                                      | `production-readiness.ts`, publish-guard tests                                               |
| Tests               | 235 automated: 225 unit/integration against real Postgres 16 + Redis as the least-privilege role, 10 Playwright e2e with axe + keyboard                                                                                                                                                                                                                                                                                                                                      | `pnpm test`, `pnpm e2e`; CI                                                                  |
| Migrations          | Fresh-from-zero verified (63 tables, RLS, grants) — recorded in the closeout run and re-proven by CI's fresh-database job every commit                                                                                                                                                                                                                                                                                                                                       | `pnpm db:migrate` on a scratch database                                                      |
| Supply chain / CI   | Full-tree format, lint, typecheck, build, migration drift, compiled-boot smoke, vertical slice, e2e, Lighthouse (a11y binding), CodeQL, Dependabot, dependency audit (binding at release)                                                                                                                                                                                                                                                                                    | `.github/workflows/`                                                                         |

## Owner-gated — documented, never fabricated

Everything in [`owner-input-required.md`](./owner-input-required.md), with
per-item config fields and verification steps. Headline blockers: real NAP
facts, legal identity + independence disclaimer + privacy policy wording,
the verified service catalogue and page copy (the publish guard holds until
markers are replaced), the old-site URL inventory for the redirect map, and
the provider/infrastructure credentials.

## Deployment — waits on infrastructure that does not exist yet

| Step                                                      | State                                                                                            | Where it is defined                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Staging deploy                                            | ⏳ not deployed — no host/credentials exist                                                      | `docs/deployment/` runbooks               |
| Real-provider tests (email, WhatsApp, R2, Turnstile, GSC) | ⏳ not run — mocked counterparts are **not** production verification and are not claimed as such | `FINAL-TEST-REPORT.md`; go-live checklist |
| Restore drill                                             | ⏳ written, **never executed** — a backup nobody has restored from is a hypothesis               | `operations/backup-restore.md`            |
| Manual accessibility pass                                 | ⏳ not performed (automated layer green)                                                         | `operations/accessibility-review.md`      |
| Staging Lighthouse on real hardware                       | ⏳ pending staging                                                                               | go-live checklist                         |
| Production deploy + DNS cutover                           | ⏳ blocked until every gate above is green; first deploy with `BOS_ALLOW_INDEXING=false`         | `deployment/go-live.md`                   |

## The order to launch

1. Owner supplies the facts and credentials (table above) — engineering is
   not the bottleneck from here.
2. Staging: deploy, run the real-provider tests, the restore drill, the
   manual accessibility pass, Lighthouse on real hardware.
3. `pnpm check:readiness nuesheba` green + Release Gate workflow green.
4. Production deploy noindexed → verify → URL migration import + one-hop
   verification → DNS cutover → flip indexing on → post-launch checks.

Nothing in this document rounds up. Where a step has not happened, it says
so.
