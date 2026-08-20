# Phases 7-8 — Intelligence and reuse

---

## TASK-701 — SEO audit engine

**Depends on** 207, 604 · **Estimate** 6 days

Per-page scoring across metadata, schema coverage, answerability, entity
coverage, internal linking, local relevance, freshness and indexing state.
Site-wide checks: orphan pages, redirect chains, duplicate titles, thin content,
cannibalisation.

**Acceptance**

- Scores are stored on `seo_metadata.scores` and refreshed nightly.
- Every finding names a specific page and a specific fix.
- Orphan detection uses the section data, not a crawl — the whole reason
  sections are structured.
- Cannibalisation uses real Search Console data, not keyword guesswork.
- Findings are re-checked after a fix, so the list shrinks.

---

## TASK-702 — AI content suggestions

**Depends on** 701 · **Estimate** 5 days

Provider-abstracted AI (Cloudflare, Anthropic, OpenAI). Suggest missing
questions from Search Console queries with impressions and no clicks; missing
entities; internal link opportunities; content refresh candidates.

**Acceptance**

- Suggestions cite the data that produced them — this query, these impressions.
- The provider is swappable by configuration.
- Generated text is always a **draft** requiring human review before publish;
  there is no path from suggestion to published page without a person.
- Cost per workspace is tracked and capped.
- No suggestion recommends adding schema for content that is not on the page.

---

## TASK-801 — Second tenant extraction

**Depends on** 603 · **Estimate** 5 days

Onboard a second business — a different business type — and fix everything that
turns out to be NuESheba-shaped.

**This is the task that tests the architecture.** Until a second business runs
on this codebase with nothing but a config change, "reusable" is a claim rather
than a fact. Expect this task to find real problems; that is its purpose, and
finding none would be the surprising outcome.

**Acceptance**

- The second tenant is live with **no application code changes** — or every
  change required is recorded, with the generalisation that removed it.
- A `grep -ri nuesheba apps/ packages/` returns nothing.
- Both tenants deploy from the same commit.
- The onboarding runbook is written from what was actually done, not from what
  was planned.
- Time to onboard the third tenant is estimated from this one.
