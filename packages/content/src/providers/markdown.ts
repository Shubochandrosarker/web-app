import {
  ContentProviderError,
  type ContentEntry,
  type ContentPage,
  type ContentProvider,
  type ContentQuery,
  type ContentRoute,
} from '../types.ts';

export interface MarkdownProviderOptions {
  /** Directory of `.md` files with front matter, relative to the app root. */
  readonly contentDir: string;
  readonly defaultLocale: string;
}

/**
 * Markdown adapter — for docs sites, and for the case where a client wants
 * their content in git rather than a database.
 *
 * Deliberately unimplemented until Phase 2. Its presence in Phase 1 is the
 * point: it forces the interface to stay narrow enough that a filesystem can
 * satisfy it, which is what stops database assumptions leaking into templates.
 */
export class MarkdownContentProvider implements ContentProvider {
  readonly name = 'markdown' as const;

  private readonly options: MarkdownProviderOptions;

  constructor(options: MarkdownProviderOptions) {
    this.options = options;
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
    return ['content', 'content:markdown', `content:path:${locale}:${path}`];
  }

  private notImplemented(
    operation: string,
    context: Record<string, unknown>,
  ): ContentProviderError {
    return new ContentProviderError(
      this.name,
      operation,
      `not implemented yet (contentDir=${this.options.contentDir}, context=${JSON.stringify(context)})`,
    );
  }
}
