import type { ContentEntry } from '@bos/content';
import type { ResolvedWorkspaceConfig } from '@bos/business-types';

/**
 * Page metadata, in a framework-neutral shape.
 *
 * `apps/site` converts this to a Next.js `Metadata` object. Keeping the
 * computation here means the same title and canonical rules apply to the
 * sitemap, the OG image generator and any future renderer.
 */
export interface PageMetadata {
  readonly title: string;
  readonly description: string | undefined;
  readonly canonical: string;
  readonly robots: { readonly index: boolean; readonly follow: boolean };
  readonly openGraph: {
    readonly title: string;
    readonly description: string | undefined;
    readonly url: string;
    readonly siteName: string;
    readonly type: 'website' | 'article';
    readonly locale: string;
    readonly image: string | undefined;
  };
  readonly twitter: {
    readonly card: 'summary_large_image' | 'summary';
    readonly title: string;
    readonly description: string | undefined;
    readonly image: string | undefined;
  };
  readonly alternates: readonly { readonly hrefLang: string; readonly href: string }[];
  readonly lastModified: string;
}

export interface BuildMetadataInput {
  readonly entry: ContentEntry;
  readonly workspace: ResolvedWorkspaceConfig;
  /** Absolute URLs for this entry's translations, keyed by locale. */
  readonly translationUrls?: Readonly<Record<string, string>>;
  readonly ogImageUrl?: string;
}

/** Titles are trimmed at a word boundary — a mid-word cut looks broken in a SERP. */
export function truncateAtWord(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const clipped = value.slice(0, maxLength);
  const lastSpace = clipped.lastIndexOf(' ');
  return (lastSpace > maxLength * 0.6 ? clipped.slice(0, lastSpace) : clipped).trimEnd();
}

export function absoluteUrl(siteUrl: string, path: string): string {
  return (
    new URL(path, siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`).toString().replace(/\/$/, '') ||
    siteUrl
  );
}

/**
 * Build the metadata for one content entry.
 *
 * Precedence is always explicit SEO field → derived from content → nothing.
 * There is no "smart" fallback that invents a description, because a
 * fabricated meta description is worse than none.
 */
export function buildPageMetadata({
  entry,
  workspace,
  translationUrls = {},
  ogImageUrl,
}: BuildMetadataInput): PageMetadata {
  const brandName = workspace.brand.name;
  const rawTitle = entry.seo.title ?? entry.title;
  const title = rawTitle.includes(brandName) ? rawTitle : `${rawTitle} | ${brandName}`;
  const description = entry.seo.description ?? entry.excerpt;

  const canonical = entry.seo.canonicalUrl ?? absoluteUrl(workspace.siteUrl, entry.path);
  const isArticle = entry.type === 'post' || entry.type === 'guide' || entry.type === 'case_study';

  const alternates = Object.entries(translationUrls).map(([hrefLang, href]) => ({
    hrefLang,
    href,
  }));
  if (alternates.length > 0) {
    alternates.push({
      hrefLang: 'x-default',
      href: translationUrls[workspace.locale.defaultLocale] ?? canonical,
    });
  }

  return {
    title: truncateAtWord(title, 70),
    description: description ? truncateAtWord(description, 165) : undefined,
    canonical,
    robots: {
      index: !entry.seo.noindex && entry.status === 'published',
      follow: !entry.seo.nofollow,
    },
    openGraph: {
      title: truncateAtWord(rawTitle, 70),
      description: description ? truncateAtWord(description, 165) : undefined,
      url: canonical,
      siteName: brandName,
      type: isArticle ? 'article' : 'website',
      locale: entry.locale,
      image: ogImageUrl,
    },
    twitter: {
      card: ogImageUrl ? 'summary_large_image' : 'summary',
      title: truncateAtWord(rawTitle, 70),
      description: description ? truncateAtWord(description, 165) : undefined,
      image: ogImageUrl,
    },
    alternates,
    lastModified: entry.updatedAt,
  };
}
