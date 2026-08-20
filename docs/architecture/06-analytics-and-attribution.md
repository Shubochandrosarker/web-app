# Analytics and attribution

## Why first-party

The only question worth answering is _which pages produce customers_. A
third-party tag cannot answer it — it does not know about your leads, your
pipeline or your revenue. It can tell you sessions went up.

Collecting on our own domain also sidesteps the two things that make
third-party data unreliable: ad-blockers and consent banners. The design below
avoids needing a consent banner at all, which is a better outcome than
persuading people to click one.

## Collection

```
browser  ──POST /collect──→  Cloudflare Worker  ──queue──→  API  ──→  Postgres
```

At the edge because this is the highest-volume, least-valuable-per-request
endpoint on the platform: a traffic spike must not consume origin capacity that
a form submission needs. The Worker responds `204` immediately and forwards via
`waitUntil`, so the beacon never adds origin latency to a page view.

### Privacy is structural, not configured

- **No cookie.** Nothing is stored on the device.
- **No raw IP.** It is an input to a hash and is never persisted.
- **A daily-rotating salted hash** identifies a _visit_, not a person:
  `SHA-256(date : workspace : ip : user-agent)`. It cannot be reversed to an
  address, and the same person on two days is not linkable.
- **Form submissions store an IP prefix only** — truncated to a /24 or /48.
  Enough for rate limiting and spam analysis, short of retaining a precise
  identifier indefinitely.

**The cost, stated plainly:** returning visitors are not recognised across days
until they identify themselves through a form, and cross-device attribution is
not available. Both are accepted. The alternative is a consent banner and worse
data.

## The event catalogue

```
page_view · session_start · scroll_depth
form_view · form_start · form_submit
cta_click · phone_click · whatsapp_click · email_click
lead_created · appointment_created · purchase · conversion
```

Conversion events carry `value_amount` in minor units, which is what makes
revenue attribution possible later.

## Channel resolution

Every session resolves to a `channel` and, where known, a specific
`source_key`:

| Channel          | Examples of `source_key`                               |
| ---------------- | ------------------------------------------------------ |
| `organic_search` | `google`, `bing`, `duckduckgo`                         |
| `ai_assistant`   | `chatgpt`, `perplexity`, `claude`, `copilot`, `gemini` |
| `paid_search`    | `google_ads`, `bing_ads`                               |
| `social`         | `facebook`, `instagram`, `linkedin`, `youtube`         |
| `referral`       | the referring host                                     |
| `direct`         | —                                                      |
| `email`          | resolved from UTM                                      |

Resolution order: explicit UTM → click id (`gclid`, `fbclid`) → referrer host →
`direct`.

### On measuring AI visibility honestly

Referrer-based detection of AI assistants is **partial and will stay partial**.
Some assistants send no referrer, some strip it, and a user who reads an answer
and types your name into their browser afterwards arrives as `direct`. The
dashboard labels this a _lower bound_, not a count.

The more reliable signal is now first-party: **Search Console reports
impressions in Google's generative AI features** — AI Overviews, AI Mode, and
AI features in Discover. `search_performance_daily` ingests those alongside
ordinary query data (TASK-604), so AI visibility on Google is measured rather
than inferred. Referrer classification remains useful for assistants outside
Google, with its limits stated.

## Attribution

`attribution_touches` records each touch with `position`, `is_first_touch` and
`is_last_touch`, keyed to the contact and — once one exists — the lead. Storing
touches separately from sessions means a conversion can be credited under
several models without recomputing from raw sessions each time.

One detail that matters: **attribution is copied onto the lead at creation**,
not read through the contact. A returning visitor's contact-level last-touch
changes with every later visit; what drove _this particular enquiry_ must not.

## Rollups

`analytics_daily` pre-aggregates by `channel`, `landing_path`, `campaign` and
`total`. The dashboard reads rollups and never scans raw events. They are
derived data, rebuildable at any time, recomputed nightly and after a backfill.

## The one report that justifies all of this

```
Landing page                          Sessions  Leads   Won   Revenue   CvR
/services/academic-transcript              412     38    11    ৳44,000  9.2%
/services/attestation                      287     19     4    ৳16,000  6.6%
/national-university/guides/transcript     356      4     1     ৳4,000  1.1%
```

That third row is the point. A guide with more traffic than a service page and
a tenth of the conversion rate is not a failure — it is a top-of-funnel page
that needs an internal link to the service it explains. Nothing in a
third-party analytics tool can tell you that, because it does not know which
sessions became customers.

## Connected sources

Ingested on schedules, into the same tables:

| Source                  | Brings                                                   |
| ----------------------- | -------------------------------------------------------- |
| Google Search Console   | Queries, pages, positions, and generative-AI impressions |
| Google Analytics 4      | Cross-check; not the system of record                    |
| Google Ads / Meta       | Spend and campaign performance for cost-per-lead         |
| Google Business Profile | Local actions: calls, direction requests                 |

GA4 is deliberately a cross-check. Two systems of record for the same question
produce two answers and an argument.
