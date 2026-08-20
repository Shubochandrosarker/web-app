# V1 Architecture Blueprint

## What this is

A reusable **Business Operating System**: one platform that runs a business's
public website, its content, its CRM, its scheduling, its outbound messaging,
its automations and its analytics — deployed per client from one codebase, with
the client's specifics living entirely in configuration.

NuESheba is the first tenant. It is `configs/nuesheba/business.json` and nothing
else. No file under `apps/` or `packages/` mentions it, and a second client is
another directory in `configs/`, not a fork.

## What it is not

It is not a WordPress site with a large custom plugin. That path is available
and looks cheaper for about six weeks, and then the CRM, the scheduling, the
automations and the analytics all live inside a CMS whose data model was
designed for blog posts — with `wp_postmeta` as the schema for everything, and
an upgrade path that runs through a plugin ecosystem you do not control.

WordPress is supported here as an **optional content source**. It can supply
editorial text and media through its REST API. It has no say in routing,
rendering, SEO output, or anything in the business modules. `@bos/content`
defines a `ContentProvider` interface with three implementations — `internal`,
`wordpress`, `markdown` — and `apps/site` depends only on the interface.
Changing `CONTENT_PROVIDER` changes nothing else.

## Shape

```
                         BUSINESS OS
┌──────────────────────────────────────────────────────────────┐
│                      PUBLIC WEBSITE                          │
│                  apps/site · Next.js 16                      │
│   SSR/ISR · metadata · JSON-LD graph · sitemaps · forms      │
└───────────────────────────┬──────────────────────────────────┘
                            │  ContentProvider (HTTP)
┌───────────────────────────▼──────────────────────────────────┐
│                     BUSINESS API                             │
│                  apps/api · Fastify                          │
│  modules mounted from the workspace's enabled-module list    │
│  CRM · content · scheduling · messaging · documents · SEO    │
└───────────────────────────┬──────────────────────────────────┘
                            │
              PostgreSQL 16 (RLS) + Redis
                            │
        ┌───────────────────┴────────────────────┐
        │                                        │
┌───────▼──────────┐                  ┌──────────▼─────────────┐
│    DASHBOARD     │                  │    CLOUDFLARE EDGE     │
│  apps/dashboard  │                  │       apps/edge        │
│  Next.js         │                  │  analytics ingest      │
│  nav derived     │                  │  webhook receipt       │
│  from modules    │                  │  queue consumer        │
└──────────────────┘                  │  nightly cron          │
                                      └────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│                  OPTIONAL CMS ADAPTER                        │
│  WordPress REST API — editorial content and media only.      │
│  Never controls routing, rendering, SEO or business data.    │
└──────────────────────────────────────────────────────────────┘
```

## The four ideas the rest follows from

**1. Modules, not features.** A workspace enables a set of modules
(`crm.leads`, `ops.scheduling`, `marketing.seo`…). The dashboard navigation,
the API's route table and the site's available sections are all _derived_ from
that set. A client without scheduling has no scheduling endpoints at all —
not endpoints that return 403.

**2. Business type is a preset, not a subclass.** `education_service` and
`tour_operator` choose different default modules and different UI vocabulary —
"Consultation" versus "Departure" — over identical machinery. Nothing in the
platform may branch on business type at runtime. A conditional that wants to
belongs in a module or a setting.

**3. Content is structured data, not markup.** A page is an ordered list of
validated sections (`@bos/sections`). Editors choose sections and fill in
fields; they never choose markup or spacing. This is what makes it possible to
ask "which pages have an FAQ section but no process section?" — a question you
cannot ask of a page builder that stores HTML.

**4. Modules communicate by events.** CRM does not call the email module; it
emits `lead.created`, and the automation engine decides what happens. Events go
through a transactional outbox, so a lead is never created without its event
and an event never fires for a lead that failed to save.

## Documents in this blueprint

|                                                                         |                                                                   |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [01 — Decisions](01-decisions.md)                                       | The architectural choices, with what each one costs               |
| [02 — Tenancy and modules](02-tenancy-and-modules.md)                   | Workspaces, business types, module resolution, RBAC               |
| [03 — Content and rendering](03-content-and-rendering.md)               | Provider interface, section registry, caching                     |
| [04 — SEO and answer engines](04-seo-and-answer-engines.md)             | Metadata, entity graph, schema, sitemaps, indexing, AEO structure |
| [05 — Automation engine](05-automation-engine.md)                       | Events, outbox, triggers, durable runs                            |
| [06 — Analytics and attribution](06-analytics-and-attribution.md)       | First-party collection, channel resolution, AI referrals          |
| [07 — Security and data protection](07-security-and-data-protection.md) | RLS, the app role, sensitive documents, retention                 |
| [08 — Deployment topology](08-deployment-topology.md)                   | What runs where, and why not everything is at the edge            |
| [09 — NuESheba V1](09-nuesheba-v1.md)                                   | The first tenant, concretely                                      |
| [Database](../database/README.md)                                       | Schema conventions, migrations, RLS verification                  |
| [Tasks](../tasks/README.md)                                             | 30 implementation tasks across 8 phases                           |

## Status

Phase 1 is scaffolded and verified end to end: Postgres with row-level security
→ Fastify API → content provider → Next.js page with a connected JSON-LD graph,
split sitemaps and robots. Everything beyond that is specified here and
scheduled in `docs/tasks/`.

## One expectation to set

Nothing in this architecture makes a site rank quickly. Google's own guidance is
explicit that meeting technical requirements does not guarantee indexing or
serving, and no schema, no sitemap and no `llms.txt` changes that.

What this does give every site from day one is the set of conditions under
which good content _can_ perform: server-rendered pages, fast Core Web Vitals,
correct and consistent structured data, unambiguous canonicals, a coherent
internal link graph, automated indexing notifications, and — the part most
setups never get — conversion and revenue attribution good enough to tell which
pages are actually worth improving.
