# Migrating the existing NuESheba URLs

> **This has not been done.** The live site could not be reached from the
> environment this platform was built in, so the map below does not exist yet.
> Producing it is a launch-blocking task, and it is the one task in the go-live
> checklist that cannot be automated away — deciding which new page answers an
> old URL's question is an editorial judgement, not a string transformation.
>
> Everything mechanical around that judgement _is_ built: parsing, validation,
> chain detection, an idempotent import and a verifier that checks the deployed
> site behaves the way the map says.

## Why this matters more than the rest of the launch

A site that already ranks has accumulated signal at specific URLs. Replacing it
without a redirect map throws that away — not gradually, but at the moment DNS
changes. The new site starts from zero on terms the old one ranked for, and
recovery takes months if it happens at all.

The two ways this goes wrong are both avoidable:

- **URLs move silently.** Old links 404. Anything pointing at them stops
  counting.
- **Everything redirects to the homepage.** A redirect to a page that does not
  answer the original request is treated as a soft 404. It is the same loss,
  with extra steps, and it also strands every visitor who followed a link.

## Step 1 — Collect every URL that exists

Four sources, because no one of them is complete.

**The live sitemap** — what the site claims exists.

```bash
curl -s https://nuesheba.com/sitemap.xml | grep -oP '(?<=<loc>)[^<]+' > urls-sitemap.txt
```

If it is an index, fetch each child sitemap the same way.

**Search Console → Pages** — what Google has actually indexed, which is
routinely different from the sitemap. Export the full list. **This is the most
important source**, because a URL Google knows about is one it will re-crawl
after the migration and report as an error if it 404s.

**Analytics landing pages, last 12 months** — what people actually arrive on.
Twelve months rather than three, to catch anything seasonal. Sort by sessions:
the top of this list is where the effort goes.

**A crawl** — what is reachable that the other three missed.

```bash
wget --spider -r -l 5 --no-parent -o crawl.log https://nuesheba.com/
grep -oP '(?<=URL: )\S+' crawl.log | sort -u > urls-crawl.txt
```

Then combine and deduplicate:

```bash
cat urls-*.txt | sed 's|https\?://[^/]*||' | sed 's|/$||' | sort -u > urls-all.txt
wc -l urls-all.txt
```

## Step 2 — Decide, one URL at a time

For each URL, exactly one of three outcomes.

**Keep the URL.** The best outcome by a wide margin: nothing to redirect,
nothing to lose. If `/services/transcript` still describes the same service,
the new site should serve `/services/transcript`. Design the new information
architecture around the URLs that are already earning, not the other way
round — a tidier URL scheme is not worth a ranking.

**301 to the new URL.** The page still exists, at a different address. The
destination must genuinely answer the same question. A transcript page
redirects to the transcript page, never to `/services`.

**410 Gone.** The page is genuinely obsolete with no equivalent — a promotion
that ended, a service no longer offered. `410` tells a crawler to drop the URL,
which is the honest answer and is better for everyone than a 301 somewhere
irrelevant.

Rules worth stating because they are what people get wrong under time pressure:

- **Never mass-redirect to the homepage.** If more than a handful of URLs have
  no better destination than `/`, the mapping is not finished.
- **No chains.** `/a → /b → /c` costs a round trip per visitor and dilutes the
  signal at each hop. Point `/a` straight at `/c`. The importer refuses a
  chain rather than warning about it.
- **Query strings and trailing slashes.** `/x` and `/x/` are one entry — the
  importer normalises both to `/x`, and the proxy matches either.
- **Do the top twenty by hand.** Whatever the rest of the process, the twenty
  highest-traffic URLs deserve somebody looking at both pages.

## Step 3 — Write the map

A CSV, `from,to,status`:

```csv
from,to,status
# Kept: same URL, no row needed. Listed here only as a reminder.
# /services/transcript  → unchanged

# Moved
/transcript,/services/academic-transcript,301
/certificate-original,/services/original-certificate,301
/nu-attestation,/services/attestation,301
https://nuesheba.com/blog/how-to-apply,/guides/how-to-apply,301

# Obsolete, with no equivalent
/promo-2023,,410
```

`from` may be a path or a full URL — an export from Search Console gives
absolute URLs, and making somebody strip the origin by hand is an invitation to
do it wrong. Blank lines and `#` comments are ignored.

## Step 4 — Import

```bash
DATABASE_URL=postgresql://bos:<password>@<host>:5432/<database> \
  pnpm redirects:import nuesheba redirects.csv
```

The import validates before it writes anything, and reports **every** problem
rather than the first:

- a source that is neither a path nor an absolute URL
- a duplicate source, with both line numbers
- a `301` with no destination, or a `410` with one
- a URL that redirects to itself
- a chain, naming the hop to remove

Nothing is written unless the whole file is clean. Re-running is safe: existing
rows are updated in place, so a corrected file can simply be imported again.

## Step 5 — Verify against the deployed site

The check that matters, because a redirect that exists in the database and not
in the response is invisible until somebody follows an old link:

```bash
DATABASE_URL=… pnpm redirects:verify nuesheba --base https://staging.nuesheba.com
```

For every row it confirms the response is a 301 (or a 410), that the
destination is the one the map names, that the destination is not itself a
redirect, and that the destination is not a 4xx.

Run it against staging before the cutover and against production immediately
after.

## Step 6 — After the cutover

- Submit the new sitemap in Search Console.
- **Change of Address**, only if the domain changed. Not applicable to a
  same-domain rebuild.
- Watch Coverage for a week. Old URLs should move to "Page with redirect"; new
  ones should be indexed. A rise in "Not found (404)" is a redirect you missed —
  add it, no import limit applies.
- Watch the site's own 404s. A 404 with referrer traffic is a live link
  pointing at something you removed.

## How redirects work here

They are rows in the `redirects` table, served by `apps/site/proxy.ts`, which
caches them in process for sixty seconds. That is deliberate: an editor
changing a slug must not need a deploy, and the CMS already creates a redirect
automatically when a **published** page's path changes.

The consequence is that this table is the single source of truth for redirects.
There are none in `next.config.ts` and none at the web server, so there is one
place to look when a URL behaves unexpectedly.
