import { SITEMAP_SEGMENTS, groupRoutesByType, renderSitemapIndexXml } from '@bos/seo';
import { getRoutes } from '@/lib/content';
import { getWorkspace } from '@/lib/workspace';

/**
 * The sitemap index.
 *
 * One file per content type rather than a single list, because Search Console
 * reports coverage per submitted sitemap — a split index answers "are the
 * service pages indexed?" directly, which one combined file never can.
 *
 * Only types that actually have indexable routes are listed. An empty
 * `services.xml` is a submitted file with zero URLs, and it reads as a problem.
 */
/*
 * Rendered per request from cached route data. The data is tag-revalidated on
 * publish, so a new page appears in the sitemap immediately rather than after
 * the next scheduled regeneration.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const workspace = await getWorkspace();
  const routes = await getRoutes(workspace.locale.defaultLocale);
  const grouped = groupRoutesByType(routes);

  const sitemaps = [...grouped.entries()]
    .filter(([, items]) => items.length > 0)
    .map(([type, items]) => ({
      loc: `${workspace.siteUrl}/sitemaps/${SITEMAP_SEGMENTS[type]}.xml`,
      lastmod: items.reduce(
        (latest, route) => (route.updatedAt > latest ? route.updatedAt : latest),
        items[0]!.updatedAt,
      ),
    }));

  return new Response(renderSitemapIndexXml(sitemaps), {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
