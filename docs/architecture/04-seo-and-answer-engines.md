# SEO, structured data and answer engines

## The honest position first

Google's own guidance is explicit, and it is worth stating plainly before any
of the machinery below:

- **There is no special structured data, markup or machine-readable file that
  makes a page eligible for AI Overviews or AI Mode.** No schema type, no
  `llms.txt`, no "GEO tag".
- **There are no additional requirements or special optimizations** for those
  surfaces beyond ordinary Search.
- **Meeting technical requirements does not guarantee indexing or serving.**

So this platform builds no AI-specific tricks, because there are none to build.
What it does build is the set of conditions Google actually names — crawlable
pages, findable internal links, correct technical fundamentals, helpful
people-first content — done properly and by default, plus the measurement to
tell whether any of it is working.

Two things have changed recently and are worth designing around:

1. Google publishes a dedicated guide for generative AI features, which
   consolidates the above rather than adding requirements.
2. **Search Console now reports impressions in generative AI features** — AI
   Overviews, AI Mode and AI features in Discover. That matters here: AI
   visibility becomes a first-party metric to ingest, rather than something
   inferred from referrer sniffing. See
   [06 — Analytics](06-analytics-and-attribution.md).

## Metadata

`buildPageMetadata()` in `@bos/seo` produces a framework-neutral shape;
`apps/site` converts it to Next.js `Metadata`. Computing it once means the
sitemap, the OG image generator and any future renderer apply the same rules.

Precedence is always **explicit SEO field → derived from content → nothing**.
There is no fallback that invents a description, because a fabricated meta
description is worse than none.

Every public route carries: title, description, canonical, robots, Open Graph,
Twitter, hreflang alternates, and last-modified. Titles and descriptions are
truncated **at a word boundary** — a mid-word cut looks broken in a SERP.

`robots.txt` is generated, and gated on an explicit `BOS_ALLOW_INDEXING` rather
than on `NODE_ENV` — a preview deployment is a production build, and those are
not the same question. Staging is `Disallow: /` by default.

## The entity graph

Two tables hold the business's knowledge graph:

- `seo_entities` — a node. `kind` mirrors a schema.org type; `stable_id`
  becomes the `@id` fragment, so the same entity keeps its identity across
  every page it appears on.
- `seo_entity_relations` — typed edges. The predicate is a schema.org property
  name (`offers`, `employee`, `areaServed`, `sameAs`), so the graph serialises
  directly.

```
NuESheba (Organization)
   ├── offers ──────→ Academic Transcript Assistance (Service)
   ├── offers ──────→ Certificate Attestation (Service)
   ├── location ────→ Gazipur (LocalBusiness)
   ├── employee ────→ Rubel Hasan (Person)
   ├── areaServed ──→ Bangladesh (Place)
   └── sameAs ──────→ social profiles
```

`content_entities` records which entities a page is _about_, with a role of
`primary` or `mentions`. That table is what makes the next rule enforceable
rather than aspirational.

## JSON-LD generation

Two rules govern every generator in `@bos/seo/structured-data.ts`:

**1. Never emit a node describing content that is not visible on the page.**
Structured data that does not match the page is a policy violation, and the
practical consequence is that the markup is ignored — so it is not even a
shortcut that works. This is enforced by construction: `faqNode()` is built
from the FAQ items in _rendered_ `faq` sections that have `emitSchema` on, not
from a separate field somebody could forget to update. `localBusinessNode()` is
emitted only where the page actually shows the address. `AggregateRating` may
only be built from reviews the page displays.

**2. One connected `@graph` per page, with stable `@id`s.** Cross-references
use `{ '@id': ... }` rather than repeating a node, so the Organization on the
contact page and the one on a service page are recognisably the same entity.

```
<siteUrl>/#organization        site-wide
<siteUrl>/#website
<siteUrl>/#location-<slug>
<pageUrl>#webpage              page-scoped
<pageUrl>#breadcrumb
<pageUrl>#service
<pageUrl>#article
<pageUrl>#faq
```

Serialisation escapes `<` so a stray `</script>` inside page copy cannot close
the tag early and turn content into markup.

Types generated: `Organization`, `LocalBusiness`, `WebSite`, `WebPage`,
`BreadcrumbList`, `Service`, `Article`/`BlogPosting`, `FAQPage`, `Person`,
`Offer`, `AggregateRating`, `ImageObject`, `VideoObject`.

## Sitemaps

A sitemap index at `/sitemap.xml` pointing at one file per content type:

```
/sitemaps/pages.xml      /sitemaps/services.xml    /sitemaps/locations.xml
/sitemaps/posts.xml      /sitemaps/guides.xml      /sitemaps/landing-pages.xml
```

Split per type because Search Console reports coverage per submitted sitemap —
a split index answers "are the service pages indexed?" directly, which one
combined file never can.

Two behaviours worth stating, because both are easy to get wrong:

- **Noindex routes are excluded outright.** Listing a URL in a sitemap while
  telling crawlers not to index it is a contradictory signal, not a hedge.
- **An empty type returns 404, not an empty `<urlset>`.** A 200 with no URLs
  claims the section exists and is empty, which is a different and worse claim
  than "this file does not exist".

Priority stays coarse — home, then commercial pages, then everything else.
Finer values would imply a precision that does not exist.

## Indexing notification

```
publish → update the affected sitemap segment
        → purge the CDN for that URL
        → submit to IndexNow
        → write an indexing_events row with the outcome
```

The last step is the one people skip and the one that matters. Without it,
"not indexed" and "never submitted" look identical from the dashboard, and they
call for opposite responses. `indexing_events` records provider, URL, status,
HTTP status and reason, batched by `batch_id`.

`buildIndexNowPayload()` rejects a batch containing a URL from another host
before sending, because a single foreign URL rejects the whole batch at the
endpoint.

**Submitting a URL is a request, not a promise of indexing.** The dashboard
labels it that way.

## Answer-first page structure

This is the part that genuinely helps across ordinary search, featured
snippets, voice and AI retrieval — not because any of them reward a magic
format, but because a page that answers its question early and completely is
easier for a human in a hurry and easier to quote.

The service-page section order:

```
hero                    H1 + a direct answer, before any marketing copy
what the service is
who needs it
requirements            documents and information to supply
process                 numbered steps with realistic durations
timeline & pricing      including "on request" where that is the truth
common problems
how we help
local information
FAQ                     real questions, answered on the page
related services        editorially chosen internal links
CTA
```

The `hero` section has an `answer` field for exactly this. On
`/services/academic-transcript` it reads: _"A National University academic
transcript is usually issued in 15-20 working days once your application and
fees are accepted."_ — before a single sentence of marketing.

## Internal linking

`related-content` sections take **explicit** entry ids rather than running an
algorithm. Internal linking is an editorial decision, and the Phase 7 audit
reports which pages have no inbound internal links — a question that is only
answerable because sections are structured data.

## The SEO audit

Phase 7 scores each page and stores the result on `seo_metadata.scores`.
The scores are diagnostics, not a grade:

| Signal                | What it checks                                                  |
| --------------------- | --------------------------------------------------------------- |
| Metadata completeness | Title, description, canonical, OG image                         |
| Schema coverage       | Emitted types versus what the page renders                      |
| Answerability         | Does the page open with a direct answer?                        |
| Entity coverage       | Which known entities are mentioned; which relevant ones are not |
| Internal linking      | Inbound and outbound internal links                             |
| Local relevance       | Location mentioned where it should be                           |
| Content freshness     | Last meaningful update                                          |
| Indexing state        | Submitted, and what Search Console reports                      |

Suggestions are concrete and page-specific — _"no page covers 'how long does an
NU transcript take?', which appears in Search Console with 40 impressions and
no clicks"_ — rather than another generic score out of 100.

## What this platform deliberately does not do

- **No mass-generated location pages.** NuESheba serves Bangladesh from
  Gazipur; a page per district would be near-duplicate content with nothing
  specific to say, which is the pattern search engines treat as scaled content
  abuse. `areaServed` carries the coverage claim.
- **No schema for content that is not on the page.** Covered above.
- **No `llms.txt`, no AI-specific meta tags.** Google states no new
  machine-readable files are needed. If that changes, it is a small task; until
  it does, it is cargo cult.
- **No promise of fast rankings.** The architecture removes technical
  obstacles and measures outcomes. Content and authority do the rest.

## Sources

- [AI Features and Your Website — Google Search Central](https://developers.google.com/search/docs/appearance/ai-features)
- [Optimizing your website for generative AI features on Google Search](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide)
- [Introducing Search Generative AI performance reports in Search Console](https://developers.google.com/search/blog/2026/06/gen-ai-performance-reports)
- [General Structured Data Guidelines](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)
- [Local Business structured data](https://developers.google.com/search/docs/appearance/structured-data/local-business)
- [IndexNow documentation](https://www.indexnow.org/documentation)
