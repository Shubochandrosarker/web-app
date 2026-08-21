import type { ContentType } from '@bos/content';
import {
  SITEMAP_MAX_ENTRIES,
  SITEMAP_SEGMENTS,
  renderSitemapXml,
  routesToSitemapEntries,
} from '@bos/seo';
import { getRoutes } from '@/lib/content';
import { getWorkspace } from '@/lib/workspace';

/** Reverse of SITEMAP_SEGMENTS, so `/sitemaps/services.xml` resolves to `service`. */
const SEGMENT_TO_TYPE = Object.fromEntries(
  Object.entries(SITEMAP_SEGMENTS).map(([type, segment]) => [segment, type as ContentType]),
) as Record<string, ContentType>;

/*
 * Rendered per request from cached route data. The data is tag-revalidated on
 * publish, so a new page appears in the sitemap immediately rather than after
 * the next scheduled regeneration.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ segment: string }> },
): Promise<Response> {
  const { segment } = await params;
  const type = SEGMENT_TO_TYPE[segment.replace(/\.xml$/, '')];

  // An unknown segment is a 404, not an empty sitemap. A 200 with no URLs
  // tells a crawler the section exists and is empty, which is a different and
  // worse claim than "this file does not exist".
  if (!type) return new Response('Not found', { status: 404 });

  const workspace = await getWorkspace();
  const routes = await getRoutes(workspace.locale.defaultLocale);
  const entries = routesToSitemapEntries(
    routes.filter((route) => route.type === type),
    workspace.siteUrl,
  ).slice(0, SITEMAP_MAX_ENTRIES);

  if (entries.length === 0) return new Response('Not found', { status: 404 });

  return new Response(renderSitemapXml(entries), {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
