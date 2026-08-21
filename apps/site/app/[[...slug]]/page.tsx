import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { parsePageDocument, pageDocumentSchema } from '@bos/sections';
import {
  articleNode,
  breadcrumbNode,
  buildJsonLdGraph,
  buildPageMetadata,
  faqNode,
  localBusinessNode,
  organizationNode,
  serialiseJsonLd,
  serviceNode,
  webPageNode,
  webSiteNode,
} from '@bos/seo';
import { SectionList, type RenderContext } from '@/components/sections';
import { getPageByPath } from '@/lib/content';
import { getWorkspace } from '@/lib/workspace';

/**
 * The single content route.
 *
 * Every public page — home, service, post, location, landing page — is this
 * component. Templates do not fork per content type; the section document
 * decides what renders, and the entry's type decides which JSON-LD nodes the
 * graph gets. Adding a content type therefore costs a schema entry, not a new
 * route.
 *
 * The page renders per request and reads cached data — see `lib/content.ts`
 * for why that is the right trade against the nonce-based CSP, and ADR-0014
 * for the decision record.
 */

interface RouteParams {
  params: Promise<{ slug?: string[] }>;
}

function pathFrom(slug: string[] | undefined): string {
  return slug && slug.length > 0 ? `/${slug.join('/')}` : '/';
}

/** Breadcrumbs from the path itself — one per ancestor segment, plus home. */
function breadcrumbsFor(path: string, title: string) {
  if (path === '/') return [];

  const segments = path.split('/').filter(Boolean);
  const crumbs = [{ name: 'Home', path: '/' }];

  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1;
    crumbs.push({
      name: isLast ? title : segment.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      path: `/${segments.slice(0, index + 1).join('/')}`,
    });
  });

  return crumbs;
}

export async function generateMetadata({ params }: RouteParams): Promise<Metadata> {
  const workspace = await getWorkspace();
  const { slug } = await params;
  const entry = await getPageByPath(pathFrom(slug), workspace.locale.defaultLocale);

  if (!entry) return { title: 'Not found', robots: { index: false, follow: false } };

  const meta = buildPageMetadata({ entry, workspace });

  /*
   * A staging deployment must never be indexable, and `robots.txt` alone is
   * not enough: a URL that is already known can be indexed without the crawler
   * re-reading robots. The per-page directive is the one that actually holds.
   */
  const indexable = process.env.BOS_ALLOW_INDEXING === 'true';

  return {
    title: meta.title,
    ...(meta.description ? { description: meta.description } : {}),
    alternates: {
      canonical: meta.canonical,
      ...(meta.alternates.length > 0
        ? { languages: Object.fromEntries(meta.alternates.map((a) => [a.hrefLang, a.href])) }
        : {}),
    },
    robots: indexable
      ? { index: meta.robots.index, follow: meta.robots.follow }
      : { index: false, follow: false },
    openGraph: {
      title: meta.openGraph.title,
      ...(meta.openGraph.description ? { description: meta.openGraph.description } : {}),
      url: meta.openGraph.url,
      siteName: meta.openGraph.siteName,
      type: meta.openGraph.type,
      locale: meta.openGraph.locale,
      ...(meta.openGraph.image ? { images: [meta.openGraph.image] } : {}),
    },
    twitter: {
      card: meta.twitter.card,
      title: meta.twitter.title,
      ...(meta.twitter.description ? { description: meta.twitter.description } : {}),
    },
  };
}

export default async function ContentPage({ params }: RouteParams) {
  const workspace = await getWorkspace();
  const { slug } = await params;
  const path = pathFrom(slug);

  const entry = await getPageByPath(path, workspace.locale.defaultLocale);

  /*
   * The provider already filters to published content — the public API has no
   * way to express a request for anything else. This check is the second lock:
   * a future provider (a Markdown folder, a WordPress instance) has no such
   * guarantee, and a draft rendering because somebody swapped the provider
   * would be a silent failure.
   */
  if (!entry || entry.status !== 'published') notFound();

  // A malformed section costs that section, not the page. The parse result
  // carries the failures so they can be surfaced in the dashboard rather than
  // discovered by a visitor.
  const { sections, errors } = parsePageDocument(pageDocumentSchema.parse(entry.document));
  if (errors.length > 0 && process.env.NODE_ENV !== 'production') {
    console.warn(`[content] ${errors.length} section(s) on ${path} failed validation:`, errors);
  }

  /*
   * JSON-LD is assembled from what this page actually renders. The FAQ node is
   * built from the visible faq sections, not from a separate field somebody
   * could forget to keep in sync — schema that does not match the page is a
   * structured-data violation, not a shortcut.
   */
  const visibleFaqItems = sections
    .filter(
      (section): section is Extract<typeof section, { type: 'faq' }> => section.type === 'faq',
    )
    .filter((section) => section.props.emitSchema)
    .flatMap((section) => section.props.items);

  const isArticle = entry.type === 'post' || entry.type === 'guide' || entry.type === 'case_study';

  // LocalBusiness is emitted only where an address is actually on the page.
  // Claiming a physical presence on a page that shows none is the mismatch
  // that gets a whole site's structured data discounted.
  const showsAddress =
    sections.some((section) => section.type === 'locations') || entry.type === 'location';

  const graph = buildJsonLdGraph([
    organizationNode(workspace),
    webSiteNode(workspace),
    webPageNode(entry, workspace),
    showsAddress ? localBusinessNode(workspace, entry.slug) : null,
    path === '/' ? null : breadcrumbNode(breadcrumbsFor(path, entry.title), entry, workspace),
    entry.type === 'service'
      ? serviceNode({ name: entry.title, description: entry.excerpt ?? '' }, entry, workspace)
      : null,
    isArticle ? articleNode(entry, workspace) : null,
    faqNode(visibleFaqItems, entry, workspace),
  ]);

  const renderContext: RenderContext = {
    references: entry.references,
    workspaceSlug: workspace.slug,
    locale: workspace.locale.defaultLocale,
    currency: workspace.locale.currency,
  };

  return (
    <>
      {/*
        eslint-disable no-restricted-syntax -- `serialiseJsonLd` escapes `<`,
        so a `</script>` inside any string value cannot close this block. See
        packages/seo/src/structured-data.ts.
      */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serialiseJsonLd(graph) }}
      />
      {/* eslint-enable no-restricted-syntax */}
      <SectionList sections={sections} context={renderContext} />
    </>
  );
}
