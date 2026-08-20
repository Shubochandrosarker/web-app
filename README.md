# Business OS

A reusable **Business Operating System**: one platform running a business's
public website, content, CRM, scheduling, messaging, automations and analytics —
deployed per client from one codebase, with everything client-specific living in
configuration.

NuESheba is the first tenant. It is `configs/nuesheba/business.json` and nothing
else — no file under `apps/` or `packages/` names it.

> **Naming is provisional.** The scope is `@bos/*` and docs say "Business OS".
> `Businessistic Core` fits the existing `-istic` family (WPistic, Chatbotistic,
> Licenseistic, Memberistic) and is the recommendation, but it is a
> find-and-replace and nothing waits on it. See ADR-0001.

## Layout

```
apps/
├── site/          Public website — Next.js 16 App Router
├── dashboard/     Business dashboard — Next.js, nav derived from modules
├── api/           Business API — Fastify, modules mounted per workspace
└── edge/          Cloudflare Worker — analytics, webhooks, queues, cron

packages/
├── database/      Drizzle schema, migrations, RLS, the bos_app role
├── business-types/ Module registry, 11 business-type presets, config resolution
├── sections/      The 17 section schemas — the page-builder contract
├── content/       ContentProvider interface + internal / wordpress / markdown
├── seo/           Metadata, JSON-LD graph, sitemaps, IndexNow
├── automation/    Trigger / condition / action definition language
├── events/        The 38-event canonical catalogue
├── validation/    Shared Zod primitives and attribution shapes
└── config/        Environment schemas, validated at boot

configs/
└── nuesheba/      The first tenant — brand, NAP, locale, modules

docs/
├── architecture/  The V1 blueprint (10 documents)
├── database/      Schema conventions, migrations, RLS verification
└── tasks/         30 implementation tasks across 8 phases
```

## Getting started

```bash
pnpm install

# Postgres 16+, as an owner/admin role
export DATABASE_URL=postgresql://bos@localhost:5432/bos_dev
pnpm db:migrate          # migrations → RLS policies → bos_app role

cp .env.example .env     # then fill it in

pnpm dev                 # site :3000 · dashboard :3001 · api :4000
```

The application must connect as `bos_app`, **not** as the migration role — see
[the database README](docs/database/README.md) for why that is load-bearing
rather than a nicety.

## Commands

|                    |                                               |
| ------------------ | --------------------------------------------- |
| `pnpm dev`         | All apps in watch mode                        |
| `pnpm build`       | Build everything (needs `BOS_WORKSPACE_SLUG`) |
| `pnpm typecheck`   | Typecheck every package and app               |
| `pnpm test`        | Run all tests                                 |
| `pnpm db:generate` | Generate a migration after a schema change    |
| `pnpm db:migrate`  | Apply migrations, RLS and grants              |
| `pnpm format`      | Prettier                                      |

## What is built

Phase 1 is complete and **verified end to end** — Postgres with row-level
security → Fastify API → content provider → a Next.js page carrying a connected
JSON-LD graph, split sitemaps and generated robots.

|                  |                                                                        |
| ---------------- | ---------------------------------------------------------------------- |
| Schema           | 58 tables, 19 enums, generated migration, RLS on 56 of 58              |
| Tenant isolation | Verified against a real database, including the superuser failure mode |
| Contracts        | 9 packages: modules, sections, events, content, SEO, automation        |
| Apps             | 4 scaffolded; the content read path is implemented and working         |
| Docs             | 10 architecture documents, 13 ADRs, 30 scheduled tasks                 |

Everything beyond Phase 1 is specified in
[`docs/architecture/`](docs/architecture/00-overview.md) and scheduled in
[`docs/tasks/`](docs/tasks/README.md).

## Design in one paragraph

Workspaces are the tenant boundary, enforced by Postgres row-level security
rather than by application discipline. A workspace enables **modules**, and the
dashboard navigation, the API route table and the site's available sections are
all derived from that set — a client without scheduling has no scheduling
endpoints, not endpoints that return 403. **Business type is a preset**, not a
subclass: it picks default modules and UI vocabulary over identical machinery,
and nothing branches on it at runtime. Content is **structured sections**, not
markup, which is what makes "which service pages have no FAQ?" a query. Modules
**communicate by events** through a transactional outbox, so a lead is never
created without its event and an event never fires for a lead that failed to
save. WordPress is an **optional content source** behind an interface, never the
system of record.

## On expectations

Nothing here makes a site rank quickly, and Google's guidance is explicit that
meeting technical requirements does not guarantee indexing or serving. There is
no structured data, markup or file that makes a page eligible for AI Overviews
or AI Mode.

What this does give every site from day one is the conditions under which good
content _can_ perform — server-rendered pages, fast Core Web Vitals, correct and
consistent structured data, unambiguous canonicals, a coherent internal link
graph, automated indexing notification, and conversion and revenue attribution
good enough to tell which pages are worth improving.

See [04 — SEO and answer engines](docs/architecture/04-seo-and-answer-engines.md).
