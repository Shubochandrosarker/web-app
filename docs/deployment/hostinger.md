# Deploying to Hostinger

Three independent Node.js Web Apps, all pointing at **this same repository**.
They are separate applications rather than one, for the reason in
`apps/dashboard/next.config.ts`: the public site's JavaScript budget is a
ranking-adjacent concern and the dashboard's is not, so they get separate
builds and separate budgets.

| App       | Domain             | Package          | Purpose                |
| --------- | ------------------ | ---------------- | ---------------------- |
| Site      | `nuesheba.com`     | `@bos/site`      | The public website     |
| Dashboard | `app.nuesheba.com` | `@bos/dashboard` | Staff and admin        |
| API       | `api.nuesheba.com` | `@bos/api`       | Everything server-side |

## Before the first deploy

- **Node.js 22.** Set in the hPanel runtime selector; `.nvmrc` pins it for
  local work and CI but the host does not read it.
- **pnpm.** This is a pnpm workspace. npm and yarn will install a broken tree.
- **Repository root as the project root.** Not `apps/site`. Workspace
  dependencies (`@bos/database`, `@bos/sections`, …) resolve through the root
  `node_modules`; pointing the project root at a sub-directory produces
  `Cannot find module '@bos/…'` at build time.

## The three settings that catch people out

**1. `PORT`.** Hostinger's troubleshooting guidance expects a server-side app
to listen on port 3000, and it assigns the port through `PORT`. Every app here
honours it:

```jsonc
// apps/site/package.json
"start": "next start --port ${PORT:-3000}"
// apps/dashboard/package.json
"start": "next start --port ${PORT:-3001}"
```

and the API resolves `PORT` before its own `API_PORT` (see `resolvePort` in
`@bos/config`). Do not assume Hostinger will expose 3001 or 4000 externally —
the local defaults exist so `pnpm dev` runs three apps at once, and nothing
more.

**2. Binding.** The API binds `0.0.0.0`, not `localhost`. A process bound to
the loopback address is unreachable from the host's proxy, and the symptom is
a healthy-looking process serving nothing.

**3. Build commands run from the repository root.** `pnpm --filter` targets one
package while installing and resolving from the workspace root, which is what
makes a monorepo work on a host that expects one application per project.

**4. `NEXT_PUBLIC_*` variables are baked in at build time.** They are inlined
into the JavaScript bundle, so changing one on the host and restarting does
nothing — the old value is still compiled into the code. Both Next apps must be
**rebuilt** after any change to `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL`,
`NEXT_PUBLIC_DASHBOARD_URL`, `NEXT_PUBLIC_MEDIA_ORIGIN` or
`NEXT_PUBLIC_TURNSTILE_SITE_KEY`. Everything without the prefix is read at
runtime and a restart is enough. The symptom of getting this wrong is a
dashboard that calls the wrong API host and fails with `ENOTFOUND`.

---

## App 1 — Public site (`nuesheba.com`)

**Build command**

```bash
pnpm install --frozen-lockfile && pnpm --filter @bos/site... build
```

`@bos/site...` (with the trailing dots) builds the site _and its workspace
dependencies_. Without them, a package that needs a build step is missing at
runtime.

**Start command**

```bash
pnpm --filter @bos/site start
```

**Environment**

```
NODE_ENV=production
BOS_WORKSPACE_SLUG=nuesheba
CONTENT_PROVIDER=internal
NEXT_PUBLIC_SITE_URL=https://nuesheba.com
NEXT_PUBLIC_API_URL=https://api.nuesheba.com
NEXT_PUBLIC_MEDIA_ORIGIN=https://assets.nuesheba.com
NEXT_PUBLIC_TURNSTILE_SITE_KEY=<site key>
EDGE_SHARED_SECRET=<same value as the API>
INDEXNOW_KEY=<key>

# Not until the go-live checklist is complete.
BOS_ALLOW_INDEXING=false
```

`EDGE_SHARED_SECRET` is here because `/api/revalidate` is authenticated with
it: that endpoint can purge any page's cache, so an unauthenticated version
would be a free denial-of-service against the origin.

---

## App 2 — Dashboard (`app.nuesheba.com`)

**Build command**

```bash
pnpm install --frozen-lockfile && pnpm --filter @bos/dashboard... build
```

**Start command**

```bash
pnpm --filter @bos/dashboard start
```

**Environment**

```
NODE_ENV=production
BOS_WORKSPACE_SLUG=nuesheba
NEXT_PUBLIC_API_URL=https://api.nuesheba.com
NEXT_PUBLIC_DASHBOARD_URL=https://app.nuesheba.com
NEXT_PUBLIC_SITE_URL=https://nuesheba.com
```

The dashboard holds no secrets. Every call it makes is server-side with the
session cookie forwarded, so there is no token for a browser to leak and
nothing here that is not already public.

---

## App 3 — API (`api.nuesheba.com`)

**Build command**

```bash
pnpm install --frozen-lockfile && pnpm --filter @bos/api... build
```

The API bundles with esbuild rather than `tsc`, because workspace packages ship
TypeScript source — see the comment in `apps/api/build.mjs` for why
`packages: 'external'` is not the answer.

**Start command**

```bash
pnpm --filter @bos/api start
```

**Environment**

```
NODE_ENV=production
LOG_LEVEL=info

DATABASE_URL=postgresql://bos_app:<password>@<host>:5432/<database>?sslmode=require
DATABASE_POOL_MAX=10
DATABASE_SSL=require

REDIS_URL=rediss://<host>:6379

API_PUBLIC_URL=https://api.nuesheba.com
API_ALLOWED_ORIGINS=https://nuesheba.com,https://www.nuesheba.com,https://app.nuesheba.com
AUTH_SESSION_SECRET=<openssl rand -base64 32>
AUTH_COOKIE_DOMAIN=.nuesheba.com
AUTH_MFA_ISSUER=NuESheba

EDGE_SHARED_SECRET=<openssl rand -base64 32>
ANALYTICS_HASH_SECRET=<openssl rand -base64 32>

SITE_URL=https://nuesheba.com
DASHBOARD_URL=https://app.nuesheba.com

TURNSTILE_SECRET_KEY=<secret key>

EMAIL_PROVIDER=smtp
EMAIL_FROM_ADDRESS=noreply@nuesheba.com
EMAIL_FROM_NAME=NuESheba
SMTP_HOST=<host>
SMTP_PORT=587
SMTP_USER=<user>
SMTP_PASSWORD=<password>

WHATSAPP_PROVIDER=meta_cloud
WHATSAPP_PHONE_NUMBER_ID=<id>
WHATSAPP_ACCESS_TOKEN=<token>

R2_ACCOUNT_ID=<id>
R2_ACCESS_KEY_ID=<id>
R2_SECRET_ACCESS_KEY=<secret>
R2_PUBLIC_BUCKET=bos-assets
R2_PRIVATE_BUCKET=bos-documents
R2_PUBLIC_BASE_URL=https://assets.nuesheba.com
```

### The API refuses to start if this is wrong

`assertProductionSafe` in `apps/api/src/lib/env.ts` fails the boot when
`NODE_ENV=production` and any of the following holds:

- `EMAIL_PROVIDER=log` or `WHATSAPP_PROVIDER=log` — messages would be written
  to a log file instead of sent, and nobody would notice for days.
- `TURNSTILE_SECRET_KEY` unset — the one unauthenticated write path in the
  platform with no CAPTCHA in front of it.
- `API_ALLOWED_ORIGINS` empty — no browser origin could call the API at all.
- `DATABASE_SSL` not `verify-full` — the certificate is not being checked.

A failed boot with a clear message beats a running deployment that is quietly
wrong. The last one is the most likely to need a deliberate override: managed
Postgres frequently presents a certificate chained to a provider root the
container does not carry, and `require` is then the correct setting — it is a
decision, and the boot failure is what makes somebody make it.

---

## Database roles

Two credentials, and the distinction is enforced rather than advisory.

| Role      | Used by       | Privileges                                  |
| --------- | ------------- | ------------------------------------------- |
| `bos`     | Migrations    | Owner. DDL.                                 |
| `bos_app` | Every runtime | `SELECT/INSERT/UPDATE/DELETE` only. No DDL. |

**The runtime must never connect as the migration role.** Row-level security
does not apply to a superuser, to a role with `BYPASSRLS`, or — without
`FORCE` — to the table owner. Policies can be perfect and every tenant
boundary still open, purely because `DATABASE_URL` points at the wrong role,
and nothing in the application would look wrong.

`pnpm db:migrate` creates `bos_app` with `NOLOGIN` and no password: a committed
password is not a password. Give it one out of band:

```sql
ALTER ROLE bos_app WITH LOGIN PASSWORD '<from the secret store>';
```

### Migrations are not run by the application

Nothing in `start` applies a migration. Deploying a build that migrates on boot
means N instances racing to alter the same table, and a rollback that leaves a
schema the previous version cannot read.

Run them as a deliberate step, from a machine that can reach the database, with
the **owner** credential:

```bash
DATABASE_URL=postgresql://bos:<password>@<host>:5432/<database> pnpm db:migrate
```

Then provision or refresh the workspace:

```bash
DATABASE_URL=postgresql://bos:<password>@<host>:5432/<database> \
  pnpm workspace:provision nuesheba
```

Provisioning is idempotent — it creates what is missing, updates the fields the
config owns, and never overwrites something a person edited in the dashboard.
Run it on every deploy that changes `configs/nuesheba/business.json`.

The first time, create the owner account too:

```bash
BOS_OWNER_PASSWORD='<a long random password>' \
DATABASE_URL=postgresql://bos:<password>@<host>:5432/<database> \
  pnpm workspace:provision nuesheba --owner-email owner@nuesheba.com
```

Sign in and turn on two-factor authentication immediately. An account that can
read a student's transcript should not be protected by a password alone.

---

## Deploy order

The order matters once, on the first deploy, because each app depends on the
one before it being reachable.

1. **Migrate** — the schema must exist before anything connects.
2. **Provision** — the workspace must exist before the site can resolve a slug.
3. **API** — the site and dashboard are useless without it. Check `/ready`.
4. **Site and dashboard** — either order.
5. **Worker** — last, and only after `/v1/internal/*` answers. See
   `docs/deployment/cloudflare.md`; deploying it earlier fills the dead-letter
   queue.
6. **Smoke test** — `pnpm smoke` against the deployed URLs.

On subsequent deploys: migrate first if there is a migration (they are
expand-only, so the running version tolerates the new schema), then the apps in
any order.

---

## Health checks

Point the host's health check at `/health` on the API and **not** at `/ready`.

They answer different questions. `/health` asks "should this process be
restarted?" and touches nothing — the answer is no just because Postgres is
briefly unreachable, and restarting every instance during a database blip is
how a small outage becomes a large one. `/ready` asks "should this instance
receive traffic?" and does check its dependencies.

---

## Troubleshooting

**The build fails with `Cannot find module '@bos/…'`.** The project root is set
to a sub-directory. It must be the repository root.

**The app builds and the domain returns 502.** Almost always `PORT`. Confirm
the start command is the one above rather than a hard-coded `--port 3000`.

**`Invalid environment for "api:…"` in the logs and the process exits.** This
is the environment contract doing its job: the message names every missing or
malformed variable. Compare against `.env.example`.

**Logins fail with no error in the API log.** Check `API_ALLOWED_ORIGINS`
includes the dashboard's origin exactly, scheme and all. A CORS rejection
happens before the handler runs, so there is nothing to log.

**Every page is a 404 but the API returns content.** `BOS_WORKSPACE_SLUG` does
not match a provisioned workspace. `pnpm workspace:provision <slug>`.

**Published content does not appear.** The API posts to
`<SITE_URL>/api/revalidate` when a page is published. Check `SITE_URL` is set
on the API and `EDGE_SHARED_SECRET` is the _same value_ in both apps. Without
it, content appears when the five-minute cache window closes rather than
immediately.
