import type { ContentRoute, ContentType } from '@bos/content';

/**
 * Sitemap generation.
 *
 * Split by content type rather than emitting one giant file: a sitemap index
 * pointing at `/sitemaps/services.xml`, `/sitemaps/posts.xml` and so on makes
 * Search Console's coverage report readable per section, which is the only
 * reason the split is worth the extra routes.
 */

export type SitemapChangeFrequency =
  | 'always'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'never';

export interface SitemapEntry {
  readonly loc: string;
  readonly lastmod: string;
  readonly changefreq?: SitemapChangeFrequency | undefined;
  readonly priority?: number | undefined;
  readonly alternates?: readonly { readonly hrefLang: string; readonly href: string }[] | undefined;
}

/** Sitemap files are capped well under the 50,000-URL / 50 MB protocol limit. */
export const SITEMAP_MAX_ENTRIES = 5_000;

export const SITEMAP_SEGMENTS: Readonly<Record<ContentType, string>> = {
  page: 'pages',
  post: 'posts',
  service: 'services',
  location: 'locations',
  faq: 'faqs',
  guide: 'guides',
  person: 'people',
  testimonial: 'testimonials',
  case_study: 'case-studies',
  offer: 'offers',
  landing_page: 'landing-pages',
};

/**
 * Noindex routes are excluded outright. Listing a URL in a sitemap while
 * telling crawlers not to index it is a contradictory signal, not a hedge.
 */
export function routesToSitemapEntries(
  routes: readonly ContentRoute[],
  siteUrl: string,
): SitemapEntry[] {
  return routes
    .filter((route) => !route.noindex)
    .map((route) => ({
      loc: new URL(route.path, siteUrl).toString(),
      lastmod: route.updatedAt,
      changefreq: changeFrequencyFor(route.type),
      priority: priorityFor(route),
    }));
}

export function groupRoutesByType(
  routes: readonly ContentRoute[],
): Map<ContentType, ContentRoute[]> {
  const grouped = new Map<ContentType, ContentRoute[]>();
  for (const route of routes) {
    if (route.noindex) continue;
    const bucket = grouped.get(route.type);
    if (bucket) bucket.push(route);
    else grouped.set(route.type, [route]);
  }
  return grouped;
}

function changeFrequencyFor(type: ContentType): SitemapChangeFrequency {
  switch (type) {
    case 'post':
    case 'offer':
      return 'weekly';
    case 'service':
    case 'location':
    case 'landing_page':
      return 'monthly';
    default:
      return 'yearly';
  }
}

/**
 * Priority is a weak hint at best, so it stays coarse: the home page, then
 * commercial pages, then everything else. Fine-grained values would imply a
 * precision that does not exist.
 */
function priorityFor(route: ContentRoute): number {
  if (route.path === '/') return 1.0;
  if (route.type === 'service' || route.type === 'landing_page') return 0.8;
  if (route.type === 'location' || route.type === 'post') return 0.6;
  return 0.5;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderSitemapXml(entries: readonly SitemapEntry[]): string {
  const needsXhtml = entries.some((entry) => entry.alternates && entry.alternates.length > 0);
  const urls = entries
    .map((entry) => {
      const parts = [
        `    <loc>${escapeXml(entry.loc)}</loc>`,
        `    <lastmod>${entry.lastmod}</lastmod>`,
      ];
      if (entry.changefreq) parts.push(`    <changefreq>${entry.changefreq}</changefreq>`);
      if (entry.priority !== undefined)
        parts.push(`    <priority>${entry.priority.toFixed(1)}</priority>`);
      for (const alternate of entry.alternates ?? []) {
        parts.push(
          `    <xhtml:link rel="alternate" hreflang="${escapeXml(alternate.hrefLang)}" href="${escapeXml(alternate.href)}" />`,
        );
      }
      return `  <url>\n${parts.join('\n')}\n  </url>`;
    })
    .join('\n');

  const xmlns = needsXhtml
    ? 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml"'
    : 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset ${xmlns}>\n${urls}\n</urlset>\n`;
}

export function renderSitemapIndexXml(
  sitemaps: readonly { readonly loc: string; readonly lastmod: string }[],
): string {
  const body = sitemaps
    .map(
      (sitemap) =>
        `  <sitemap>\n    <loc>${escapeXml(sitemap.loc)}</loc>\n    <lastmod>${sitemap.lastmod}</lastmod>\n  </sitemap>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}
