import { redirect } from 'next/navigation';
import { apiFetch, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { RelativeTime } from '@/components/relative-time';
import { ContentRowActions, NewContentButton } from '@/components/content-create';

export const metadata = { title: 'Content' };
export const dynamic = 'force-dynamic';

interface ContentSummary {
  readonly id: string;
  readonly type: string;
  readonly slug: string;
  readonly path: string;
  readonly locale: string;
  readonly title: string;
  readonly status: string;
  readonly publishedAt: string | null;
  readonly updatedAt: string;
}

const TYPES = [
  { value: '', label: 'Everything' },
  { value: 'page', label: 'Pages' },
  { value: 'service', label: 'Services' },
  { value: 'guide', label: 'Guides' },
  { value: 'post', label: 'Posts' },
  { value: 'location', label: 'Locations' },
  { value: 'landing_page', label: 'Landing pages' },
];

export default async function ContentPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; status?: string; search?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const params = await searchParams;
  const query = new URLSearchParams({ limit: '100' });
  if (params.type) query.set('type', params.type);
  if (params.status) query.set('status', params.status);
  if (params.search) query.set('search', params.search);

  const { items } = await apiFetch<{ items: ContentSummary[] }>(
    `/v1/cms/content?${query.toString()}`,
  );

  return (
    <DashboardShell session={session} businessType="education_service" current="/content">
      <div className="page-header">
        <div>
          <h1>Content</h1>
          <p className="muted">
            {items.length} {items.length === 1 ? 'entry' : 'entries'}
          </p>
        </div>

        {can(session, 'content.write') ? (
          <div className="page-actions">
            {/* Single-locale for now; the locale picker arrives with bn-BD. */}
            <NewContentButton locale="en" />
          </div>
        ) : null}

        <form className="toolbar" method="get">
          <label className="visually-hidden" htmlFor="type">
            Type
          </label>
          <select id="type" name="type" defaultValue={params.type ?? ''}>
            {TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <label className="visually-hidden" htmlFor="status">
            Status
          </label>
          <select id="status" name="status" defaultValue={params.status ?? ''}>
            <option value="">Any status</option>
            <option value="draft">Draft</option>
            <option value="scheduled">Scheduled</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>

          <label className="visually-hidden" htmlFor="search">
            Search titles
          </label>
          <input
            id="search"
            name="search"
            type="search"
            placeholder="Search titles"
            defaultValue={params.search ?? ''}
          />

          <button type="submit" className="button">
            Filter
          </button>
        </form>
      </div>

      {items.length === 0 ? (
        <div className="panel">
          <h2>Nothing here yet</h2>
          <p className="muted">
            {params.type || params.status || params.search
              ? 'No entries match those filters.'
              : 'Content created through the API or an import will appear here.'}
          </p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">Content entries</caption>
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Type</th>
                <th scope="col">Path</th>
                <th scope="col">Status</th>
                <th scope="col">Updated</th>
                {can(session, 'content.write') ? <th scope="col">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {items.map((entry) => (
                <tr key={entry.id}>
                  <th scope="row">
                    {can(session, 'content.write') ? (
                      <a href={`/content/${entry.id}`}>{entry.title}</a>
                    ) : (
                      entry.title
                    )}
                  </th>
                  <td>{entry.type.replace(/_/g, ' ')}</td>
                  <td>
                    <code>{entry.path}</code>
                  </td>
                  <td>
                    <span className={`badge badge--${entry.status}`}>{entry.status}</span>
                  </td>
                  <td>
                    <RelativeTime iso={entry.updatedAt} />
                  </td>
                  {can(session, 'content.write') ? (
                    <td>
                      <ContentRowActions
                        contentId={entry.id}
                        status={entry.status}
                        canDelete={can(session, 'content.publish')}
                      />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DashboardShell>
  );
}
