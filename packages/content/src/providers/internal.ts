import {
  ContentProviderError,
  contentEntrySchema,
  type ContentEntry,
  type ContentPage,
  type ContentProvider,
  type ContentQuery,
  type ContentRoute,
} from '../types.ts';

export interface InternalProviderOptions {
  /** Base URL of the Business API, e.g. https://api.example.com. */
  readonly apiUrl: string;
  readonly workspaceSlug: string;
  /** Service token. Only ever read server-side. */
  readonly apiToken?: string;
  readonly fetchImpl?: typeof fetch;
  readonly requestTimeoutMs?: number;
}

interface ListResponse {
  readonly items: unknown[];
  readonly nextCursor?: string;
}

interface RoutesResponse {
  readonly routes: ContentRoute[];
}

/**
 * The internal CMS adapter: reads content from the Business API.
 *
 * This is the default provider and the one that eventually makes WordPress
 * unnecessary. Responses are validated against the content schema before they
 * reach a template — an API that starts returning a slightly different shape
 * should fail loudly here, not render a page with a missing heading.
 */
export class InternalContentProvider implements ContentProvider {
  readonly name = 'internal' as const;

  private readonly options: InternalProviderOptions;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: InternalProviderOptions) {
    this.options = options;
    this.baseUrl = options.apiUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.requestTimeoutMs ?? 8_000;
  }

  async getByPath(path: string, locale: string): Promise<ContentEntry | null> {
    const url = this.url('/v1/content/by-path', { path, locale });
    const body = await this.request<unknown>('getByPath', url, { allowNotFound: true });
    if (body === null) return null;
    return this.parseEntry('getByPath', body);
  }

  async getById(id: string): Promise<ContentEntry | null> {
    const url = this.url(`/v1/content/${encodeURIComponent(id)}`, {});
    const body = await this.request<unknown>('getById', url, { allowNotFound: true });
    if (body === null) return null;
    return this.parseEntry('getById', body);
  }

  async list(query: ContentQuery): Promise<ContentPage<ContentEntry>> {
    const params: Record<string, string> = {};
    if (query.type) params.type = query.type;
    if (query.locale) params.locale = query.locale;
    if (query.status) params.status = query.status;
    if (query.limit !== undefined) params.limit = String(query.limit);
    if (query.cursor) params.cursor = query.cursor;
    for (const [key, value] of Object.entries(query.where ?? {})) {
      params[`where[${key}]`] = String(value);
    }

    const body = await this.request<ListResponse>('list', this.url('/v1/content', params), {
      allowNotFound: false,
    });

    return {
      items: body.items.map((item) => this.parseEntry('list', item)),
      nextCursor: body.nextCursor,
    };
  }

  async listRoutes(locale?: string): Promise<readonly ContentRoute[]> {
    const params = locale ? { locale } : {};
    const body = await this.request<RoutesResponse>(
      'listRoutes',
      this.url('/v1/content/routes', params),
      {
        allowNotFound: false,
      },
    );
    return body.routes;
  }

  /**
   * Tags are hierarchical so a publish can purge one page, one content type, or
   * everything, without maintaining a separate invalidation map.
   */
  cacheTagsFor(path: string, locale: string): readonly string[] {
    return [
      'content',
      `content:ws:${this.options.workspaceSlug}`,
      `content:path:${locale}:${path}`,
    ];
  }

  private parseEntry(operation: string, body: unknown): ContentEntry {
    const result = contentEntrySchema.safeParse(body);
    if (!result.success) {
      throw new ContentProviderError(
        this.name,
        operation,
        `response did not match the content schema: ${result.error.issues
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
      );
    }
    return result.data;
  }

  private url(pathname: string, params: Record<string, string>): string {
    const url = new URL(this.baseUrl + pathname);
    url.searchParams.set('workspace', this.options.workspaceSlug);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  /**
   * Overloaded so `allowNotFound: false` callers are not forced to null-check a
   * value that can never be null — the alternative is a `!` at every call site,
   * which is exactly the assertion that later turns out to be wrong.
   */
  private async request<T>(
    operation: string,
    url: string,
    options: { allowNotFound: true },
  ): Promise<T | null>;
  private async request<T>(
    operation: string,
    url: string,
    options: { allowNotFound: false },
  ): Promise<T>;
  private async request<T>(
    operation: string,
    url: string,
    { allowNotFound }: { allowNotFound: boolean },
  ): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (this.options.apiToken) headers.authorization = `Bearer ${this.options.apiToken}`;

      const response = await this.fetchImpl(url, { headers, signal: controller.signal });

      if (response.status === 404 && allowNotFound) return null;

      if (!response.ok) {
        throw new ContentProviderError(
          this.name,
          operation,
          `API responded ${response.status} ${response.statusText}`,
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof ContentProviderError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new ContentProviderError(this.name, operation, reason, error);
    } finally {
      clearTimeout(timer);
    }
  }
}
