import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { parsePageDocument, pageDocumentSchema } from '@bos/sections';
import type { ContentEntry } from '@bos/content';
import { SectionList, type RenderContext } from '@/components/sections';
import { getWorkspace } from '@/lib/workspace';

/**
 * Draft preview.
 *
 * Renders one entry — draft, scheduled, whatever its status — for the holder
 * of a short-lived preview token an editor minted in the dashboard. The
 * public content API remains structurally incapable of serving a draft; this
 * route talks to a separate endpoint whose only key is the token, and the
 * token dies on its own in minutes.
 *
 * Never indexable, never cached: a preview URL that leaked into a crawler's
 * queue must return noindex and then expire, not become a shadow copy of an
 * unpublished page.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Preview',
  robots: { index: false, follow: false },
};

async function getPreviewEntry(token: string): Promise<ContentEntry | null> {
  const apiUrl = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/+$/, '');
  if (!apiUrl) return null;

  const response = await fetch(`${apiUrl}/v1/content/preview?token=${encodeURIComponent(token)}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);

  if (!response?.ok) return null;
  return (await response.json()) as ContentEntry;
}

export default async function PreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  if (!token) notFound();

  const workspace = await getWorkspace();
  const entry = await getPreviewEntry(token);
  if (!entry) notFound();

  const { sections } = parsePageDocument(pageDocumentSchema.parse(entry.document));

  const renderContext: RenderContext = {
    references: entry.references,
    workspaceSlug: workspace.slug,
    locale: workspace.locale.defaultLocale,
    currency: workspace.locale.currency,
  };

  return (
    <>
      <div className="preview-banner" role="status">
        Preview of <strong>{entry.title}</strong> ({entry.status}). This link expires in a few
        minutes and the page is not public.
      </div>
      <SectionList sections={sections} context={renderContext} />
    </>
  );
}
