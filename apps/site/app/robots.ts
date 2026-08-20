import type { MetadataRoute } from 'next';
import { getWorkspace } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

export default async function robots(): Promise<MetadataRoute.Robots> {
  const workspace = await getWorkspace();

  /**
   * A staging deployment must never be indexable. This is keyed on an explicit
   * environment variable rather than on NODE_ENV, because a preview build is a
   * production build — the two are not the same question.
   */
  const indexable = process.env.BOS_ALLOW_INDEXING === 'true';

  if (!indexable) {
    return { rules: [{ userAgent: '*', disallow: '/' }] };
  }

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // Neither is secret; both are noise in a crawl budget.
        disallow: ['/api/', '/_next/'],
      },
    ],
    sitemap: `${workspace.siteUrl}/sitemap.xml`,
    host: workspace.siteUrl,
  };
}
