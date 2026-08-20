# Content and rendering

## The provider interface

```ts
interface ContentProvider {
  readonly name: 'internal' | 'wordpress' | 'markdown';
  getByPath(path: string, locale: string): Promise<ContentEntry | null>;
  getById(id: string): Promise<ContentEntry | null>;
  list(query: ContentQuery): Promise<ContentPage<ContentEntry>>;
  listRoutes(locale?: string): Promise<readonly ContentRoute[]>;
  cacheTagsFor(path: string, locale: string): readonly string[];
}
```

`apps/site` depends on this and nothing else. Templates, metadata builders and
sitemap routes never import a concrete provider — `createContentProvider()` is
the single construction point. That is the mechanism that keeps "WordPress is
optional" true rather than aspirational.

The interface is deliberately narrow enough that a **filesystem** can satisfy
it. That constraint is doing real work: it is what stops database assumptions
(joins, transactions, arbitrary filters) from leaking into templates.

### Implementations

| Provider    | Status         | Notes                                                                                                                     |
| ----------- | -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `internal`  | Implemented    | Reads the Business API. Responses are validated against the content schema before reaching a template.                    |
| `wordpress` | Interface only | Phase 2, TASK-210. Normalises blocks; unknown blocks collapse to a `content` section so a page degrades rather than 500s. |
| `markdown`  | Interface only | Phase 2. For docs sites and clients who want content in git.                                                              |

## The content model

```ts
interface ContentEntry {
  id;
  workspaceId;
  type;
  slug;
  path;
  locale;
  translationGroupId; // all locales of one page share this
  title;
  excerpt;
  status;
  publishedAt;
  updatedAt;
  document: PageDocument; // the ordered sections
  seo: SeoFields;
  fields: Record<string, unknown>; // type-specific
}
```

Eleven content types: `page`, `post`, `service`, `location`, `faq`, `guide`,
`person`, `testimonial`, `case_study`, `offer`, `landing_page`.

`path` is materialised rather than derived, so route lookup is one indexed
equality. A unique index on `(workspace_id, locale, path)` means a duplicate
path is refused by the database instead of resolved by whichever query happened
to run first.

## Sections

A page is `{ sections: [{ id, type, hidden, props }] }`. Seventeen types are
registered; each has a `.strict()` Zod schema, so a typo in stored JSON fails at
publish time rather than rendering a page with a missing heading.

```
hero · content · service-grid · features · faq · testimonials · reviews
cta · pricing · process · stats · team · locations · gallery · logos
form · related-content
```

Two halves, deliberately separated:

- `packages/sections` — what a section's data may contain. Shared by the API
  (validates on write), the site (validates on read) and the dashboard (drives
  the editor form).
- `apps/site/components/sections` — how it looks. A mapped type
  (`{ [T in SectionType]: Renderer<T> }`) makes a missing renderer a **compile
  error**.

`parsePageDocument()` returns `{ sections, errors }` rather than throwing: one
malformed section costs that section, not the page. Errors are surfaced in the
dashboard instead of discovered by a visitor.

### Adding a section type

1. Schema in `packages/sections/src/registry.ts`.
2. Renderer in `apps/site/components/sections/index.tsx` — the compile error
   tells you it is missing.
3. Editor form field in the dashboard.

Nothing else in the platform changes.

### Why not a visual page builder

A drag-and-drop builder is a product in its own right, and what it buys —
editors positioning elements freely — is exactly what destroys design
consistency across many client sites. Structured sections give editorial
freedom over content while the design system keeps presentation.

There is a second benefit that is easy to miss: because sections are data,
"which service pages have no FAQ section?" is a database query. Against stored
HTML it is a scraping exercise. The SEO audit in Phase 7 depends on this.

## Rendering

One route — `app/[[...slug]]/page.tsx` — renders every public page. Templates
do not fork per content type; the section document decides what renders, and
the entry's type decides which JSON-LD nodes the graph gets.

```
request → getByPath(path, locale)
        → null or unpublished? notFound()
        → parsePageDocument()      drop hidden, drop invalid
        → build JSON-LD from what actually rendered
        → <SectionList />
```

## Caching

Phase 1 is `force-dynamic` — honest, and correct while the content API is being
finished. TASK-204 moves it to ISR with tag-based revalidation:

```
publish → revalidateTag(`content:path:${locale}:${path}`)
        → purge the Cloudflare cache for that URL
        → regenerate the sitemap segment
        → submit to IndexNow
        → record an indexing_events row
```

Tags are hierarchical (`content`, `content:ws:<slug>`,
`content:path:<locale>:<path>`) so a publish can purge exactly the affected
pages, one content type, or everything — without maintaining a separate
invalidation map.

## Media versus documents

A distinction the schema enforces, because getting it wrong is the difference
between a public logo and a publicly-readable passport scan:

|           | `media`                       | `documents`                                    |
| --------- | ----------------------------- | ---------------------------------------------- |
| Bucket    | Public R2, CDN-served         | Private R2, never public                       |
| Access    | Direct URL                    | Short-lived signed URL, authorised per request |
| Audit     | No                            | Every issuance and download                    |
| Retention | Manual                        | `retain_until`, swept nightly                  |
| Examples  | Logos, hero images, galleries | Transcripts, certificates, ID scans            |

Anything a user uploads about themselves is a **document**. See
[07 — Security](07-security-and-data-protection.md).
