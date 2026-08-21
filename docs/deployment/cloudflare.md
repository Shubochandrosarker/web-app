# Cloudflare setup

Cloudflare does four jobs here, and they are worth separating because only one
of them is optional:

1. **DNS and TLS** for every hostname. Not optional.
2. **CDN and WAF** in front of the site and the API. Not optional — the public
   form is the one unauthenticated write path in the platform.
3. **R2** for public media and private documents. Required for uploads; the
   platform runs without it and says so.
4. **Workers and Queues** for analytics ingestion, webhooks and the nightly
   cron. Genuinely optional, and **deliberately switched off until the API's
   internal endpoints are live** — see the last section.

## DNS

| Record  | Name     | Target                            | Proxy |
| ------- | -------- | --------------------------------- | ----- |
| `A`     | `@`      | Hostinger site IP                 | On    |
| `CNAME` | `www`    | `nuesheba.com`                    | On    |
| `A`     | `app`    | Hostinger dashboard IP            | On    |
| `A`     | `api`    | Hostinger API IP                  | On    |
| `CNAME` | `assets` | R2 public bucket domain           | On    |
| `CNAME` | `hooks`  | `bos-edge-production.workers.dev` | On    |

Everything proxied. An unproxied origin is an origin somebody can reach
directly, and the WAF rules below then guard nothing.

## TLS

- **Full (strict).** Not "Flexible": that terminates TLS at Cloudflare and
  talks to the origin over plain HTTP, which means the connection carrying
  session cookies is unencrypted for its last hop.
- **Always Use HTTPS** on.
- **Minimum TLS 1.2.**
- **HSTS** — but not until every subdomain above is permanently HTTPS. The site
  sends `max-age=63072000; includeSubDomains; preload`, and preload is
  effectively irreversible: a subdomain that later needs plain HTTP cannot have
  it. Enable it as a go-live step, not a setup step.

## Caching

The site renders per request and serves cached _data_ rather than cached HTML —
see `apps/site/lib/content.ts` for why the nonce-based CSP forced that. So the
useful cache rules are narrow:

| Path                    | Rule                                                  |
| ----------------------- | ----------------------------------------------------- |
| `/_next/static/*`       | Cache everything, edge TTL a year. Content-hashed.    |
| `assets.nuesheba.com/*` | Cache everything, edge TTL a year. Content-addressed. |
| `/sitemap*.xml`         | Cache everything, edge TTL 1 hour.                    |
| `/robots.txt`           | Cache everything, edge TTL 1 hour.                    |
| `api.nuesheba.com/*`    | **Bypass cache.** Always.                             |
| `app.nuesheba.com/*`    | **Bypass cache.** Always.                             |

A cached authenticated response is one person's dashboard served to another.
The dashboard sends `Cache-Control: no-store` on every response, and the bypass
rule is the second lock.

## WAF and rate limiting

The application already rate-limits by address and by form (`consumeRateLimit`
in `apps/api/src/lib/redis.ts`). These rules sit in front of it so a flood
never reaches the origin at all.

| Rule                            | Threshold         | Action    |
| ------------------------------- | ----------------- | --------- |
| `POST /v1/forms/*/submissions`  | 10 / minute / IP  | Block 1h  |
| `POST /v1/auth/login`           | 20 / minute / IP  | Block 1h  |
| `POST /v1/documents/upload-url` | 20 / hour / IP    | Block 1h  |
| `api.nuesheba.com` (all)        | 600 / minute / IP | Challenge |

Plus a firewall rule blocking `/v1/internal/*` from outside Cloudflare's own
network. Those endpoints are already authenticated with a shared secret
compared in constant time; this means an attacker never gets to try.

Managed Rules: on. Bot Fight Mode: on for the site, **off** for the API —
challenging a server-to-server call breaks the Worker.

## Turnstile

A widget for `nuesheba.com`. The site key goes in the site's environment
(`NEXT_PUBLIC_TURNSTILE_SITE_KEY`) and is safe to ship to a browser; the secret
goes in the API's (`TURNSTILE_SECRET_KEY`) and never leaves it.

Verification **fails closed**: if Cloudflare's endpoint is unreachable, the
submission is rejected. Treating an outage as a pass would turn any disruption
of that endpoint into an open flood gate on the one unauthenticated write path
in the platform, and a brief period of legitimate visitors being asked to try
again is the cheaper failure.

## R2

Two buckets, and the separation is structural rather than a naming convention.

**`bos-assets` — public.** Site media. Custom domain `assets.nuesheba.com`,
public access on. Objects are content-addressed by checksum, so a key never
changes and can be cached for a year.

**`bos-documents` — private.** Transcripts, certificates, ID scans.

- **No public access. No custom domain.** Nothing in the platform can produce a
  permanent URL for an object in this bucket.
- Reads happen only through a signed URL minted per request, valid for
  `R2_SIGNED_URL_TTL` seconds (default 300), after an audit row has been
  written.
- Versioning on, so a mistaken delete is recoverable.
- A lifecycle rule expiring incomplete multipart uploads after a day.

Keeping both in one bucket behind a prefix convention would make the whole
guarantee depend on every future call site remembering the convention. Two
buckets means a mistake is a missing-credential error rather than a publicly
readable transcript.

An API token scoped to **these two buckets only**, with Object Read & Write.

## Queues

```bash
wrangler queues create bos-events
wrangler queues create bos-events-dlq
```

The dead-letter queue is not optional: `max_retries = 5`, and a poisoned
message must be inspectable rather than silently retried into oblivion.

## The Worker

Secrets, never in `wrangler.toml`:

```bash
wrangler secret put API_BASE_URL        --env production
wrangler secret put EDGE_SHARED_SECRET  --env production   # same value as the API
wrangler secret put INDEXNOW_KEY        --env production
```

Deploy:

```bash
pnpm --filter @bos/edge exec wrangler deploy --env production
```

### `CONSUMERS_ENABLED` — read this before deploying

The Worker ships with `CONSUMERS_ENABLED = "false"` in every environment except
production, and turning it on is the **last** step of the first deploy.

The reason is a failure this repository has already had once. The queue
consumer forwards to `POST /v1/internal/ingest` and the cron to
`POST /v1/internal/jobs/*`. When the Worker was deployed ahead of those
endpoints, every message failed, retried five times with exponential backoff,
and landed in the dead-letter queue — from which each one has to be recovered
by hand. A Worker deployed ahead of its API now declines the work and holds the
batch instead, so the messages drain when the API arrives.

Confirm the API is answering before you flip it:

```bash
curl -i -X POST https://api.nuesheba.com/v1/internal/jobs/outbox.dispatch \
  -H "x-bos-edge-secret: $EDGE_SHARED_SECRET"
# 200 with a dispatch summary. A 404 means the API is not deployed yet.
```

Then set `CONSUMERS_ENABLED = "true"` in `[env.production.vars]` and redeploy.

The Worker's `/health` reports which state it is in, so "deployed but not
consuming" is visible rather than something you find out about via the DLQ:

```bash
curl https://hooks.nuesheba.com/health
# {"status":"ok","environment":"production","consumers":"enabled"}
```

### `ANALYTICS_ORIGINS`

Maps an allowed browser origin to a workspace slug:

```toml
ANALYTICS_ORIGINS = '{"https://nuesheba.com":"nuesheba","https://www.nuesheba.com":"nuesheba"}'
```

This replaced a workspace slug read from the request body. A slug in the body
is a value the browser controls, so anyone who read the site's JavaScript could
post events into any tenant's analytics — including one whose slug they merely
guessed. An origin that is not in this map is rejected with a 403.

## Environments

Three, with separate bindings, so a staging deploy cannot write into
production's queue or bucket.

|               | Development  | Staging              | Production            |
| ------------- | ------------ | -------------------- | --------------------- |
| Worker        | `bos-edge`   | `bos-edge-staging`   | `bos-edge-production` |
| Queue         | `bos-events` | `bos-events-staging` | `bos-events`          |
| Public bucket | `bos-assets` | `bos-assets-staging` | `bos-assets`          |
| Consumers     | off          | off                  | on                    |

Staging keeps consumers off by default: it has no reason to send a customer a
WhatsApp message, and the surest way to be certain it does not is for its
consumer never to run.

## Verifying

```bash
# TLS and headers
curl -sI https://nuesheba.com | grep -iE 'strict-transport|content-security-policy|cf-cache-status'

# The API must never be cached
curl -sI https://api.nuesheba.com/health | grep -i cf-cache-status   # BYPASS or DYNAMIC

# A private document is not reachable directly
curl -sI https://<account>.r2.cloudflarestorage.com/bos-documents/…   # 401/403

# The Worker
curl -s https://hooks.nuesheba.com/health

# Analytics rejects an origin that is not configured
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://hooks.nuesheba.com/collect \
  -H 'origin: https://not-our-site.example' -H 'content-type: application/json' \
  -d '{"events":[{"name":"page_view","path":"/"}]}'
# 403
```
