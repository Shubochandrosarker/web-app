# Implementation tasks

30 tasks across 8 phases. Each has a stated scope, dependencies and acceptance
criteria, so "done" is a check somebody else can run rather than an opinion.

Estimates are for one experienced full-stack developer, in working days. They
assume the architecture in [`docs/architecture/`](../architecture/) is followed
rather than re-litigated per task.

## Board

| ID           | Task                                    | Phase | Depends on | Est.    |
| ------------ | --------------------------------------- | ----- | ---------- | ------- |
| **TASK-101** | ~~Monorepo, tooling, CI~~               | 1     | —          | ✅ done |
| **TASK-102** | ~~Database schema, migrations, RLS~~    | 1     | 101        | ✅ done |
| **TASK-103** | ~~Contract packages~~                   | 1     | 101        | ✅ done |
| **TASK-104** | ~~Authentication and sessions~~         | 1     | 102        | ✅ done |
| **TASK-105** | ~~RBAC and permission enforcement~~     | 1     | 104        | ✅ done |
| **TASK-106** | ~~Workspace provisioning and settings~~ | 1     | 105        | ✅ done |
| **TASK-107** | ~~Dashboard shell and auth flow~~       | 1     | 105        | ✅ done |
| **TASK-108** | ~~Observability: logging, probes~~      | 1     | 104        | ✅ done |
| **TASK-201** | ~~Content authoring API~~               | 2     | 105        | ✅ done |
| **TASK-202** | ~~Section editor — per-field forms~~    | 2     | 201, 107   | ✅ done |
| **TASK-203** | ~~Media library and image pipeline~~    | 2     | 201        | ✅ done |
| **TASK-204** | ~~Cache tags, publish invalidation~~    | 2     | 201        | ✅ done |
| **TASK-205** | ~~Remaining section renderers~~         | 2     | 103        | ✅ done |
| **TASK-206** | ~~Design system from brand tokens~~     | 2     | 205        | ✅ done |
| TASK-207     | SEO entity graph and JSON-LD wiring     | 2     | 201        | 4       |
| **TASK-208** | ~~Sitemaps, redirects, IndexNow~~       | 2     | 201        | ✅ done |
| **TASK-209** | ~~Form _builder_ UI~~                   | 2     | 201        | ✅ done |
| TASK-210     | WordPress content adapter               | 2     | 201        | 4       |
| TASK-301     | NuESheba config, branding, navigation   | 3     | 206        | 2       |
| TASK-302     | NuESheba service pages and guides       | 3     | 205, 301   | 6       |
| **TASK-303** | ~~Service request form and upload~~     | 3     | 209, 404   | ✅ done |
| **TASK-401** | ~~Contacts UI~~                         | 4     | 105        | ✅ done |
| **TASK-402** | ~~Leads, pipeline, tasks, timeline~~    | 4     | 401        | ✅ done |
| **TASK-403** | ~~Lead capture from forms~~             | 4     | 402, 209   | ✅ done |
| **TASK-404** | ~~Private documents — UI and scanning~~ | 4     | 401        | ✅ done |
| **TASK-501** | ~~Event outbox and dispatcher~~         | 5     | 402        | ✅ done |
| **TASK-502** | ~~Email provider adapter and sending~~  | 5     | 401        | ✅ done |
| **TASK-503** | ~~Automation engine~~                   | 5     | 501, 502   | ✅ done |
| **TASK-504** | ~~Automation builder UI~~               | 5     | 503, 107   | ✅ done |
| **TASK-505** | ~~WhatsApp — templates and inbound~~    | 5     | 502        | ✅ done |
| **TASK-601** | ~~Analytics collection and ingestion~~  | 6     | 501        | ✅ done |
| **TASK-602** | ~~Channel resolution and attribution~~  | 6     | 601, 402   | ✅ done |
| **TASK-603** | ~~Analytics dashboard~~                 | 6     | 602, 107   | ✅ done |
| **TASK-604** | ~~Search Console ingestion~~            | 6     | 601        | ✅ done |
| TASK-701     | SEO audit engine                        | 7     | 207, 604   | 6       |
| TASK-702     | AI content suggestions                  | 7     | 701        | 5       |
| TASK-801     | Second tenant extraction                | 8     | 603        | 5       |

◑ marks a task that is partly done: the mechanism exists and is tested, and
what remains is a user interface for it. The estimate shown is what is left.

## What "done" means for the launch

The completed rows above are the **production vertical slice**: a visitor finds
a service page, submits a request, becomes a CRM lead with a confirmation, and
staff work it from the dashboard — with authentication, RBAC, tenant isolation,
sanitisation, a real CSP and a smoke test around it.

What remains is the analytics dashboard and Search Console ingestion
(TASK-603/604), the SEO intelligence layer (TASK-207/701/702), the WordPress
adapter (TASK-210), the second tenant (TASK-801), and NuESheba's real content
and configuration (TASK-301/302 — gated on owner facts recorded in
[`docs/owner-input-required.md`](../owner-input-required.md)). None of the
engineering items block the platform being deployable; the owner-fact items
block the public NuESheba launch specifically.

## Detail

- [Phase 1 — Foundation](phase-1-foundation.md)
- [Phase 2 — CMS and website](phase-2-cms-and-website.md)
- [Phase 3 — NuESheba](phase-3-nuesheba.md)
- [Phase 4 — CRM](phase-4-crm.md)
- [Phase 5 — Automation](phase-5-automation.md)
- [Phase 6 — Analytics](phase-6-analytics.md)
- [Phases 7-8 — Intelligence and reuse](phase-7-8-intelligence-and-reuse.md)

## Conventions

**Every task is done when:** it typechecks, it has tests for the behaviour that
would be expensive to get wrong, CI is green, and the architecture docs are
updated if the task changed a decision.

**Tasks that touch tenant data** must include an RLS test proving isolation.
`packages/database/tests/rls.test.ts` is the pattern.

**Tasks that add a table** must add `workspace_id` unless there is a documented
reason not to — `sql/rls.sql` discovers policies by that column, so an omission
means the table ships unprotected.

**Tasks that add an event** must add it to `@bos/events` first. The catalogue is
the contract; a string literal in a handler is not.
