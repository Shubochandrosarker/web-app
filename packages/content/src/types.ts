import { z } from 'zod';
import { pageDocumentSchema } from '@bos/sections';
import { localeCode, routePath, slug, url } from '@bos/validation';
import { EMPTY_REFERENCES, sectionReferencesSchema } from './references.ts';

/**
 * The content model the renderer sees.
 *
 * This shape is deliberately provider-agnostic. WordPress, the internal CMS
 * and a folder of Markdown all normalise *into* this, which is what makes
 * WordPress removable later without touching a single template.
 */

export const CONTENT_TYPES = [
  'page',
  'post',
  'service',
  'location',
  'faq',
  'guide',
  'person',
  'testimonial',
  'case_study',
  'offer',
  'landing_page',
] as const;

export type ContentType = (typeof CONTENT_TYPES)[number];

export const seoFieldsSchema = z.object({
  title: z.string().max(70).optional(),
  description: z.string().max(180).optional(),
  canonicalUrl: url.optional(),
  noindex: z.boolean().default(false),
  nofollow: z.boolean().default(false),
  ogImageMediaId: z.uuid().optional(),
  /** Extra JSON-LD nodes merged into the page graph by @bos/seo. */
  schemaOverrides: z.array(z.record(z.string(), z.unknown())).default([]),
});

export const contentEntrySchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  type: z.enum(CONTENT_TYPES),
  slug,
  /** Full site path including any parent segments, e.g. /services/attestation. */
  path: routePath,
  locale: localeCode,
  title: z.string().min(1).max(300),
  excerpt: z.string().max(600).optional(),
  status: z.enum(['draft', 'scheduled', 'published', 'archived']),
  publishedAt: z.iso.datetime({ offset: true }).optional(),
  updatedAt: z.iso.datetime({ offset: true }),
  document: pageDocumentSchema,
  seo: seoFieldsSchema,
  /** Type-specific structured fields — a service's price, a person's role. */
  fields: z.record(z.string(), z.unknown()).default({}),
  /** Translations of this entry, keyed by locale. */
  translations: z.record(z.string(), z.uuid()).default({}),
  /**
   * Everything the page's sections refer to by id, resolved server-side.
   *
   * Optional because the Markdown provider has no service catalogue to resolve
   * against; renderers treat an absent bag as an empty one rather than
   * branching on the provider.
   */
  references: sectionReferencesSchema.default(EMPTY_REFERENCES),
});

export type ContentEntry = z.infer<typeof contentEntrySchema>;
export type SeoFields = z.infer<typeof seoFieldsSchema>;

/** Fields a public caller may sort by. Anything else is a 400. */
export const CONTENT_SORT_FIELDS = ['publishedAt', 'updatedAt', 'title'] as const;
export type ContentSortField = (typeof CONTENT_SORT_FIELDS)[number];

export interface ContentQuery {
  readonly type?: ContentType;
  readonly locale?: string;
  readonly status?: ContentEntry['status'];
  readonly limit?: number;
  readonly cursor?: string;
  readonly sort?: ContentSortField;
  readonly direction?: 'asc' | 'desc';
  /** Filter on type-specific fields, e.g. `{ locationId: '…' }`. */
  readonly where?: Readonly<Record<string, string | number | boolean>>;
}

export interface ContentPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | undefined;
}

/** A route the site should render, used to build sitemaps and static params. */
export interface ContentRoute {
  readonly path: string;
  readonly locale: string;
  readonly type: ContentType;
  readonly updatedAt: string;
  readonly noindex: boolean;
}

/**
 * The provider contract.
 *
 * `apps/site` depends on this interface and nothing else. Swapping
 * `CONTENT_PROVIDER` swaps the implementation; no template, no metadata
 * builder and no sitemap route has to change.
 */
export interface ContentProvider {
  readonly name: 'internal' | 'wordpress' | 'markdown';

  /** Resolve one entry by its full site path. Returns null for a 404. */
  getByPath(path: string, locale: string): Promise<ContentEntry | null>;

  getById(id: string): Promise<ContentEntry | null>;

  list(query: ContentQuery): Promise<ContentPage<ContentEntry>>;

  /**
   * Every renderable route. Drives sitemap generation and, for providers that
   * can enumerate cheaply, static params at build time.
   */
  listRoutes(locale?: string): Promise<readonly ContentRoute[]>;

  /**
   * Cache tags for a path, so a publish can purge exactly the affected pages
   * instead of the whole zone.
   */
  cacheTagsFor(path: string, locale: string): readonly string[];
}

export class ContentProviderError extends Error {
  readonly provider: string;
  readonly operation: string;

  constructor(provider: string, operation: string, message: string, cause?: unknown) {
    super(`[content:${provider}] ${operation} failed: ${message}`, { cause });
    this.name = 'ContentProviderError';
    this.provider = provider;
    this.operation = operation;
  }
}
