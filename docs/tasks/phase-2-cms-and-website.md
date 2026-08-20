# Phase 2 — CMS and website

The phase that makes WordPress unnecessary. Ten tasks.

---

## TASK-201 — Content authoring API

**Depends on** 105 · **Estimate** 5 days

CRUD for content entries. Section documents validated against
`@bos/sections` **on write** — a malformed section must never reach the
database. Revisions on publish. Scheduled publishing. Path uniqueness enforced
per locale. Translation groups.

**Acceptance**

- Writing an invalid section returns 400 naming the field, and nothing is
  written.
- Publishing snapshots a revision; restoring one restores the document exactly.
- A path collision is rejected by the database constraint, not by application
  timing.
- Changing a slug offers to create a redirect, and the offer is recorded either
  way.
- Scheduled entries publish on time and emit `content.published`.

---

## TASK-202 — Section editor

**Depends on** 201, 107 · **Estimate** 8 days

The dashboard editor: add, reorder, duplicate, hide and remove sections. Forms
generated from each type's Zod schema, so a new section type needs no editor
code. Live preview. Draft/publish states.

**Acceptance**

- Adding a section type to `@bos/sections` makes it editable with no dashboard
  change.
- Validation errors appear inline on the offending field.
- Reordering persists and is reflected in the rendered page.
- Hidden sections survive a round-trip so a draft can be toggled back on.
- The editor works on a tablet — content is often edited away from a desk.

---

## TASK-203 — Media library and image pipeline

**Depends on** 201 · **Estimate** 4 days

Direct-to-R2 upload with signed URLs. Server-side type sniffing. Deduplication
by SHA-256. Responsive variants, AVIF/WebP, and a blurhash placeholder so
images reserve space and do not shift layout.

**Acceptance**

- Uploads never pass through the API process.
- The declared content type is ignored; the sniffed type wins.
- Re-uploading an identical file reuses the existing object.
- Alt text is required before a media item can be used in a published page.
- Largest Contentful Paint on a hero image is under 2.5s on a mid-range mobile
  device over 4G.

---

## TASK-204 — ISR, cache tags, publish invalidation

**Depends on** 201 · **Estimate** 3 days

Replace `force-dynamic` with ISR. Tag-based revalidation on publish, plus a CDN
purge for the affected URL.

**Acceptance**

- A published change is live within 5 seconds without a deploy.
- Publishing one page does not purge unrelated pages — verified by cache-hit
  metrics, not by assertion.
- A cold cache renders correctly; an API outage serves stale rather than an
  error.
- Sitemap segments regenerate as part of the same publish flow.

---

## TASK-205 — Remaining section renderers

**Depends on** 103 · **Estimate** 4 days

Ten renderers still stubbed: `service-grid`, `testimonials`, `reviews`,
`pricing`, `team`, `locations`, `gallery`, `logos`, `form`, `related-content`.

**Acceptance**

- Every section type has a real renderer; the `satisfies SectionRenderers`
  check has no `notYetImplemented` entries left.
- Each is keyboard navigable and screen-reader sensible.
- `reviews` renders only approved reviews, and `AggregateRating` is emitted
  only from reviews the page displays.
- No renderer causes cumulative layout shift above 0.1.

---

## TASK-206 — Design system from brand tokens

**Depends on** 205 · **Estimate** 5 days

Generate CSS custom properties from the workspace's brand tokens. Type scale,
spacing, colour roles, focus states, dark mode. Replace the placeholder
`globals.css`.

**Acceptance**

- Changing a brand token in the config restyles the site with no code change.
- Contrast meets WCAG AA in both light and dark, verified by an automated check.
- Focus indicators are visible on every interactive element.
- Lighthouse accessibility ≥ 95 on the home page and a service page.

---

## TASK-207 — SEO entity graph and JSON-LD wiring

**Depends on** 201 · **Estimate** 4 days

Entity CRUD. Automatic entity creation from locations, services and staff.
Relation editing. `content_entities` linking pages to what they are about.
Wire the remaining generators into the page graph.

**Acceptance**

- Creating a service creates its `Service` entity and the `offers` relation.
- JSON-LD validates against Google's Rich Results Test for every page type.
- A node is never emitted for content the page does not render — covered by a
  test, since this is the rule most likely to erode.
- `@id` values are stable across pages and across rebuilds.

---

## TASK-208 — Sitemaps, redirects, IndexNow

**Depends on** 201 · **Estimate** 3 days

Redirect management in the dashboard, served at the edge. IndexNow submission
on publish with outcomes recorded. Search Console API submission where
available.

**Acceptance**

- A slug change creates a working 301 without a deploy.
- Redirect chains are detected and collapsed at save time.
- `indexing_events` records every submission with its outcome, and the
  dashboard distinguishes "not submitted" from "submitted, not indexed".
- The dashboard never claims submission causes indexing.

---

## TASK-209 — Forms

**Depends on** 201 · **Estimate** 5 days

Form builder. Server-side validation from the stored field definitions.
Honeypot plus minimum fill time. Rate limiting per IP prefix. Consent capture.
Submission storage and notification.

**Acceptance**

- Field definitions produce identical validation on client and server, because
  both derive from the same schema.
- Spam controls block scripted submissions without a CAPTCHA.
- Consent is recorded with a timestamp when the form requires it.
- A submission failure never loses the user's input.
- Submissions are visible in the dashboard within 5 seconds.

---

## TASK-210 — WordPress content adapter

**Depends on** 201 · **Estimate** 4 days

Implement `WordPressContentProvider`. Map post types, normalise blocks to
sections, resolve media, cache with tags, handle pagination.

**Acceptance**

- A WordPress site renders through `apps/site` with `CONTENT_PROVIDER=wordpress`
  and no other change.
- Unknown blocks collapse to a `content` section — the page degrades, it does
  not 500.
- WordPress being unreachable serves stale content rather than an error page.
- Application passwords are the only auth method; no plugin is required on the
  WordPress side.
