# Final closeout — baseline

Recorded 2026-08-22, at the start of the final-closeout work. This is the
verified state of `main` the closeout branch builds on, so every later claim
of progress has a fixed point to be measured against.

A note on sequence: the closeout started against `4fe4c57` (the merge of
PR #6). While its first phase was in flight, PR #10 — a parallel closeout
pass — merged into `main`, bringing the Services, Appointments, Reviews,
Local SEO, Landing Pages and Locations management surfaces plus a first cut
of release eligibility. The branch was restarted from that head and the two
release-gate implementations were unified into one (see gap 1).

## Where main stands

| Fact              | Value                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `main` SHA        | `1ce1cbd` (merge of PR #10; ancestors: PR #6 `4fe4c57`, Dependabot PRs #7–#9)                                          |
| Version           | 0.1.0                                                                                                                  |
| Apps              | `site`, `dashboard`, `api`, `edge`                                                                                     |
| Packages          | `automation`, `business-types`, `config`, `content`, `database`, `events`, `sanitize`, `sections`, `seo`, `validation` |
| Tenant configs    | `nuesheba` (production, release-eligible), `demo-consultancy` (fixture, never released)                                |
| Tests at baseline | 175 unit/integration (api 127→132 with closeout, sanitize 20, content 6, database 5, business-types 7→17) + 10 e2e     |
| CI                | Green on the merged heads of PR #6 and PR #10                                                                          |
| CodeQL            | Green — zero open alerts after the polynomial-redos and URL-sanitization fixes                                         |
| Release Gate      | `release.yml` names `nuesheba` explicitly; readiness in CI stays advisory                                              |

Verification commands, as CI runs them: `pnpm format:check && pnpm lint &&
pnpm typecheck && pnpm build`, `pnpm test` (real Postgres 16 + Redis, RLS
enforced, superuser refused), `pnpm e2e`, `pnpm check:readiness`.

## Gaps found at baseline

### 1. Release-gate logic (P0 — fixed first on this branch)

At `4fe4c57` the readiness sweep treated every config under `configs/`
equally — the demo fixture's deliberate placeholders and the production
tenant's real gaps produced the same kind of failure — and nothing marked
which tenant a release is _for_, so a tenant could be skipped silently.

Both closeout passes introduced `environment.releaseEligible`; the unified
implementation on this branch keeps one selection function
(`selectReleaseTargets` in `@bos/business-types`) with the strict
semantics: a **named** tenant is release intent and must exist _and_ be
eligible (naming a fixture fails loudly instead of acting as an override);
a **bare sweep** gates only eligible tenants and reports fixtures
informationally; `--release-eligible` with zero eligible tenants is an
error, not a green run. `release.yml` names `nuesheba` explicitly.

### 2. Readiness policy vs. reality

Blockers the policy did not encode at `4fe4c57`: a fixture `siteUrl`
domain, `whatsappAcknowledgement` enabled with no WhatsApp number, a
missing independence disclaimer on an `education_service` tenant, and
`documentUpload` enabled with no privacy policy. All four are blockers in
`production-readiness.ts` now, with tests.

### 3. Documentation truth

- `docs/owner-input-required.md` said `sameAs` was not a production blocker
  while the policy (correctly) blocks an Organization node with zero
  corroborating profiles; it referenced a stale `pnpm readiness` command
  and had no row for the privacy/data-handling policy. Corrected.
- The root README's command table and layout tree are kept current with the
  release-eligibility posture and both tenant configs.
- `docs/tasks/README.md` and the go-live runbook were accurate.

### 4. Engineering gaps (the work of this branch)

Still open after PR #10, in prompt order: **orders/transactions** (schema,
migration, PaymentProvider abstraction with a manual/offline provider —
deliberately absent so far); scheduling depth (availability rules, admin
calendar, reminders) beyond the appointments CRUD that landed; landing-page
campaign fields and conversion data; review-request workflows and schema
policy enforcement; local-SEO checks beyond the screen scaffold;
team/user operations (invites, roles, MFA status, sessions);
automation-as-product (schedule trigger, clone, metrics, failed-run queue,
send limits); analytics date-range/attribution/revenue; Search Console
settings UX; AEO/GEO audit categories; AI-assistant accept-into-draft flow;
WordPress adapter diagnostics; global search; notifications centre;
audit-log UX; a second rich fixture tenant; plus the closing sweeps — RLS
review for new surfaces, migrations from zero, normalized errors, residual
markers, final docs.

### 5. Owner-gated gaps (documented, never fabricated)

Everything in `docs/owner-input-required.md`: real NAP facts, legal
identity and disclaimer wording, verified service catalogue and page copy,
old-site URL inventory for the redirect map, provider credentials (email,
WhatsApp, Search Console, Cloudflare/R2/Turnstile), production
database/Redis/host/DNS, and the owner's account + MFA enrolment at
go-live. The platform holds safe behaviour (log-mode providers, draft-only
content, the `[OWNER: …]` publish guard) until each arrives.

### 6. Deployment gaps

Staging is not deployed; real-provider integration tests have not run
(mock-based tests do not count as production verification); the restore
drill is written but **not executed**; production deployment and DNS
cutover have not happened. Each stays open until the infrastructure and
credentials exist, and each is listed in the go-live runbook as a hard
step.
