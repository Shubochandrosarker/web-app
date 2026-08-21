import { notFound, redirect } from 'next/navigation';
import { apiFetch, ApiRequestError, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { ContentEditor } from '@/components/content-editor';
import { RelativeTime } from '@/components/relative-time';

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
    readonly noindex: boolean;
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

  const revisions = await apiFetch<{
    items: { id: string; revision: number; title: string; createdAt: string }[];
  }>(`/v1/cms/content/${id}/revisions`).catch(() => ({ items: [] }));

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? '';

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

      <div className="detail-grid">
        <div className="detail-main">
          <ContentEditor
            contentId={entry.id}
            title={entry.title}
            excerpt={entry.excerpt ?? ''}
            document={entry.document}
            status={entry.status}
            canWrite={can(session, 'content.write')}
            canPublish={can(session, 'content.publish')}
          />
        </div>

        <aside className="detail-side">
          <section className="panel">
            <h2>Search appearance</h2>
            <dl className="detail-list">
              <div>
                <dt>Meta title</dt>
                <dd>{entry.seo?.title ?? entry.title}</dd>
              </div>
              <div>
                <dt>Meta description</dt>
                <dd>{entry.seo?.description ?? entry.excerpt ?? 'Not set'}</dd>
              </div>
              <div>
                <dt>Indexable</dt>
                <dd>{entry.seo?.noindex ? 'No — marked noindex' : 'Yes'}</dd>
              </div>
            </dl>
            {/*
              A reminder rather than a control. `BOS_ALLOW_INDEXING` is a
              deployment switch, and an editor toggling it from here would be a
              staging site indexed by accident.
            */}
            <p className="muted">
              A page is only indexable when the deployment also has indexing switched on.
            </p>
          </section>

          <section className="panel">
            <h2>History</h2>
            {revisions.items.length === 0 ? (
              <p className="muted">No revisions yet. One is taken on every save.</p>
            ) : (
              <ol className="timeline">
                {revisions.items.slice(0, 10).map((revision) => (
                  <li key={revision.id}>
                    <p>
                      Revision {revision.revision} — {revision.title}
                    </p>
                    <p className="muted">
                      <RelativeTime iso={revision.createdAt} />
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </aside>
      </div>
    </DashboardShell>
  );
}
