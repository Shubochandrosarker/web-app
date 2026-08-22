# Final build report

State of the platform at the current closeout build
(branch `feat/business-os-final-closeout`, continuing from the repository's
latest `main`).
The companion [`FINAL-TEST-REPORT.md`](./FINAL-TEST-REPORT.md) carries the
verification evidence; [`owner-input-required.md`](./owner-input-required.md)
carries everything that still needs a fact only the owner has.

## What the platform now is

A multi-tenant Business OS: public site (Next.js), staff dashboard
(Next.js), API (Fastify), edge Worker (Cloudflare), Postgres 16 under
row-level security, Redis — one build, many businesses, each defined by a
directory under `configs/`.

### Delivered, end to end (UI + API + tests)

- **Security foundation** — route-classification boot guarantee, atomic
  refresh rotation with family-reuse revocation, HttpOnly-cookie-only
  browser sessions, Turnstile, trustProxy hardening, RLS everywhere,
  redaction at the logger. (PR #5, hardened further here.)
- **Sessions** — silent refresh in the dashboard proxy, device list, revoke,
  sign-out-everywhere, MFA.
- **Private documents** — claim tokens, real content verification
  (magic bytes, size, SHA-256), scanner abstraction, clean-only downloads
  with audit-before-URL, retention sweeps.
- **CMS v2** — schema-driven per-field section editor, autosave, revisions
  with undoable restore, draft preview links, SEO panel, and scheduled
  publication with a date-time picker (the cron publishes on time).
- **Media** — library UI; `next/image` with a Cloudflare Image
  Transformations loader: responsive AVIF/WebP variants derived at the edge,
  no image CPU on the app server.
- **Forms** — visual builder with invariants enforced at save; public
  endpoint with layered spam defence; **true progressive enhancement**: the
  native no-JS POST goes to a site route that normalises FormData into the
  same JSON contract and renders a server-side confirmation page.
- **CRM** — leads board and detail, contacts, tasks, documents review
  centre, operational home dashboard, audit log.
- **Communications** — email provider adapters; WhatsApp end to end: signed
  Meta webhook, delivery receipts walking message status, inbound replies
  landing on the right enquiry, template-only staff sends, channel screens
  with failure filters.
- **Automation** — a durable workflow engine (every pause is a database row;
  branch decisions recorded and replayed; per-step retry with backoff;
  dead-letter with reason; manual retry re-arms exactly the failed step;
  idempotent sends keyed `auto:{run}:{step}`; re-entry dedupe) and a visual
  builder with zero JSON anywhere, immutable versioning, and per-step run
  history in words.
- **Analytics** — first-party, cookieless collection (already in PR #5) now
  with the product on top: traffic overview with previous-period deltas and
  a day-by-day series, sources down to the specific AI assistant, top pages,
  conversion funnel by source/service/landing page.
- **Search Console** — service-account ingestion (JWT via node:crypto, no
  SDK) into `search_console_daily`, idempotent over a trailing window;
  dashboard screen with three honest states and impression-weighted
  positions.
- **SEO intelligence** — deterministic audit (broken links, orphans, thin
  content, duplicate titles, metadata, alt text, FAQ coverage) with
  plain-language explanations and deliberately **no composite score**; GSC
  opportunity detection (striking distance, low CTR); JSON-LD page graph
  (Organization/WebSite/WebPage/LocalBusiness/Breadcrumb/Service/Article/
  FAQ) live on every page.
- **AI assistant** — pluggable provider (anthropic | openai | workers_ai |
  none), suggestions a human reviews, a system prompt that forbids inventing
  business facts, and no code path from model output to published content.
- **WordPress adapter** — real: canonical-link path resolution, rendered
  HTML sanitised with the CMS's own policy, stable derived ids, pagination.
- **Business catalogue and local SEO** — permissioned Services and Locations
  CRUD, archive/duplicate flows, canonical NAP fields and a dashboard coverage
  view. Demo and fixture configurations are excluded from release eligibility.
- **Scheduling** — permissioned appointment list/detail/create/reschedule/status
  and cancellation flows over the existing availability and appointment schema.
- **Reviews** — permissioned review capture, moderation, approval state and
  response fields, with approved-only public reference loading preserved.
- **Landing pages** — a dedicated dashboard projection over the existing CMS
  landing-page content type, including creation, filtering and row actions.
- **Multi-tenancy proven** — a second (deliberately fictional) tenant
  provisions end to end with different country, currency, modules and
  vocabulary; core code carries no `+880`, no `education_service`, no
  Bangladesh assumption (regression-tested).
- **CI** — format/lint/typecheck/build, full test suites against real
  Postgres+Redis, a smoke job that boots the **compiled API bundle** plus
  both Next builds and walks the vertical slice, Playwright accessibility +
  keyboard e2e on desktop and mobile viewports, Lighthouse budgets
  (perf ≥ 90, a11y ≥ 95, seo ≥ 95), CodeQL, Dependabot, dependency audit —
  and a separate **release gate** (`release.yml`) where the tenant-readiness
  check and the audit are binding rather than advisory.

### Delivered as scaffold (owner-gated by policy)

- **NuESheba pages (TASK-301/302)** — the full draft page architecture
  exists (`pnpm --filter @bos/api scaffold-content nuesheba`), every
  placeholder an explicit `[OWNER: …]` marker; service pages generate from
  the services table. Nothing publishes until a person supplies the facts.
  This is the owner-fact policy working as designed, not a shortcut.

### Closed since this report was first written

The orders gap named here is closed: orders, order items and payments have
their tables, migration and FORCE'd RLS; item rows snapshot the catalogue at
order time; statuses move along an explicit transition map; manual payments
(cash, bank transfer, bKash, Nagad) are attributed staff records behind a
PaymentProvider abstraction that requires no gateway credentials, with
verify and refund flows and events through the outbox. `/orders` is live in
navigation, and no module is marked pending any more. The later closeout
phases also added the scheduling engine (availability, capacity, conflicts,
reminders), cron-triggered automations, attribution/revenue analytics,
AEO/GEO audit checks, global search, notifications, team operations, the
audit log screen and a third fixture tenant (`demo-tours`) exercising the
operations stack. The current state lives in
[`FINAL-PRODUCTION-READINESS.md`](./FINAL-PRODUCTION-READINESS.md).

### Explicitly still incomplete

NuESheba is not production-ready until the real owner facts and provider
credentials in `docs/owner-input-required.md` are supplied and the staging,
backup, browser and provider checks in the go-live runbook are executed.

## Operational readiness

- Runbook, incident response, threat model, backup/restore drill record:
  `docs/operations/`, `docs/security/threat-model.md`.
- Nightly cron: outbox drain, automation resume, analytics rollup, GSC
  ingest, retention sweep, scheduled publishing — every job also manually
  callable during an incident.

## What stands between here and the public NuESheba launch

All of it is in `docs/owner-input-required.md` with safe temporary behaviour
per item. The short version: real NAP + legal wording, the service
catalogue and page copy, provider credentials (email, WhatsApp, Turnstile,
GSC), production infrastructure (Postgres, Redis, hosting, DNS), the old-site
URL inventory for the 301 map, one executed restore drill, and the release
gate run green. None of it is engineering; all of it is recorded.
