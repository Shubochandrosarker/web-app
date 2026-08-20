# Implementation tasks

30 tasks across 8 phases. Each has a stated scope, dependencies and acceptance
criteria, so "done" is a check somebody else can run rather than an opinion.

Estimates are for one experienced full-stack developer, in working days. They
assume the architecture in [`docs/architecture/`](../architecture/) is followed
rather than re-litigated per task.

## Board

| ID           | Task                                      | Phase | Depends on | Est.    |
| ------------ | ----------------------------------------- | ----- | ---------- | ------- |
| **TASK-101** | ~~Monorepo, tooling, CI~~                 | 1     | —          | ✅ done |
| **TASK-102** | ~~Database schema, migrations, RLS~~      | 1     | 101        | ✅ done |
| **TASK-103** | ~~Contract packages~~                     | 1     | 101        | ✅ done |
| TASK-104     | Authentication and sessions               | 1     | 102        | 5       |
| TASK-105     | RBAC and permission enforcement           | 1     | 104        | 3       |
| TASK-106     | Workspace provisioning and settings       | 1     | 105        | 3       |
| TASK-107     | Dashboard shell and auth flow             | 1     | 105        | 4       |
| TASK-108     | Observability: logging, metrics, errors   | 1     | 104        | 2       |
| TASK-201     | Content authoring API                     | 2     | 105        | 5       |
| TASK-202     | Section editor in the dashboard           | 2     | 201, 107   | 8       |
| TASK-203     | Media library and image pipeline          | 2     | 201        | 4       |
| TASK-204     | ISR, cache tags, publish invalidation     | 2     | 201        | 3       |
| TASK-205     | Remaining section renderers               | 2     | 103        | 4       |
| TASK-206     | Design system from brand tokens           | 2     | 205        | 5       |
| TASK-207     | SEO entity graph and JSON-LD wiring       | 2     | 201        | 4       |
| TASK-208     | Sitemaps, redirects, IndexNow             | 2     | 201        | 3       |
| TASK-209     | Forms: builder, submission, spam controls | 2     | 201        | 5       |
| TASK-210     | WordPress content adapter                 | 2     | 201        | 4       |
| TASK-301     | NuESheba config, branding, navigation     | 3     | 206        | 2       |
| TASK-302     | NuESheba service pages and guides         | 3     | 205, 301   | 6       |
| TASK-303     | Service request form and document upload  | 3     | 209, 404   | 4       |
| TASK-401     | Contacts and companies                    | 4     | 105        | 4       |
| TASK-402     | Leads, pipeline, tasks, timeline          | 4     | 401        | 6       |
| TASK-403     | Lead capture from forms                   | 4     | 402, 209   | 2       |
| TASK-404     | Private document store                    | 4     | 401        | 5       |
| TASK-501     | Event outbox and dispatcher               | 5     | 402        | 3       |
| TASK-502     | Email provider adapter and sending        | 5     | 401        | 4       |
| TASK-503     | Automation engine                         | 5     | 501, 502   | 8       |
| TASK-504     | Automation builder UI                     | 5     | 503, 107   | 6       |
| TASK-505     | WhatsApp channel                          | 5     | 502        | 4       |
| TASK-601     | Analytics collection and ingestion        | 6     | 501        | 4       |
| TASK-602     | Channel resolution and attribution        | 6     | 601, 402   | 4       |
| TASK-603     | Analytics dashboard                       | 6     | 602, 107   | 5       |
| TASK-604     | Search Console ingestion                  | 6     | 601        | 3       |
| TASK-701     | SEO audit engine                          | 7     | 207, 604   | 6       |
| TASK-702     | AI content suggestions                    | 7     | 701        | 5       |
| TASK-801     | Second tenant extraction                  | 8     | 603        | 5       |

Roughly 150 developer-days after Phase 1's completed work, or about seven
months for one developer. Phases 2-4 are the critical path; 5-7 can overlap
once the CRM exists.

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
