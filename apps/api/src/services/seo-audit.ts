import { and, eq, gte, isNull } from 'drizzle-orm';
import { schema, withWorkspace, type Database } from '@bos/database';

/**
 * The SEO audit engine.
 *
 * Deterministic checks over the published content set, plus Search Console
 * where it has been ingested. Every finding names the page and the reason —
 * there is deliberately **no composite score**: a number like "78/100"
 * manufactures precision out of heuristics, and the honest output is "these
 * pages have these problems, ranked by how much they matter".
 *
 * Runs live on request. The content sets this platform serves are tens to
 * hundreds of pages; a nightly materialisation would only add staleness.
 */

export type AuditSeverity = 'critical' | 'warning' | 'notice';

export interface AuditFinding {
  readonly path: string;
  readonly title: string;
  readonly detail: string;
}

/**
 * `technical` keeps crawlers working, `content` keeps visitors reading,
 * `answers` is AEO/GEO — whether a page gives answer engines and generative
 * assistants something they can quote. All three are deterministic checks
 * over real page data; none produces a composite score.
 */
export type AuditCategory = 'technical' | 'content' | 'answers';

export interface AuditCheck {
  readonly id: string;
  readonly severity: AuditSeverity;
  readonly category: AuditCategory;
  readonly label: string;
  /** Why this matters — shown to a non-specialist owner. */
  readonly explanation: string;
  readonly findings: readonly AuditFinding[];
}

export interface SeoAudit {
  readonly generatedAt: string;
  readonly pagesAudited: number;
  readonly summary: Record<AuditSeverity, number>;
  readonly checks: readonly AuditCheck[];
  readonly opportunities: readonly {
    query: string;
    clicks: number;
    impressions: number;
    position: number;
    kind: 'striking_distance' | 'low_ctr';
  }[];
}

interface PageRow {
  readonly id: string;
  readonly type: string;
  readonly path: string;
  readonly title: string;
  readonly excerpt: string | null;
  readonly document: unknown;
  readonly seo: { title?: string; description?: string; noindex?: boolean } | null;
}

/** Collect internal link targets and image alts by walking section props. */
function walkDocument(document: unknown): {
  internalLinks: string[];
  textLength: number;
  imagesMissingAlt: number;
  hasFaq: boolean;
  faqCount: number;
  firstSectionTextLength: number;
} {
  const internalLinks: string[] = [];
  let textLength = 0;
  let imagesMissingAlt = 0;
  let hasFaq = false;
  let faqCount = 0;
  let firstSectionTextLength = -1;

  const sections = Array.isArray((document as { sections?: unknown[] })?.sections)
    ? ((document as { sections: unknown[] }).sections as {
        type?: string;
        hidden?: boolean;
        props?: Record<string, unknown>;
      }[])
    : [];

  const visit = (value: unknown, key: string | null): void => {
    if (typeof value === 'string') {
      if ((key === 'href' || key === 'url' || key === 'link') && value.startsWith('/')) {
        internalLinks.push(value.replace(/[#?].*$/, '').replace(/\/+$/, '') || '/');
      } else if (key === 'html') {
        // Anchors inside rich text; the sanitiser has already vetted schemes.
        for (const match of value.matchAll(/href="(\/[^"#?]*)/g)) {
          internalLinks.push((match[1] ?? '/').replace(/\/+$/, '') || '/');
        }
        textLength += value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').length;
      } else if (key !== 'id' && key !== 'type' && key !== 'mediaId') {
        textLength += value.length;
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      // A media object with a url but no alt is an image nobody described.
      if (typeof record.mediaId === 'string' || typeof record.url === 'string') {
        if ('alt' in record && !record.alt) imagesMissingAlt += 1;
      }
      for (const [childKey, child] of Object.entries(record)) visit(child, childKey);
    }
  };

  for (const section of sections) {
    if (section.hidden) continue;
    if (section.type === 'faq') {
      hasFaq = true;
      const items = (section.props as { items?: unknown[] } | undefined)?.items;
      faqCount += Array.isArray(items) ? items.length : 0;
    }
    const before = textLength;
    visit(section.props ?? {}, null);
    // The first visible section's own text: what a reader (or an answer
    // engine) gets before scrolling. Hero/heading sections count.
    if (firstSectionTextLength < 0) firstSectionTextLength = textLength - before;
  }

  return {
    internalLinks,
    textLength,
    imagesMissingAlt,
    hasFaq,
    faqCount,
    firstSectionTextLength: Math.max(0, firstSectionTextLength),
  };
}

export async function runSeoAudit(db: Database, workspaceId: string): Promise<SeoAudit> {
  const { pages, gsc } = await withWorkspace(db, workspaceId, async (tx) => {
    const rows = await tx
      .select({
        id: schema.contentEntries.id,
        type: schema.contentEntries.type,
        path: schema.contentEntries.path,
        title: schema.contentEntries.title,
        excerpt: schema.contentEntries.excerpt,
        document: schema.contentEntries.document,
        seoTitle: schema.seoMetadata.title,
        seoDescription: schema.seoMetadata.description,
        seoNoindex: schema.seoMetadata.noindex,
      })
      .from(schema.contentEntries)
      .leftJoin(schema.seoMetadata, eq(schema.seoMetadata.contentEntryId, schema.contentEntries.id))
      .where(
        and(eq(schema.contentEntries.status, 'published'), isNull(schema.contentEntries.deletedAt)),
      );
    const pages: PageRow[] = rows.map((row) => ({
      id: row.id,
      type: row.type,
      path: row.path,
      title: row.title,
      excerpt: row.excerpt,
      document: row.document,
      seo: {
        ...(row.seoTitle ? { title: row.seoTitle } : {}),
        ...(row.seoDescription ? { description: row.seoDescription } : {}),
        noindex: row.seoNoindex ?? false,
      },
    }));

    const since = new Date(Date.now() - 28 * 86_400_000).toISOString().slice(0, 10);
    const gsc = await tx
      .select({
        dimension: schema.searchConsoleDaily.dimension,
        value: schema.searchConsoleDaily.dimensionValue,
        clicks: schema.searchConsoleDaily.clicks,
        impressions: schema.searchConsoleDaily.impressions,
        positionTimes100: schema.searchConsoleDaily.positionTimes100,
      })
      .from(schema.searchConsoleDaily)
      .where(gte(schema.searchConsoleDaily.date, since));

    return { pages, gsc };
  });

  const walked = new Map(pages.map((page) => [page.id, walkDocument(page.document)]));
  const knownPaths = new Set(pages.map((page) => page.path.replace(/\/+$/, '') || '/'));
  const linkedTo = new Set<string>();
  for (const page of pages) {
    for (const target of walked.get(page.id)?.internalLinks ?? []) linkedTo.add(target);
  }

  const checks: AuditCheck[] = [];
  const add = (
    id: string,
    severity: AuditSeverity,
    category: AuditCategory,
    label: string,
    explanation: string,
    findings: AuditFinding[],
  ): void => {
    if (findings.length > 0) checks.push({ id, severity, category, label, explanation, findings });
  };

  /* --------------------------------------------------------- structural */

  add(
    'missing-home',
    'critical',
    'technical',
    'No published home page',
    'Visitors and crawlers landing on the root get a 404 — nothing else matters until this exists.',
    knownPaths.has('/')
      ? []
      : [{ path: '/', title: '(root)', detail: 'No entry is published at /' }],
  );

  add(
    'broken-internal-links',
    'critical',
    'technical',
    'Internal links to pages that do not exist',
    'A broken link loses the visitor and wastes crawl budget; these are links on your own pages.',
    pages.flatMap((page) =>
      [...new Set(walked.get(page.id)?.internalLinks ?? [])]
        .filter(
          (target) =>
            !knownPaths.has(target) &&
            // Non-content routes the platform serves outside the CMS.
            !/^\/(api|forms|_next|sitemap|robots)/.test(target),
        )
        .map((target) => ({ path: page.path, title: page.title, detail: `Links to ${target}` })),
    ),
  );

  add(
    'orphan-pages',
    'warning',
    'technical',
    'Pages nothing links to',
    'A page no other page links to is hard for visitors to find and weak in search — link it from a relevant page or the navigation.',
    pages
      .filter((page) => {
        const path = page.path.replace(/\/+$/, '') || '/';
        return path !== '/' && !linkedTo.has(path);
      })
      .map((page) => ({ path: page.path, title: page.title, detail: 'No internal links found' })),
  );

  /* ----------------------------------------------------------- metadata */

  add(
    'missing-description',
    'warning',
    'content',
    'Pages without a meta description',
    'Search engines write their own snippet when none is set — usually worse than yours would be.',
    pages
      .filter((page) => !page.seo?.description)
      .map((page) => ({ path: page.path, title: page.title, detail: 'No SEO description set' })),
  );

  add(
    'title-length',
    'notice',
    'content',
    'Titles outside 15–60 characters',
    'Long titles truncate in results; very short ones waste the space that earns the click.',
    pages
      .map((page) => ({ page, effective: page.seo?.title ?? page.title }))
      .filter(({ effective }) => effective.length > 60 || effective.length < 15)
      .map(({ page, effective }) => ({
        path: page.path,
        title: page.title,
        detail: `Title is ${effective.length} characters`,
      })),
  );

  const titleCounts = new Map<string, PageRow[]>();
  for (const page of pages) {
    const key = (page.seo?.title ?? page.title).toLowerCase().trim();
    titleCounts.set(key, [...(titleCounts.get(key) ?? []), page]);
  }
  add(
    'duplicate-titles',
    'warning',
    'content',
    'Pages competing for the same title',
    'Two pages with the same title compete against each other in search (cannibalisation) — differentiate them or merge them.',
    [...titleCounts.values()]
      .filter((group) => group.length > 1)
      .flatMap((group) =>
        group.map((page) => ({
          path: page.path,
          title: page.title,
          detail: `Shares its title with ${group.length - 1} other page${group.length > 2 ? 's' : ''}`,
        })),
      ),
  );

  add(
    'noindex-published',
    'notice',
    'technical',
    'Published pages marked noindex',
    'Deliberate sometimes — but a noindex page earns no search traffic, so each one should be intentional.',
    pages
      .filter((page) => page.seo?.noindex)
      .map((page) => ({ path: page.path, title: page.title, detail: 'noindex is set' })),
  );

  /* ------------------------------------------------------------- content */

  add(
    'thin-content',
    'warning',
    'content',
    'Pages with very little text',
    'Under ~300 characters there is little for search engines — or people — to work with.',
    pages
      .filter((page) => (walked.get(page.id)?.textLength ?? 0) < 300)
      .map((page) => ({
        path: page.path,
        title: page.title,
        detail: `~${walked.get(page.id)?.textLength ?? 0} characters of text`,
      })),
  );

  add(
    'images-missing-alt',
    'warning',
    'content',
    'Images without alt text',
    'Alt text is accessibility first and image search second; empty alts fail both.',
    pages
      .filter((page) => (walked.get(page.id)?.imagesMissingAlt ?? 0) > 0)
      .map((page) => ({
        path: page.path,
        title: page.title,
        detail: `${walked.get(page.id)?.imagesMissingAlt} image${
          (walked.get(page.id)?.imagesMissingAlt ?? 0) > 1 ? 's' : ''
        } without alt text`,
      })),
  );

  add(
    'services-without-faq',
    'notice',
    'answers',
    'Service pages without a FAQ section',
    'Answer-first content wins featured snippets and AI-assistant citations; a FAQ section also emits FAQPage structured data automatically.',
    pages
      .filter((page) => page.type === 'service' && !walked.get(page.id)?.hasFaq)
      .map((page) => ({ path: page.path, title: page.title, detail: 'No FAQ section' })),
  );

  add(
    'answer-first-opening',
    'warning',
    'answers',
    'Service and guide pages with no direct answer at the top',
    'Answer engines quote the first thing on the page. When the opening section carries almost ' +
      'no text, a visitor — and an AI assistant — has to scroll to learn what the service is, ' +
      'and the quotable summary that wins citations does not exist.',
    pages
      .filter((page) => page.type === 'service' || page.type === 'guide')
      .filter((page) => (walked.get(page.id)?.firstSectionTextLength ?? 0) < 140)
      .map((page) => ({
        path: page.path,
        title: page.title,
        detail: `~${walked.get(page.id)?.firstSectionTextLength ?? 0} characters before the first scroll`,
      })),
  );

  add(
    'thin-faq',
    'notice',
    'answers',
    'FAQ sections with fewer than three questions',
    'One or two questions read as decoration. Real FAQs from real enquiries are what generative ' +
      'assistants cite — and what stops the same question arriving on WhatsApp five times a week.',
    pages
      .filter((page) => {
        const doc = walked.get(page.id);
        return doc?.hasFaq && doc.faqCount > 0 && doc.faqCount < 3;
      })
      .map((page) => ({
        path: page.path,
        title: page.title,
        detail: `${walked.get(page.id)?.faqCount} question(s)`,
      })),
  );

  /* ---------------------------------------------------- GSC opportunities */

  const byQuery = new Map<string, { clicks: number; impressions: number; posWeighted: number }>();
  for (const row of gsc) {
    if (row.dimension !== 'query') continue;
    const entry = byQuery.get(row.value) ?? { clicks: 0, impressions: 0, posWeighted: 0 };
    entry.clicks += row.clicks;
    entry.impressions += row.impressions;
    entry.posWeighted += row.positionTimes100 * row.impressions;
    byQuery.set(row.value, entry);
  }

  const opportunities = [...byQuery.entries()]
    .map(([query, entry]) => ({
      query,
      clicks: entry.clicks,
      impressions: entry.impressions,
      position: entry.impressions > 0 ? entry.posWeighted / entry.impressions / 100 : 0,
    }))
    .flatMap((row): SeoAudit['opportunities'][number][] => {
      if (row.impressions >= 50 && row.position > 3.5 && row.position <= 20) {
        return [
          { ...row, position: Math.round(row.position * 10) / 10, kind: 'striking_distance' },
        ];
      }
      if (row.impressions >= 100 && row.position <= 10 && row.clicks / row.impressions < 0.01) {
        return [{ ...row, position: Math.round(row.position * 10) / 10, kind: 'low_ctr' }];
      }
      return [];
    })
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 50);

  const summary: Record<AuditSeverity, number> = { critical: 0, warning: 0, notice: 0 };
  for (const check of checks) summary[check.severity] += check.findings.length;

  return {
    generatedAt: new Date().toISOString(),
    pagesAudited: pages.length,
    summary,
    checks,
    opportunities,
  };
}
