import { pageDocumentSchema } from '@bos/sections';
import {
  ContentProviderError,
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

/**
 * WordPress adapter — an *optional content source*, never the system of record.
 *
 * WordPress supplies editorial text and media through its REST API. It has no
 * say in routing, rendering, SEO output or anything in the business modules.
 * The page builder here reads structured blocks, not Elementor markup: a
 * WordPress page that has not been authored with the registered block set
 * normalises to a single `content` section rather than pretending to be a
 * designed layout.
 *
 * Deliberately unimplemented until Phase 2 — the interface is what Phase 1
 * needs to freeze. See docs/tasks/phase-2-cms-and-website.md (TASK-210).
 */
export class WordPressContentProvider implements ContentProvider {
  readonly name = 'wordpress' as const;

  private readonly options: WordPressProviderOptions;
  private readonly endpoint: string;

  constructor(options: WordPressProviderOptions) {
    this.options = options;
    this.endpoint = options.apiUrl.replace(/\/+$/, '');
  }

  async getByPath(path: string, locale: string): Promise<ContentEntry | null> {
    throw this.notImplemented('getByPath', { path, locale });
  }

  async getById(id: string): Promise<ContentEntry | null> {
    throw this.notImplemented('getById', { id });
  }

  async list(query: ContentQuery): Promise<ContentPage<ContentEntry>> {
    throw this.notImplemented('list', query as Record<string, unknown>);
  }

  async listRoutes(locale?: string): Promise<readonly ContentRoute[]> {
    throw this.notImplemented('listRoutes', { locale });
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
   * collapse into a `content` section holding their rendered HTML, so the page
   * still renders — degraded, not broken.
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

  private notImplemented(
    operation: string,
    context: Record<string, unknown>,
  ): ContentProviderError {
    return new ContentProviderError(
      this.name,
      operation,
      `not implemented yet (endpoint=${this.endpoint}, context=${JSON.stringify(context)})`,
    );
  }
}
