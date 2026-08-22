import { createHash } from 'node:crypto';
import { pageDocumentSchema } from '@bos/sections';
import { htmlToPlainText, sanitizeContentHtml } from '@bos/sanitize';
import {
  ContentProviderError,
  contentEntrySchema,
  type ContentEntry,
  type ContentPage,
  type ContentProvider,
  type ContentQuery,
  type ContentRoute,
  type ContentType,
} from '../types.ts';

export interface WordPressProviderOptions {
  readonly apiUrl: string;
  readonly username?: string;
  readonly applicationPassword?: string;
  readonly fetchImpl?: typeof fetch;
  readonly requestTimeoutMs?: number;
}

/** WP REST resource types this adapter reads. */
const RESOURCES = ['pages', 'posts'] as const;
type Resource = (typeof RESOURCES)[number];

/** Decode the handful of entities WordPress emits into rendered titles. */
function decodeEntities(text: string): string {
  return (
    text
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      // Last, so `&amp;lt;` decodes to the literal text `&lt;` and no further.
      .replace(/&amp;/g, '&')
  );
}

interface WordPressItem {
  id: number;
  slug: string;
  type: string;
  link: string;
  status?: string;
  date_gmt?: string;
  modified_gmt?: string;
  title?: { rendered?: string };
  excerpt?: { rendered?: string };
  content?: { rendered?: string };
}

/**
 * WordPress adapter — an *optional content source*, never the system of record.
 *
 * WordPress supplies editorial text and media through its REST API. It has no
 * say in routing, rendering, SEO output or anything in the business modules.
 * Two decisions carry the security and correctness weight:
 *
 *  - **Rendered HTML is sanitised here**, with the same policy the internal
 *    CMS enforces at its write boundary. WordPress content is the owner's,
 *    but a compromised plugin injecting a `<script>` must not ride into the
 *    site through this side door.
 *  - **Ids are derived, stably.** Our entry ids are UUIDs; WordPress ids are
 *    integers. Each item's UUID is a deterministic hash of the endpoint,
 *    resource and numeric id, so the same page keeps the same id across
 *    fetches — which is what cache keys and `getById` need.
 *
 * Only published content is exposed. Draft preview stays a feature of the
 * internal CMS; a WordPress draft simply does not exist here.
 */
export class WordPressContentProvider implements ContentProvider {
  readonly name = 'wordpress' as const;

  private readonly options: WordPressProviderOptions;
  private readonly endpoint: string;

  constructor(options: WordPressProviderOptions) {
    this.options = options;
    this.endpoint = options.apiUrl.replace(/\/+$/, '');
  }

  /* ------------------------------------------------------------- transport */

  private async request(pathAndQuery: string): Promise<{ body: unknown; totalPages: number }> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.options.username && this.options.applicationPassword) {
      headers.authorization = `Basic ${Buffer.from(
        `${this.options.username}:${this.options.applicationPassword}`,
      ).toString('base64')}`;
    }

    let response: Response;
    try {
      response = await fetchImpl(`${this.endpoint}/wp-json/wp/v2/${pathAndQuery}`, {
        headers,
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 10_000),
      });
    } catch (error) {
      throw new ContentProviderError(
        this.name,
        'request',
        `fetch failed for ${pathAndQuery}`,
        error,
      );
    }
    if (!response.ok) {
      throw new ContentProviderError(
        this.name,
        'request',
        `WordPress answered ${response.status} for ${pathAndQuery}`,
      );
    }
    return {
      body: await response.json(),
      totalPages: Number(response.headers.get('x-wp-totalpages') ?? '1') || 1,
    };
  }

  /* ------------------------------------------------------------ conversion */

  /** Deterministic UUID for a WordPress item: same input, same id, forever. */
  entryId(resource: Resource, wordpressId: number): string {
    const digest = createHash('sha256')
      .update(`${this.endpoint}|${resource}|${wordpressId}`)
      .digest('hex');
    // Format as a v4-shaped UUID; the variant bits satisfy uuid validation.
    return [
      digest.slice(0, 8),
      digest.slice(8, 12),
      `4${digest.slice(13, 16)}`,
      `8${digest.slice(17, 20)}`,
      digest.slice(20, 32),
    ].join('-');
  }

  /** The site path for an item, taken from its canonical link. */
  private pathFor(item: WordPressItem): string {
    try {
      const path = new URL(item.link).pathname.replace(/\/+$/, '');
      return path === '' ? '/' : path;
    } catch {
      return `/${item.slug}`;
    }
  }

  private toEntry(resource: Resource, item: WordPressItem, locale: string): ContentEntry {
    const title = decodeEntities(htmlToPlainText(item.title?.rendered ?? '').trim()) || item.slug;
    const excerpt = decodeEntities(htmlToPlainText(item.excerpt?.rendered ?? '').trim()).slice(
      0,
      600,
    );
    const sanitised = sanitizeContentHtml(item.content?.rendered ?? '', {
      siteOrigin: this.endpoint,
    });

    return contentEntrySchema.parse({
      id: this.entryId(resource, item.id),
      workspaceId: this.entryId(resource, 0),
      type: WordPressContentProvider.mapPostType(item.type),
      slug: item.slug,
      path: this.pathFor(item),
      locale,
      title: title.slice(0, 300),
      ...(excerpt ? { excerpt } : {}),
      status: 'published',
      ...(item.date_gmt ? { publishedAt: `${item.date_gmt}Z`.replace(/ZZ$/, 'Z') } : {}),
      updatedAt: item.modified_gmt
        ? `${item.modified_gmt}Z`.replace(/ZZ$/, 'Z')
        : new Date().toISOString(),
      document: WordPressContentProvider.normaliseDocument(sanitised.html),
      seo: { noindex: false, nofollow: false, schemaOverrides: [] },
      fields: { wordpressId: item.id, wordpressType: item.type },
      translations: {},
    });
  }

  /* --------------------------------------------------------------- reading */

  async getByPath(path: string, locale: string): Promise<ContentEntry | null> {
    const wanted = path.replace(/\/+$/, '') || '/';
    const slug = wanted.split('/').filter(Boolean).pop() ?? '';
    if (!slug) {
      // The homepage: WordPress models it as a page marked "front"; the
      // cheapest reliable lookup is the first page whose link is the root.
      const { body } = await this.request('pages?per_page=20');
      const items = body as WordPressItem[];
      const front = items.find((item) => this.pathFor(item) === '/');
      return front ? this.toEntry('pages', front, locale) : null;
    }

    // The slug narrows to a handful; the canonical link decides exactly.
    for (const resource of RESOURCES) {
      const { body } = await this.request(`${resource}?slug=${encodeURIComponent(slug)}`);
      const items = body as WordPressItem[];
      const match = items.find((item) => this.pathFor(item) === wanted);
      if (match) return this.toEntry(resource, match, locale);
    }
    return null;
  }

  async getById(id: string): Promise<ContentEntry | null> {
    // Derived ids cannot be reversed, so walk the (bounded) collections and
    // match. WordPress sites this adapter targets are tens of pages, not
    // thousands; listRoutes already pages through everything anyway.
    for (const resource of RESOURCES) {
      for await (const item of this.iterate(resource)) {
        if (this.entryId(resource, item.id) === id) {
          return this.toEntry(resource, item, 'en');
        }
      }
    }
    return null;
  }

  async list(query: ContentQuery): Promise<ContentPage<ContentEntry>> {
    const resource: Resource = query.type === 'post' ? 'posts' : 'pages';
    const perPage = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const page = Math.max(Number(query.cursor ?? '1') || 1, 1);

    const order = query.direction === 'asc' ? 'asc' : 'desc';
    const orderby =
      query.sort === 'title' ? 'title' : query.sort === 'publishedAt' ? 'date' : 'modified';

    const { body, totalPages } = await this.request(
      `${resource}?per_page=${perPage}&page=${page}&order=${order}&orderby=${orderby}`,
    );
    const items = (body as WordPressItem[]).map((item) =>
      this.toEntry(resource, item, query.locale ?? 'en'),
    );

    return {
      items,
      nextCursor: page < totalPages ? String(page + 1) : undefined,
    };
  }

  async listRoutes(locale = 'en'): Promise<readonly ContentRoute[]> {
    const routes: ContentRoute[] = [];
    for (const resource of RESOURCES) {
      for await (const item of this.iterate(resource)) {
        routes.push({
          path: this.pathFor(item),
          locale,
          type: WordPressContentProvider.mapPostType(item.type),
          updatedAt: item.modified_gmt ? `${item.modified_gmt}Z` : new Date().toISOString(),
          noindex: false,
        });
      }
    }
    return routes;
  }

  /** Page through one resource, bounded to a sane maximum. */
  private async *iterate(resource: Resource): AsyncGenerator<WordPressItem> {
    const MAX_PAGES = 20; // 2000 items — far beyond the sites this targets.
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { body, totalPages } = await this.request(
        `${resource}?per_page=100&page=${page}&orderby=modified&order=desc`,
      );
      for (const item of body as WordPressItem[]) yield item;
      if (page >= totalPages) return;
    }
  }

  cacheTagsFor(path: string, locale: string): readonly string[] {
    return ['content', `content:wordpress`, `content:path:${locale}:${path}`];
  }

  /**
   * Maps a WordPress post type to ours. Anything unrecognised becomes a `page`
   * so an editor adding a custom post type degrades to a rendered page instead
   * of a 500.
   */
  static mapPostType(wordpressType: string): ContentType {
    switch (wordpressType) {
      case 'post':
        return 'post';
      case 'page':
        return 'page';
      case 'service':
        return 'service';
      case 'location':
        return 'location';
      default:
        return 'page';
    }
  }

  /**
   * Normalise WordPress block data into a page document. Unknown blocks
   * collapse into a `content` section holding their (sanitised) rendered
   * HTML, so the page still renders — degraded, not broken.
   */
  static normaliseDocument(renderedHtml: string): ReturnType<typeof pageDocumentSchema.parse> {
    return pageDocumentSchema.parse({
      sections: [
        {
          id: '00000000-0000-4000-8000-000000000000',
          type: 'content',
          hidden: false,
          props: { html: renderedHtml, layout: 'prose' },
        },
      ],
    });
  }
}
