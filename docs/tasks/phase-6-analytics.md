# Phase 6 — Analytics

Four tasks. The point of this phase is one report: which pages produce
customers.

---

## TASK-601 — Collection and ingestion

**Depends on** 501 · **Estimate** 4 days

Client script, the `/collect` Worker endpoint, queue ingestion into
`analytics_sessions` and `analytics_events`, and nightly rollups into
`analytics_daily`.

**Acceptance**

- The client script is under 3 KB gzipped and does not block rendering.
- No cookie is set and no raw IP is stored — verified by inspecting both the
  browser and the database, not by reading the code.
- The visitor hash rotates daily; the same client produces different hashes on
  consecutive days.
- Ingestion is idempotent under queue redelivery.
- Rollups are rebuildable from raw events, and a rebuild reproduces them
  exactly.

---

## TASK-602 — Channel resolution and attribution

**Depends on** 601, 402 · **Estimate** 4 days

Resolve channel and source from UTM, click ids and referrer. Record
`attribution_touches`. Link sessions to contacts on form submission. Support
first-touch, last-touch and linear models.

**Acceptance**

- AI assistant referrers are classified where a referrer exists, and the
  dashboard labels the number a **lower bound** — never a count.
- A contact's earlier anonymous sessions are attached on identification.
- Lead-level attribution is frozen at creation and does not drift.
- Switching model changes credit without recomputing from raw sessions.

---

## TASK-603 — Analytics dashboard

**Depends on** 602, 107 · **Estimate** 5 days

Traffic, sources, landing pages, conversion funnel, and the landing-page →
leads → won → revenue report.

**Acceptance**

- The landing-page report renders in under 1 second for a year of data.
- Every number is traceable to its underlying rows.
- Date ranges compare against the previous period.
- The AI-visibility panel states its measurement limits on the panel itself,
  not in a tooltip.

---

## TASK-604 — Search Console ingestion

**Depends on** 601 · **Estimate** 3 days

Daily import of query, page, country and device performance into
`search_performance_daily`, **including generative-AI feature impressions** now
that Search Console reports them.

**Acceptance**

- History is retained beyond Search Console's own 16-month window.
- Generative-AI impressions are imported and distinguishable from ordinary
  Search impressions.
- Backfill on first connection, then incremental.
- Queries with impressions and no clicks are surfaced — those are the content
  gaps TASK-702 acts on.
- OAuth token refresh is handled without manual reconnection.
