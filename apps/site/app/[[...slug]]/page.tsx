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
import { SectionList } from '@/components/sections';
import { getContentProvider } from '@/lib/content';
import { getWorkspace } from '@/lib/workspace';

/**
 * The single content route.
 *
 * Every public page — home, service, post, location, landing page — is this
 * component. Templates do not fork per content type; the section document
 * decides what renders, and the entry's type decides which JSON-LD nodes the
 * graph gets. Adding a content type therefore costs a schema entry, not a
 * new route.
 *
 * `force-dynamic` is a Phase 1 placeholder. TASK-204 switches this to ISR with
 * tag-based revalidation, so a publish purges exactly the affected pages
 * rather than the whole zone.
 */
export const dynamic = 'force-dynamic';

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
  const entry = await getContentProvider().getByPath(
    pathFrom(slug),
    workspace.locale.defaultLocale,
  );

  if (!entry) return { title: 'Not found', robots: { index: false, follow: false } };

  const meta = buildPageMetadata({ entry, workspace });

  return {
    title: meta.title,
    ...(meta.description ? { description: meta.description } : {}),
    alternates: {
      canonical: meta.canonical,
      ...(meta.alternates.length > 0
        ? { languages: Object.fromEntries(meta.alternates.map((a) => [a.hrefLang, a.href])) }
        : {}),
    },
    robots: { index: meta.robots.index, follow: meta.robots.follow },
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

  const entry = await getContentProvider().getByPath(path, workspace.locale.defaultLocale);
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

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serialiseJsonLd(graph) }}
      />
      <SectionList sections={sections} />
    </>
  );
}
