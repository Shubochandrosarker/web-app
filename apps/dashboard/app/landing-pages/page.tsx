import { redirect } from 'next/navigation';
import { apiFetch, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { NewContentButton, ContentRowActions } from '@/components/content-create';
import { RelativeTime } from '@/components/relative-time';

export const metadata = { title: 'Landing pages' };
export const dynamic = 'force-dynamic';

interface LandingPageSummary {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly status: string;
  readonly updatedAt: string;
}

export default async function LandingPagesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; search?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const params = await searchParams;
  const query = new URLSearchParams({ type: 'landing_page', limit: '100' });
  if (params.status) query.set('status', params.status);
  if (params.search) query.set('search', params.search);
  const { items } = await apiFetch<{ items: LandingPageSummary[] }>(
    `/v1/cms/content?${query.toString()}`,
  );
  return (
    <DashboardShell session={session} current="/landing-pages">
      <div className="page-header">
        <div>
          <h1>Landing pages</h1>
          <p className="muted">
            Campaign pages with their own path, content and conversion intent.
          </p>
        </div>
        {can(session, 'content.write') ? (
          <NewContentButton locale="en" initialType="landing_page" />
        ) : null}
        <form className="toolbar" method="get">
          <label className="visually-hidden" htmlFor="landing-search">
            Search landing pages
          </label>
          <input
            id="landing-search"
            name="search"
            type="search"
            placeholder="Search titles"
            defaultValue={params.search ?? ''}
          />
          <select name="status" defaultValue={params.status ?? ''}>
            <option value="">Any status</option>
            <option value="draft">Draft</option>
            <option value="scheduled">Scheduled</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>
          <button type="submit" className="button">
            Filter
          </button>
        </form>
      </div>
      {items.length === 0 ? (
        <div className="panel">
          <h2>No landing pages</h2>
          <p className="muted">Create a draft campaign page before sending traffic to it.</p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">Landing pages</caption>
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Path</th>
                <th scope="col">Status</th>
                <th scope="col">Updated</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((entry) => (
                <tr key={entry.id}>
                  <th scope="row">
                    <a href={`/content/${entry.id}`}>{entry.title}</a>
                  </th>
                  <td>
                    <code>{entry.path}</code>
                  </td>
                  <td>
                    <span className={`badge badge--${entry.status}`}>{entry.status}</span>
                  </td>
                  <td>
                    <RelativeTime iso={entry.updatedAt} />
                  </td>
                  <td>
                    <ContentRowActions
                      contentId={entry.id}
                      status={entry.status}
                      canDelete={can(session, 'content.publish')}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DashboardShell>
  );
}
