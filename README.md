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

# Postgres 16+ and Redis. Migrate as an owner/admin role.
export DATABASE_URL=postgresql://bos@localhost:5432/bos_dev
pnpm db:migrate          # migrations → RLS policies → bos_app role

# The application connects as bos_app, which db:migrate creates with NOLOGIN
# and no password — a committed password is not a password. Give it one:
psql -c "ALTER ROLE bos_app WITH LOGIN PASSWORD 'local-dev-password';"

cp .env.example .env     # then fill it in, pointing DATABASE_URL at bos_app

pnpm workspace:provision nuesheba --owner-email you@example.com
pnpm dev                 # site :3000 · dashboard :3001 · api :4000
```

The application must connect as `bos_app`, **not** as the migration role. This
is not a nicety: row-level security does not apply to a superuser, to a role
with `BYPASSRLS`, or — without `FORCE` — to the table owner. Policies can be
perfect and every tenant boundary still open, purely because the connection
string points at the wrong role, and nothing in the application would look
wrong. The test harness refuses to run against such a role for the same reason.
See [the database README](docs/database/README.md).

## Commands

|                            |                                                        |
| -------------------------- | ------------------------------------------------------ |
| `pnpm dev`                 | All apps in watch mode                                 |
| `pnpm build`               | Build everything (needs `BOS_WORKSPACE_SLUG`)          |
| `pnpm lint`                | ESLint over every app and package                      |
| `pnpm typecheck`           | Typecheck every package and app                        |
| `pnpm test`                | Every suite, against a real Postgres and Redis         |
| `pnpm format`              | Prettier                                               |
| `pnpm db:generate`         | Generate a migration after a schema change             |
| `pnpm db:migrate`          | Apply migrations, RLS and grants                       |
| `pnpm workspace:provision` | Create or refresh a tenant from `configs/<slug>/`      |
| `pnpm check:readiness`     | Fail if a tenant config still carries placeholder data |
| `pnpm smoke`               | Smoke-test a deployment. Non-zero means do not ship    |
| `pnpm redirects:import`    | Import a URL migration map                             |
| `pnpm redirects:verify`    | Check the deployed site honours it, in one hop         |

## What is built

**The production vertical slice works end to end**, verified by an automated
smoke test rather than by assertion:

```
visitor → service page → service request → lead → CRM → confirmation
```

and, for staff:

```
sign in → dashboard → lead → move it along the pipeline → note, task, follow-up
```

|                  |                                                                             |
| ---------------- | --------------------------------------------------------------------------- |
| Schema           | 58 tables, 19 enums, RLS on every tenant-scoped table, `FORCE`d             |
| Tenant isolation | Verified against a real database, as the least-privilege application role   |
| Authentication   | Argon2id, opaque tokens, refresh rotation with reuse detection, TOTP MFA    |
| Authorisation    | Every route declares a permission; the boot fails if one does not           |
| Content          | Authoring API, sanitisation boundary, all 17 section renderers, tag caching |
| CRM              | Public form → contact, lead, activity and event in one transaction          |
| Tests            | 79 automated, against a real Postgres and Redis                             |
| Docs             | 10 architecture documents, 17 ADRs, deployment and go-live runbooks         |

What is deliberately **not** built for this milestone — the automation builder,
the analytics dashboard, the remaining CRM screens — is listed in
[`docs/tasks/README.md`](docs/tasks/README.md) and in
[the go-live checklist](docs/deployment/go-live.md), so nobody discovers it as
a surprise.

## Deploying

|                                                             |                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [Hostinger](docs/deployment/hostinger.md)                   | Three Node apps from one repository, and the three settings that catch people out |
| [Cloudflare](docs/deployment/cloudflare.md)                 | DNS, WAF, R2, Queues, and why the Worker ships with its consumers off             |
| [Environments](docs/deployment/environments.md)             | What differs between development, staging and production                          |
| [URL migration](docs/deployment/url-migration.md)           | Mandatory before replacing a site that ranks                                      |
| [Backup and restore](docs/deployment/backup-and-restore.md) | Including the drill, which is the part that makes the rest true                   |
| [Go-live](docs/deployment/go-live.md)                       | The cutover, in order, with a rollback                                            |

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
