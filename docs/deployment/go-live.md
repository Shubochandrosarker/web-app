# Go-live

Replacing a website that already ranks is a different problem from launching a
new one. The site being better is not enough: if the URLs move without
redirects, or the NAP disagrees with the Google Business Profile, or staging
gets indexed alongside production, the new site starts from behind.

The sequence is therefore: **development → staging → production**, with the
cutover as one deliberate step and a rollback that is always available.

---

## Stage 1 — Staging

Staging is production in every respect except two: it is not indexable, and it
does not send messages to real people.

- [ ] Every app deployed per `hostinger.md`, on `staging.nuesheba.com`,
      `app.staging.nuesheba.com`, `api.staging.nuesheba.com`.
- [ ] `BOS_ALLOW_INDEXING=false` on the site. **Verify, do not assume:**
      `bash
curl -s https://staging.nuesheba.com/robots.txt          # Disallow: /
curl -s https://staging.nuesheba.com | grep -o 'noindex' # present
`
      Both, because they fail differently: `robots.txt` stops a crawl, and the
      per-page directive is what removes a URL that is already known.
- [ ] `EMAIL_PROVIDER` and `WHATSAPP_PROVIDER` pointed at a sink, not at a
      customer. The API refuses to start with `log` in production — staging is
      exactly where `log` belongs.
- [ ] Cloudflare Worker `CONSUMERS_ENABLED = "false"`. Staging has no business
      sending anybody a WhatsApp message, and the surest way to be certain is
      for its consumer never to run.
- [ ] `pnpm smoke -- --site https://staging.nuesheba.com --api https://api.staging.nuesheba.com --dashboard https://app.staging.nuesheba.com --service-path /services/<a-real-one> --submit-form`
      — all green. `--submit-form` creates a real lead; delete it afterwards.
- [ ] Crawl staging (Screaming Frog, Sitebulb, or `wget --spider -r`) and
      confirm: no 404s from internal links, no redirect chains, one H1 per
      page, every image has alt text.
- [ ] Lighthouse on the homepage and on the highest-traffic service page.
      Targets: performance ≥ 95, accessibility ≥ 95, best practices ≥ 95, SEO
      ≈ 100. Treat these as a smoke alarm rather than a score to optimise —
      what matters is field data after launch.

---

## Stage 2 — Content and configuration

- [ ] **The `Release gate` workflow (Actions → Release gate) is green.** It
      re-runs everything CI verifies and then applies the gates that stay
      advisory during development: the tenant-readiness check and the
      high-severity dependency audit, with no `continue-on-error` anywhere.
      A release that has not passed it does not ship.
- [ ] **A restore drill has been executed and recorded**
      (docs/operations/backup-restore.md). A backup nobody has restored from
      is a hypothesis.
- [ ] **`pnpm check:readiness nuesheba` exits zero.** This is a hard gate. It
      fails while the config carries a placeholder phone number, email or
      address, because those are published as the business's NAP in
      `LocalBusiness` structured data and in the footer of every page.
- [ ] The production config opts in with `environment.releaseEligible: true`.
      Demo and fixture configs must keep it false; `pnpm check:readiness
--release-eligible` must never use them as release inputs.
- [ ] The NAP in `configs/nuesheba/business.json` matches the **Google Business
      Profile character for character** — including punctuation and
      abbreviations. This is the single highest-leverage local SEO detail and
      the easiest to get subtly wrong.
- [ ] `sameAs` lists only profiles the business actually controls. A profile it
      does not control is a false claim about an entity, and it is not a
      shortcut.
- [ ] The independence disclaimer is set and visible in the footer. NuESheba
      assists with National University documents and is **not affiliated with
      the university**; there must be no page on which a visitor could
      reasonably conclude otherwise.
- [ ] Every service page carries a direct answer under its H1, a requirements
      list, a process with realistic timelines, and an FAQ — see
      `configs/nuesheba/README.md`.
- [ ] No invented facts. No review schema without real reviews. No rating
      without a source. No FAQ schema for questions that are not on the page.
      The renderer enforces the last one; the others are editorial.
- [ ] Pricing says what is true. "On request" is a real answer and a better one
      than a number nobody will honour.

---

## Stage 3 — The URL migration

**Mandatory.** Skipping it is how a site that ranked stops ranking.

See `docs/deployment/url-migration.md` for the procedure. In short:

- [ ] Collect every URL that currently exists: the live sitemap, Search Console
      → Pages, Analytics landing pages for the last 12 months, and a crawl of
      the live site.
- [ ] Map every one of them: keep the URL, 301 to the new one, or 410. Never
      mass-redirect to the homepage — a redirect to an irrelevant page is
      treated as a soft 404 and loses the signal anyway.
- [ ] Import the map: `pnpm redirects:import nuesheba redirects.csv`
- [ ] Verify no chains: every `from` must resolve in one hop.
      `pnpm redirects:verify nuesheba --base https://staging.nuesheba.com`
- [ ] Spot-check the twenty highest-traffic old URLs by hand.

---

## Stage 4 — Production, before DNS

Everything here happens while the old site is still serving traffic.

- [ ] Production Postgres provisioned, `bos_app` created with a password, and
      the runtime `DATABASE_URL` pointed at `bos_app` — **not** the owner. Row
      level security does not bind an owner.
- [ ] `pnpm db:migrate` run with the owner credential.
- [ ] `pnpm workspace:provision nuesheba` run. Idempotent, so run it again
      after any config change.
- [ ] Owner account created and **MFA turned on immediately**. An account that
      can read a student's transcript should not be protected by a password
      alone.
- [ ] Content imported and published.
- [ ] **At least one service published.** The provisioned service request form
      has a required `service` select whose options come from the published
      service catalogue. With an empty catalogue that select has nothing to
      choose, and a required select with no options is a form nobody can
      submit — the site looks finished and silently takes no leads.
- [ ] **No fixture content anywhere.** `pnpm workspace:seed-smoke` writes pages
      and a service that exist only so CI can walk the vertical slice; every
      one of them says so in its own copy. If a page titled "Smoke test"
      reaches production, something ran that script against the wrong database.
      `select path, title from content_entries where title ilike 'smoke test%'`
      should return nothing.
- [ ] Redirects imported.
- [ ] A backup taken, and **a restore drill completed** —
      `docs/deployment/backup-and-restore.md`. Deployment is not finished until
      a restore has been tested, because until then the backup is a hypothesis.
- [ ] Cloudflare configured per `cloudflare.md`, except HSTS.
- [ ] Worker deployed with `CONSUMERS_ENABLED = "true"`, and only after
      `/v1/internal/jobs/outbox.dispatch` answers 200.
- [ ] `pnpm smoke` against the production hostnames, still with
      `BOS_ALLOW_INDEXING=false`. Everything must pass before DNS moves.
- [ ] Search Console property for the new site, verified.
- [ ] The old site's Search Console access confirmed — you will need it for the
      Change of Address tool and to watch coverage afterwards.

---

## Stage 5 — Cutover

Pick a low-traffic hour. Have the old site's DNS values written down before you
change anything.

1. [ ] Lower the DNS TTL to 300 seconds **at least an hour beforehand**, so a
       rollback propagates in minutes rather than a day.
2. [ ] Take a final backup of the old site and its database.
3. [ ] Point DNS at the new origins.
4. [ ] Watch propagation. `dig +short nuesheba.com` from a few resolvers.
5. [ ] `pnpm smoke -- --site https://nuesheba.com … --expect-indexable` — note
       that this run _expects_ indexability, which is the opposite of every
       previous run.
6. [ ] Set `BOS_ALLOW_INDEXING=true` and redeploy the site.
7. [ ] Verify immediately that `/robots.txt` now allows crawling and names the
       sitemap, and that `curl -s https://nuesheba.com | grep noindex` finds
       nothing.
8. [ ] Enable HSTS in Cloudflare — now, not earlier, because preload is
       effectively irreversible and every subdomain must already be permanently
       HTTPS.

**Rollback**, if the smoke test fails or the site is visibly wrong: point DNS
back. That is why the TTL was lowered and why the old origin is still running.
Do not attempt to fix forward under traffic on the first day.

---

## Stage 6 — The first hour

- [ ] `/health` and `/ready` on the API.
- [ ] Submit a real service request through the live form. Confirm: a lead
      appears in the dashboard, the confirmation email arrives, the WhatsApp
      acknowledgement arrives, and staff get the notification. This is the
      whole product; test it as a customer would.
- [ ] Delete that test lead.
- [ ] Sign in to the dashboard as a member of staff, not as the owner.
- [ ] `select status, count(*) from event_outbox group by status;` — `dead`
      must be zero.
- [ ] Server error rate in the host's logs.
- [ ] `select count(*) from analytics_events where occurred_at > now() - interval '10 minutes';`
      — non-zero means the Worker is ingesting.

## The first day

- [ ] Submit the sitemap in Search Console.
- [ ] Trigger IndexNow: publishing any page does it, or call
      `/api/revalidate` directly.
- [ ] Search Console → **Change of Address**, if the domain changed. Not
      applicable for a same-domain rebuild.
- [ ] URL Inspection on the five most important pages. "Crawled — currently not
      indexed" on day one is normal; a fetch error is not.
- [ ] Watch 404s. Anything with real traffic is a redirect you missed.
- [ ] Confirm the analytics rollup ran overnight:
      `select date, dimension, page_views from analytics_daily order by date desc limit 5;`

## The first week

- [ ] Search Console Coverage: indexed count climbing, no spike in errors.
- [ ] Core Web Vitals in Search Console — **field data**, which is the number
      that counts, not the Lighthouse score from Stage 1.
- [ ] Rankings for the terms that mattered before. A dip in the first fortnight
      is normal on a migration; a dip that is still there at six weeks is a
      redirect map to re-check.
- [ ] Conversion rate against whatever the old site did. If leads fell, the
      problem is the form or the phone number, and both are quick to check.
- [ ] Read `audit_log`. It is the first week; you want to know who did what.

---

## What is deliberately not done at launch

Stated here so nobody discovers it as a surprise. (This list is maintained;
earlier revisions named gaps that have since been closed — the automation
builder, the CRM screens and the per-field section editor all exist now.)

- **Owner facts are placeholders** until supplied: real phone, WhatsApp,
  email, address, opening hours, legal entity and disclaimer wording. See
  [`docs/owner-input-required.md`](../owner-input-required.md) — the readiness
  check fails while they remain.
- The **old-site URL migration map** does not exist yet; building it needs
  the owner's sitemap/Search Console/analytics exports (same document). Do
  not cut DNS over without it.
- **Services management, scheduling, orders, landing pages, reviews and
  local-SEO screens** are pending; their navigation entries stay hidden
  rather than linking to a page that does not exist.
- **Search Console ingestion** requires the owner to grant property access
  before its screen shows data.

See the pull request's "Known limitations" for the complete list.
