import type { ContentEntry } from '@bos/content';
import type { Nap, ResolvedWorkspaceConfig } from '@bos/business-types';
import { absoluteUrl } from './metadata.ts';

/**
 * JSON-LD generation.
 *
 * Two rules govern everything here, and both come from Google's structured
 * data policies rather than from convenience:
 *
 *  1. Never emit a node describing content that is not visible on the page.
 *     Every generator below takes its values from rendered sections.
 *  2. Emit one connected `@graph` per page, with stable `@id` values, so the
 *     Organization on the contact page and the one on a service page are
 *     recognisably the same entity rather than two unrelated blobs.
 *
 * The `@id` scheme is `<siteUrl>/#<entity>` for site-wide entities and
 * `<pageUrl>#<entity>` for page-scoped ones.
 */

export type JsonLdNode = Record<string, unknown>;

export interface JsonLdGraph {
  readonly '@context': 'https://schema.org';
  readonly '@graph': readonly JsonLdNode[];
}

export const entityIds = {
  organization: (siteUrl: string) => `${siteUrl}/#organization`,
  website: (siteUrl: string) => `${siteUrl}/#website`,
  localBusiness: (siteUrl: string, locationSlug: string) => `${siteUrl}/#location-${locationSlug}`,
  webPage: (pageUrl: string) => `${pageUrl}#webpage`,
  breadcrumb: (pageUrl: string) => `${pageUrl}#breadcrumb`,
  service: (pageUrl: string) => `${pageUrl}#service`,
  article: (pageUrl: string) => `${pageUrl}#article`,
  faq: (pageUrl: string) => `${pageUrl}#faq`,
  person: (siteUrl: string, personSlug: string) => `${siteUrl}/#person-${personSlug}`,
} as const;

function postalAddress(nap: Nap): JsonLdNode {
  const address: JsonLdNode = {
    '@type': 'PostalAddress',
    streetAddress: nap.streetAddress,
    addressLocality: nap.addressLocality,
    addressCountry: nap.addressCountry,
  };
  if (nap.addressRegion) address.addressRegion = nap.addressRegion;
  if (nap.postalCode) address.postalCode = nap.postalCode;
  return address;
}

export function organizationNode(workspace: ResolvedWorkspaceConfig): JsonLdNode {
  const { nap, brand, siteUrl } = workspace;
  const node: JsonLdNode = {
    '@type': 'Organization',
    '@id': entityIds.organization(siteUrl),
    name: nap.legalName,
    alternateName: brand.name === nap.legalName ? undefined : brand.name,
    url: siteUrl,
    email: nap.email,
    telephone: nap.telephone,
    address: postalAddress(nap),
  };
  if (brand.logoUrl) node.logo = { '@type': 'ImageObject', url: brand.logoUrl };
  if (nap.sameAs.length > 0) node.sameAs = nap.sameAs;
  return stripUndefined(node);
}

/**
 * LocalBusiness for a physical location. Emitted only on pages that actually
 * show the address — a LocalBusiness node on a blog post is exactly the kind
 * of mismatch that gets structured data ignored.
 */
export function localBusinessNode(
  workspace: ResolvedWorkspaceConfig,
  locationSlug: string,
  overrides: Partial<Nap> = {},
): JsonLdNode {
  const nap = { ...workspace.nap, ...overrides };
  const node: JsonLdNode = {
    '@type': 'LocalBusiness',
    '@id': entityIds.localBusiness(workspace.siteUrl, locationSlug),
    name: nap.displayName,
    parentOrganization: { '@id': entityIds.organization(workspace.siteUrl) },
    url: workspace.siteUrl,
    telephone: nap.telephone,
    email: nap.email,
    address: postalAddress(nap),
    currenciesAccepted: workspace.locale.currency,
  };
  if (nap.latitude !== undefined && nap.longitude !== undefined) {
    node.geo = { '@type': 'GeoCoordinates', latitude: nap.latitude, longitude: nap.longitude };
  }
  if (nap.openingHours.length > 0) node.openingHours = nap.openingHours;
  if (nap.areaServed.length > 0) node.areaServed = nap.areaServed;
  if (nap.sameAs.length > 0) node.sameAs = nap.sameAs;
  return stripUndefined(node);
}

export function webSiteNode(workspace: ResolvedWorkspaceConfig): JsonLdNode {
  return {
    '@type': 'WebSite',
    '@id': entityIds.website(workspace.siteUrl),
    url: workspace.siteUrl,
    name: workspace.brand.name,
    publisher: { '@id': entityIds.organization(workspace.siteUrl) },
    inLanguage: workspace.locale.defaultLocale,
  };
}

export function webPageNode(entry: ContentEntry, workspace: ResolvedWorkspaceConfig): JsonLdNode {
  const pageUrl = absoluteUrl(workspace.siteUrl, entry.path);
  return stripUndefined({
    '@type': 'WebPage',
    '@id': entityIds.webPage(pageUrl),
    url: pageUrl,
    name: entry.seo.title ?? entry.title,
    description: entry.seo.description ?? entry.excerpt,
    isPartOf: { '@id': entityIds.website(workspace.siteUrl) },
    inLanguage: entry.locale,
    datePublished: entry.publishedAt,
    dateModified: entry.updatedAt,
  });
}

export interface BreadcrumbItem {
  readonly name: string;
  readonly path: string;
}

export function breadcrumbNode(
  items: readonly BreadcrumbItem[],
  entry: ContentEntry,
  workspace: ResolvedWorkspaceConfig,
): JsonLdNode {
  const pageUrl = absoluteUrl(workspace.siteUrl, entry.path);
  return {
    '@type': 'BreadcrumbList',
    '@id': entityIds.breadcrumb(pageUrl),
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: absoluteUrl(workspace.siteUrl, item.path),
    })),
  };
}

export interface ServiceNodeInput {
  readonly name: string;
  readonly description?: string;
  readonly areaServed?: readonly string[];
  readonly serviceType?: string;
}

export function serviceNode(
  input: ServiceNodeInput,
  entry: ContentEntry,
  workspace: ResolvedWorkspaceConfig,
): JsonLdNode {
  const pageUrl = absoluteUrl(workspace.siteUrl, entry.path);
  return stripUndefined({
    '@type': 'Service',
    '@id': entityIds.service(pageUrl),
    name: input.name,
    description: input.description,
    serviceType: input.serviceType,
    provider: { '@id': entityIds.organization(workspace.siteUrl) },
    areaServed:
      input.areaServed ??
      (workspace.nap.areaServed.length > 0 ? workspace.nap.areaServed : undefined),
    url: pageUrl,
  });
}

export interface FaqItem {
  readonly question: string;
  readonly answer: string;
}

/**
 * FAQPage. Callers pass only the questions rendered by a visible `faq` section
 * with `emitSchema` on — see packages/sections.
 */
export function faqNode(
  items: readonly FaqItem[],
  entry: ContentEntry,
  workspace: ResolvedWorkspaceConfig,
): JsonLdNode | null {
  if (items.length === 0) return null;
  const pageUrl = absoluteUrl(workspace.siteUrl, entry.path);
  return {
    '@type': 'FAQPage',
    '@id': entityIds.faq(pageUrl),
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}

export function articleNode(
  entry: ContentEntry,
  workspace: ResolvedWorkspaceConfig,
  authorName?: string,
): JsonLdNode {
  const pageUrl = absoluteUrl(workspace.siteUrl, entry.path);
  return stripUndefined({
    '@type': entry.type === 'post' ? 'BlogPosting' : 'Article',
    '@id': entityIds.article(pageUrl),
    headline: entry.title,
    description: entry.seo.description ?? entry.excerpt,
    datePublished: entry.publishedAt,
    dateModified: entry.updatedAt,
    inLanguage: entry.locale,
    mainEntityOfPage: { '@id': entityIds.webPage(pageUrl) },
    publisher: { '@id': entityIds.organization(workspace.siteUrl) },
    author: authorName
      ? { '@type': 'Person', name: authorName }
      : { '@id': entityIds.organization(workspace.siteUrl) },
  });
}

/**
 * Assemble the page graph. Null nodes are dropped, so a generator that had
 * nothing visible to describe simply contributes nothing.
 */
export function buildJsonLdGraph(nodes: readonly (JsonLdNode | null | undefined)[]): JsonLdGraph {
  return {
    '@context': 'https://schema.org',
    '@graph': nodes.filter((node): node is JsonLdNode => Boolean(node)),
  };
}

/**
 * Serialise for a `<script type="application/ld+json">` tag.
 *
 * `<` is escaped so a stray `</script>` inside a content-derived string cannot
 * close the tag early and turn page copy into markup.
 */
export function serialiseJsonLd(graph: JsonLdGraph): string {
  return JSON.stringify(graph).replace(/</g, '\\u003c');
}

function stripUndefined(node: JsonLdNode): JsonLdNode {
  return Object.fromEntries(Object.entries(node).filter(([, value]) => value !== undefined));
}
