import { notFound, redirect } from 'next/navigation';
import { apiFetch, ApiRequestError, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { ContentEditor } from '@/components/content-editor';
import { RelativeTime } from '@/components/relative-time';
import type { ReferenceOptions } from '@/components/section-fields';

export const dynamic = 'force-dynamic';

interface ContentDetail {
  readonly id: string;
  readonly type: string;
  readonly slug: string;
  readonly path: string;
  readonly locale: string;
  readonly title: string;
  readonly excerpt: string | null;
  readonly status: string;
  readonly publishedAt: string | null;
  readonly updatedAt: string;
  readonly document: { sections: unknown[] };
  readonly seo: {
    readonly title: string | null;
    readonly description: string | null;
    readonly canonicalUrl: string | null;
    readonly noindex: boolean;
    readonly nofollow: boolean;
  } | null;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const entry = await apiFetch<ContentDetail>(`/v1/cms/content/${id}`);
    return { title: entry.title };
  } catch {
    return { title: 'Content' };
  }
}

/**
 * The reference pickers' choices, fetched here — on the server, with the
 * session — because the browser never talks to the API directly.
 */
async function loadReferenceOptions(): Promise<ReferenceOptions> {
  const [services, forms, locations, people, content, media] = await Promise.all([
    apiFetch<{ items: { id: string; name: string; slug: string }[] }>('/v1/cms/services').catch(
      () => ({ items: [] }),
    ),
    apiFetch<{ items: { id: string; name: string; slug: string }[] }>('/v1/cms/forms').catch(
      () => ({ items: [] }),
    ),
    apiFetch<{ items: { id: string; name: string; city: string }[] }>('/v1/cms/locations').catch(
      () => ({ items: [] }),
    ),
    apiFetch<{ items: { id: string; name: string; role: string | null }[] }>(
      '/v1/cms/people',
    ).catch(() => ({ items: [] })),
    apiFetch<{ items: { id: string; title: string; path: string }[] }>(
      '/v1/cms/content?limit=100',
    ).catch(() => ({ items: [] })),
    apiFetch<{ items: { id: string; originalFilename: string; alt: string | null }[] }>(
      '/v1/cms/media?limit=200',
    ).catch(() => ({ items: [] })),
  ]);

  return {
    services: services.items.map((item) => ({ id: item.id, label: item.name, detail: item.slug })),
    forms: forms.items.map((item) => ({ id: item.id, label: item.name, detail: item.slug })),
    locations: locations.items.map((item) => ({
      id: item.id,
      label: item.name,
      detail: item.city,
    })),
    people: people.items.map((item) => ({
      id: item.id,
      label: item.name,
      ...(item.role ? { detail: item.role } : {}),
    })),
    content: content.items.map((item) => ({ id: item.id, label: item.title, detail: item.path })),
    media: media.items.map((item) => ({
      id: item.id,
      label: item.alt || item.originalFilename,
    })),
  };
}

export default async function ContentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const { id } = await params;

  let entry: ContentDetail;
  try {
    entry = await apiFetch<ContentDetail>(`/v1/cms/content/${id}`);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) notFound();
    throw error;
  }

  const [revisions, referenceOptions] = await Promise.all([
    apiFetch<{
      items: { id: string; revision: number; title: string | null; createdAt: string }[];
    }>(`/v1/cms/content/${id}/revisions`).catch(() => ({ items: [] })),
    loadReferenceOptions(),
  ]);

  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/+$/, '');

  return (
    <DashboardShell session={session} businessType="education_service" current="/content">
      <div className="page-header">
        <div>
          <p className="breadcrumb">
            <a href="/content">Content</a>
          </p>
          <h1>{entry.title}</h1>
          <p className="muted">
            <span className={`badge badge--${entry.status}`}>{entry.status}</span>{' '}
            <code>{entry.path}</code> · updated <RelativeTime iso={entry.updatedAt} />
          </p>
        </div>

        {entry.status === 'published' && siteUrl ? (
          <div className="page-actions">
            <a className="button" href={`${siteUrl}${entry.path}`} rel="noopener noreferrer">
              View on the site
            </a>
          </div>
        ) : null}
      </div>

      <ContentEditor
        contentId={entry.id}
        title={entry.title}
        excerpt={entry.excerpt ?? ''}
        document={entry.document}
        status={entry.status}
        path={entry.path}
        siteUrl={siteUrl}
        seo={{
          title: entry.seo?.title ?? '',
          description: entry.seo?.description ?? '',
          canonicalUrl: entry.seo?.canonicalUrl ?? '',
          noindex: entry.seo?.noindex ?? false,
          nofollow: entry.seo?.nofollow ?? false,
        }}
        revisions={revisions.items.map((revision) => ({
          revision: revision.revision,
          title: revision.title,
          createdAt: revision.createdAt,
        }))}
        referenceOptions={referenceOptions}
        canWrite={can(session, 'content.write')}
        canPublish={can(session, 'content.publish')}
      />
    </DashboardShell>
  );
}
