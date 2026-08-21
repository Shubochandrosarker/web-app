import { revalidateTag } from 'next/cache';
import { timingSafeEqual } from 'node:crypto';
import { buildIndexNowPayload, INDEXNOW_ENDPOINT } from '@bos/seo';
import { pageTag, ROUTES_TAG } from '@/lib/content';
import { getWorkspace } from '@/lib/workspace';

/**
 * Publish-time cache invalidation.
 *
 * Called by the API when a page is published. Three things happen, in this
 * order, and the order is the point:
 *
 *  1. **Revalidate the page's data tag.** The next request for that path
 *     re-reads it. Nothing else is touched — a hundred other pages keep their
 *     cached data, which is the difference between this and purging the zone.
 *
 *  2. **Revalidate the route index**, so the sitemap picks up a new URL.
 *
 *  3. **Submit to IndexNow** — but only after the two above, because
 *     announcing a URL that the site would still serve from a stale cache is
 *     an invitation to crawl a 404.
 *
 * Authenticated by the same shared secret the edge Worker uses. This endpoint
 * can purge cache for any path, so an unauthenticated version would be a free
 * denial-of-service against the origin.
 */

export const dynamic = 'force-dynamic';

interface RevalidateBody {
  readonly paths?: string[];
  readonly locale?: string;
  readonly submitToIndexNow?: boolean;
}

function secretsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  const expected = process.env.EDGE_SHARED_SECRET ?? '';
  if (!expected) {
    return Response.json(
      { error: 'Revalidation is not configured on this deployment.' },
      { status: 503 },
    );
  }

  const presented = request.headers.get('x-bos-edge-secret') ?? '';
  if (!secretsMatch(presented, expected)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: RevalidateBody;
  try {
    body = (await request.json()) as RevalidateBody;
  } catch {
    return Response.json({ error: 'Malformed body' }, { status: 400 });
  }

  const workspace = await getWorkspace();
  const locale = body.locale ?? workspace.locale.defaultLocale;

  // Bounded so one call cannot be used to purge everything one path at a time.
  const paths = (body.paths ?? []).filter((path) => path.startsWith('/')).slice(0, 100);

  if (paths.length === 0) {
    return Response.json({ error: 'No paths given' }, { status: 400 });
  }

  /*
   * `{ expire: 0 }` rather than a named cacheLife profile: the point of a
   * publish webhook is that the next request sees the new content, so the
   * cached entry expires now and not at the end of some profile's window.
   */
  const immediately = { expire: 0 } as const;
  for (const path of paths) revalidateTag(pageTag(path, locale), immediately);
  revalidateTag(ROUTES_TAG, immediately);

  /*
   * IndexNow.
   *
   * Skipped entirely when the site is not indexable — submitting a staging URL
   * to a search engine is the one mistake `BOS_ALLOW_INDEXING` exists to
   * prevent, and it would be an odd place to forget it.
   */
  const indexable = process.env.BOS_ALLOW_INDEXING === 'true';
  const indexNowKey = process.env.INDEXNOW_KEY;
  let indexNow: 'skipped' | 'submitted' | 'failed' = 'skipped';

  if (indexable && indexNowKey && body.submitToIndexNow !== false) {
    try {
      const payload = buildIndexNowPayload({
        host: new URL(workspace.siteUrl).host,
        key: indexNowKey,
        urlList: paths.map((path) => new URL(path, workspace.siteUrl).toString()),
      });

      const response = await fetch(INDEXNOW_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });

      indexNow = response.ok ? 'submitted' : 'failed';
    } catch {
      // A failed submission is not a failed publish. The page is live and
      // cached correctly; the search engine will find it on its own schedule.
      indexNow = 'failed';
    }
  }

  return Response.json({ revalidated: paths.length, paths, indexNow });
}
