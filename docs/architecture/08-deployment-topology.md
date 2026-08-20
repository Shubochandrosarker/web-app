# Deployment topology

## Domains

| Domain                | Serves                       | Runs on                   |
| --------------------- | ---------------------------- | ------------------------- |
| `nuesheba.com`        | Public site (`apps/site`)    | Managed Node hosting      |
| `app.nuesheba.com`    | Dashboard (`apps/dashboard`) | Managed Node hosting      |
| `api.nuesheba.com`    | Business API (`apps/api`)    | Managed Node hosting      |
| `assets.nuesheba.com` | Public media                 | Cloudflare R2 + CDN       |
| `hooks.nuesheba.com`  | Webhooks, analytics ingest   | Cloudflare Worker         |
| `cms.nuesheba.com`    | WordPress, if retained       | Wherever it already lives |

If WordPress is retained it is an internal detail. It is not linked from the
public site, `/wp-admin` is IP-restricted or behind Access, and no public URL
resolves to it. A visitor never has occasion to know it exists.

## What runs where, and why

### Origin — Node hosting beside the database

`apps/site`, `apps/dashboard`, `apps/api`, PostgreSQL, Redis.

The API needs transactions, an RLS session context and a warm connection pool.
Moving it to Workers trades a real database session for Hyperdrive plus careful
reasoning about connection reuse, and buys nothing a user would feel — the API
is not on a latency-critical path.

Hostinger's Web App hosting fits the requirement: Git-based Node deployments,
custom build commands, a managed runtime with SSL, and redeploy on push. Any
managed Node host with those properties works; nothing in the codebase is
specific to one provider.

### Edge — Cloudflare

DNS, CDN, WAF, bot protection, R2, Queues, and `apps/edge`.

The Worker handles exactly the work that benefits from being close to the
client and does not need a transaction:

- **Analytics ingestion** — highest volume, smallest payload. A traffic spike
  must not consume origin capacity that a form submission needs.
- **Webhook receipt** — verify the signature, queue the body, return fast.
  Providers retry aggressively on slow responses, and processing inline turns
  one slow write into a herd of duplicate deliveries.
- **Queue consumption** — outbound messages, indexing submissions, cache purges.
- **Scheduled jobs** — a reliable clock. The API does the work; the cron only
  triggers it, because rollups and retention sweeps need transactions and
  cross-tenant access, which belong next to the database.

### Deliberately not at the edge

The business API. Revisit if global read latency becomes a **measured** problem
rather than an assumed one; Hyperdrive exists for that case, and moving is a
contained change because the API's data access is already isolated behind
`@bos/database`.

## Build and deploy

```
git push
   ↓
CI: format · typecheck · build · test
    migrations apply to a clean Postgres
    tenant configs validate
    Drizzle schema matches committed migrations
   ↓
deploy site + dashboard + api  (origin)
deploy edge worker             (wrangler)
   ↓
run migrations
   ↓
smoke: /health · /ready · a rendered page · sitemap.xml
```

Migrations run as the **owner** role. The applications run as `bos_app`. Two
different connection strings, and conflating them is the failure described in
[07 — Security](07-security-and-data-protection.md).

### Per-tenant builds

The site build bakes in the tenant's brand and canonical origin, so
`BOS_WORKSPACE_SLUG` is part of the Turborepo cache key. One build per client;
the dashboard and API are tenant-agnostic and built once.

## Caching

| Layer          | Policy                                                         |
| -------------- | -------------------------------------------------------------- |
| Cloudflare CDN | Static assets immutable; HTML cached with tag-based purge      |
| Next.js ISR    | Per-page, revalidated by tag on publish (TASK-204)             |
| Redis          | Sessions, rate limits, workspace lookups, expensive aggregates |
| Postgres       | Nothing clever. Correct indexes and pre-aggregated rollups.    |

Publishing purges the CDN for the affected URL, revalidates the ISR tag,
regenerates the sitemap segment and submits to IndexNow — in that order, so the
sitemap a crawler fetches after the notification already reflects the change.

## Environments

|             | Origin      | Indexable | Data           |
| ----------- | ----------- | --------- | -------------- |
| Development | Local       | No        | Local Postgres |
| Preview     | Per-branch  | No        | Seeded copy    |
| Production  | Live domain | Yes       | Production     |

`BOS_ALLOW_INDEXING` gates `robots.txt` and defaults to off. It is keyed on an
explicit variable rather than `NODE_ENV`, because a preview deployment _is_ a
production build — the two are different questions and conflating them is how a
staging site ends up in the index.

## Operational readiness

- `/health` — liveness, deliberately does not touch the database.
- `/ready` — readiness, checks the database. Separate so a slow database takes
  the instance out of rotation instead of triggering a restart loop.
- Structured JSON logs with credential redaction configured in the logger.
- Graceful shutdown on `SIGTERM`: stop accepting, drain in-flight, close the
  pool. Without it, every deploy drops in-flight requests and leaves Postgres
  holding connections until they time out.
- Encrypted backups with **tested** restores.

## Cost shape

Approximate, for one small-business tenant:

|                                 |                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| Node hosting + managed Postgres | the bulk of it                                                                               |
| Cloudflare                      | free tier covers DNS/CDN/WAF; Workers, Queues and R2 are usage-based and small at this scale |
| Email                           | per-message, provider-dependent                                                              |

The dominant cost is the origin, and it is shared across tenants on a single
deployment if the control plane is ever built.
