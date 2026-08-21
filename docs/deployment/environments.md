# Environment matrix

Which variable is set to what, in each environment, and why the differences
exist. **No actual secret values appear here or anywhere else in the
repository** — this is the shape of the configuration, not its contents.

`.env.example` is the authoritative list of variables. This document is the
authoritative list of what changes between environments.

## The variables that differ

| Variable                     | Development         | Staging          | Production          | Why it differs                                                                      |
| ---------------------------- | ------------------- | ---------------- | ------------------- | ----------------------------------------------------------------------------------- |
| `NODE_ENV`                   | `development`       | `production`     | `production`        | Staging is a production build. Anything else and it is testing a different program. |
| `LOG_LEVEL`                  | `debug`             | `info`           | `info`              |                                                                                     |
| **`BOS_ALLOW_INDEXING`**     | `false`             | **`false`**      | **`true`**          | The launch switch. Staging must never compete with production for its own queries.  |
| `EMAIL_PROVIDER`             | `log`               | `log`            | `smtp` \| `resend`  | Staging has no business emailing a real customer.                                   |
| `WHATSAPP_PROVIDER`          | `log`               | `log`            | `meta_cloud`        | Same, and a WhatsApp message is harder to apologise for.                            |
| `CONSUMERS_ENABLED` (Worker) | `false`             | `false`          | `true`              | Turned on last, after `/v1/internal/*` answers. See `cloudflare.md`.                |
| `DATABASE_SSL`               | unset (→ `disable`) | `require`        | `verify-full`       | A local Postgres does not speak TLS. Production verifies the chain.                 |
| `TURNSTILE_SECRET_KEY`       | unset               | set              | set                 | The API refuses to start without it in production.                                  |
| `DATABASE_URL`               | local               | staging instance | production instance | **All three connect as `bos_app`**, never the owner.                                |
| `REDIS_URL`                  | `redis://`          | `rediss://`      | `rediss://`         | TLS everywhere it crosses a network.                                                |

## The values that differ but do not vary in kind

| Variable                    | Development             | Staging                            | Production                        |
| --------------------------- | ----------------------- | ---------------------------------- | --------------------------------- |
| `NEXT_PUBLIC_SITE_URL`      | `http://localhost:3000` | `https://staging.nuesheba.com`     | `https://nuesheba.com`            |
| `NEXT_PUBLIC_API_URL`       | `http://localhost:4000` | `https://api.staging.nuesheba.com` | `https://api.nuesheba.com`        |
| `NEXT_PUBLIC_DASHBOARD_URL` | `http://localhost:3001` | `https://app.staging.nuesheba.com` | `https://app.nuesheba.com`        |
| `SITE_URL` (API)            | `http://localhost:3000` | `https://staging.nuesheba.com`     | `https://nuesheba.com`            |
| `DASHBOARD_URL` (API)       | `http://localhost:3001` | `https://app.staging.nuesheba.com` | `https://app.nuesheba.com`        |
| `API_ALLOWED_ORIGINS`       | the two localhosts      | the two staging origins            | the site, `www` and the dashboard |
| `AUTH_COOKIE_DOMAIN`        | unset                   | `.staging.nuesheba.com`            | `.nuesheba.com`                   |
| `R2_PUBLIC_BUCKET`          | `bos-assets-dev`        | `bos-assets-staging`               | `bos-assets`                      |
| `R2_PRIVATE_BUCKET`         | `bos-documents-dev`     | `bos-documents-staging`            | `bos-documents`                   |

## Secrets

Different values in every environment. A staging secret that also works in
production is a production secret.

| Secret                  | Generate with             | Rotation                                                                |
| ----------------------- | ------------------------- | ----------------------------------------------------------------------- |
| `AUTH_SESSION_SECRET`   | `openssl rand -base64 32` | On suspicion. Rotating signs everybody out.                             |
| `EDGE_SHARED_SECRET`    | `openssl rand -base64 32` | Quarterly. **Must match** across the API, the site and the Worker.      |
| `ANALYTICS_HASH_SECRET` | `openssl rand -base64 32` | Quarterly. Rotating re-pseudonymises every visitor, which is the point. |
| `INDEXNOW_KEY`          | `openssl rand -hex 16`    | Rarely. Also served at `https://<site>/<key>.txt`.                      |
| `DATABASE_URL` password | The provider              | Quarterly, and after any staff change.                                  |
| `R2_SECRET_ACCESS_KEY`  | Cloudflare                | Quarterly, and after any staff change.                                  |
| `TURNSTILE_SECRET_KEY`  | Cloudflare                | On suspicion.                                                           |
| SMTP / WhatsApp         | The provider              | On suspicion.                                                           |

### Rotating `EDGE_SHARED_SECRET`

The only rotation with no overlap window, because three processes compare the
same value: the API verifies it on `/v1/internal/*`, the site verifies it on
`/api/revalidate`, and the Worker presents it. Change all three together, in a
maintenance minute. Between the first and the last, internal calls fail — they
are retried by the outbox and the queue, so the cost is a delay rather than a
loss, but it is not a change to make casually.

## Build time versus run time

Anything prefixed `NEXT_PUBLIC_` is **inlined into the JavaScript bundle when
the app is built**. Changing it on the host and restarting has no effect; the
app has to be rebuilt.

| Variable                                                                   | Applied at                     |
| -------------------------------------------------------------------------- | ------------------------------ |
| `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_DASHBOARD_URL` | **Build**                      |
| `NEXT_PUBLIC_MEDIA_ORIGIN`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`               | **Build**                      |
| `BOS_WORKSPACE_SLUG`, `BOS_ALLOW_INDEXING`                                 | Run time — a restart is enough |
| Everything on the API and the Worker                                       | Run time                       |

`BOS_ALLOW_INDEXING` being a run-time variable is deliberate: flipping the
launch switch at cutover should be a restart, not a rebuild whose output might
differ from what was tested on staging.

## Where each variable lives

| Process   | Set in                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| Site      | Hostinger → the site app → Environment variables                                                                |
| Dashboard | Hostinger → the dashboard app → Environment variables                                                           |
| API       | Hostinger → the API app → Environment variables                                                                 |
| Worker    | `wrangler secret put --env <environment>` for secrets; `wrangler.toml` `[env.*.vars]` for the rest              |
| CI        | Repository secrets. CI needs no production credential — it builds and tests against its own throwaway database. |

## Verifying an environment

```bash
# Every process validates its slice at boot and exits with a list of what is
# missing. This is the fastest way to find a typo.
curl -s https://api.nuesheba.com/ready | jq

# The launch switch, from the outside. Both, because they fail differently.
curl -s https://nuesheba.com/robots.txt
curl -s https://nuesheba.com | grep -o 'noindex'

# The Worker's consumers.
curl -s https://hooks.nuesheba.com/health

# And the whole thing.
pnpm smoke -- --site https://nuesheba.com \
              --api https://api.nuesheba.com \
              --dashboard https://app.nuesheba.com \
              --service-path /services/academic-transcript \
              --expect-indexable
```

## What is deliberately not configurable

Stated because the absence is a decision rather than an oversight.

- **Whether row-level security is enforced.** There is no flag. It is applied
  by `pnpm db:migrate` to every table carrying a `workspace_id`, with `FORCE`,
  and the only way to bypass it is to connect as the wrong role — which the
  test harness refuses to do and the deployment documentation warns about
  twice.
- **Whether the CMS sanitises HTML.** One write boundary, no bypass, no
  "trusted editor" mode.
- **Whether a route requires authentication.** Each route declares it, and a
  startup assertion refuses to listen if one does not.
- **Whether the public API can return drafts.** There is no parameter for it —
  the public routes cannot express the request.
