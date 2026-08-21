import { unstable_cache } from 'next/cache';
import {
  createContentProvider,
  type ContentEntry,
  type ContentProvider,
  type ContentRoute,
} from '@bos/content';

/**
 * The site's one content dependency.
 *
 * Everything downstream — templates, metadata, sitemaps — talks to the
 * `ContentProvider` interface. Swapping `CONTENT_PROVIDER` between `internal`,
 * `wordpress` and `markdown` changes nothing else in this app, which is the
 * mechanism that keeps "WordPress is optional" true rather than aspirational.
 *
 * ## Caching
 *
 * Phase 1 marked every page `force-dynamic`, which meant a database round trip
 * per request. This replaces it — but with cached *data* rather than cached
 * *HTML*, and that choice is worth stating because it is not the obvious one.
 *
 * Full static generation would be faster still. It is incompatible with the
 * nonce-based Content Security Policy the site now sends: a nonce must differ
 * per response, and a cached HTML document carries whichever nonce it was
 * generated with. Serving one nonce to every visitor makes the policy
 * decorative.
 *
 * So the page renders per request from cached data. A render with no I/O is
 * sub-millisecond work; the round trip is what cost 200ms, and that is what is
 * cached — tagged, so publishing one page revalidates that page's data and
 * nothing else. "Do not purge the entire site for one page edit" is a property
 * of the tags below.
 */
let cached: ContentProvider | undefined;

export function getContentProvider(): ContentProvider {
  if (cached) return cached;

  const provider = process.env.CONTENT_PROVIDER ?? 'internal';
  const workspaceSlug = process.env.BOS_WORKSPACE_SLUG ?? 'default';

  switch (provider) {
    case 'wordpress': {
      const apiUrl = process.env.WORDPRESS_API_URL;
      if (!apiUrl) throw new Error('CONTENT_PROVIDER=wordpress requires WORDPRESS_API_URL.');
      cached = createContentProvider({
        provider: 'wordpress',
        apiUrl,
        ...(process.env.WORDPRESS_APP_USER ? { username: process.env.WORDPRESS_APP_USER } : {}),
        ...(process.env.WORDPRESS_APP_PASSWORD
          ? { applicationPassword: process.env.WORDPRESS_APP_PASSWORD }
          : {}),
      });
      break;
    }
    case 'markdown':
      cached = createContentProvider({
        provider: 'markdown',
        contentDir: process.env.CONTENT_DIR ?? './content',
        defaultLocale: process.env.DEFAULT_LOCALE ?? 'en',
      });
      break;
    case 'internal':
    default:
      cached = createContentProvider({
        provider: 'internal',
        apiUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
        workspaceSlug,
        ...(process.env.API_SERVICE_TOKEN ? { apiToken: process.env.API_SERVICE_TOKEN } : {}),
      });
  }

  return cached;
}

/**
 * Cache tags.
 *
 * Hierarchical, so a publish can purge one page, one content type, or
 * everything, without a separate invalidation map to keep in step.
 */
export function pageTag(path: string, locale: string): string {
  return `content:path:${locale}:${path}`;
}

export const ROUTES_TAG = 'content:routes';

/**
 * How long cached content survives without an explicit purge.
 *
 * Five minutes rather than an hour: publishing calls `/api/revalidate` and the
 * page updates immediately, so this is only the backstop for the case where
 * that call failed. An hour of stale content after a failed webhook is a
 * support ticket; five minutes is not.
 */
const REVALIDATE_SECONDS = 300;

export const getPageByPath = (path: string, locale: string): Promise<ContentEntry | null> =>
  unstable_cache(
    async () => getContentProvider().getByPath(path, locale),
    ['content-by-path', path, locale],
    { tags: [pageTag(path, locale), 'content'], revalidate: REVALIDATE_SECONDS },
  )();

export const getRoutes = (locale: string): Promise<readonly ContentRoute[]> =>
  unstable_cache(async () => getContentProvider().listRoutes(locale), ['content-routes', locale], {
    tags: [ROUTES_TAG, 'content'],
    revalidate: REVALIDATE_SECONDS,
  })();
