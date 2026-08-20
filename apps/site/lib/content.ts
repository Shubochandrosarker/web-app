import { createContentProvider, type ContentProvider } from '@bos/content';

/**
 * The site's one content dependency.
 *
 * Everything downstream — templates, metadata, sitemaps — talks to the
 * `ContentProvider` interface. Swapping `CONTENT_PROVIDER` between `internal`,
 * `wordpress` and `markdown` changes nothing else in this app, which is the
 * mechanism that keeps "WordPress is optional" true rather than aspirational.
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
