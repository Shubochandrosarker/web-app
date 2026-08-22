import { redirect } from 'next/navigation';
import { apiFetch, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { RelativeTime } from '@/components/relative-time';

export const metadata = { title: 'Audit log' };
export const dynamic = 'force-dynamic';

interface AuditRow {
  readonly id: string;
  readonly action: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly ipAddress: string | null;
  readonly detail: Record<string, unknown>;
  readonly createdAt: string;
  readonly actorEmail: string | null;
  readonly actorName: string | null;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; from?: string; to?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const params = await searchParams;

  const query = new URLSearchParams({ limit: '100' });
  if (params.action) query.set('action', params.action);
  if (params.from) query.set('from', new Date(params.from).toISOString());
  if (params.to) query.set('to', new Date(params.to).toISOString());

  const { items } = await apiFetch<{ items: AuditRow[] }>(
    `/v1/settings/audit?${query.toString()}`,
  ).catch(() => ({ items: [] as AuditRow[] }));

  return (
    <DashboardShell session={session} current="/settings/audit">
      <div className="page-header">
        <div>
          <h1>Audit log</h1>
          <p className="muted">
            Who did what, when, from where. Sign-ins, permission changes, downloads, publishes.
          </p>
        </div>
        <form className="toolbar" method="get">
          <label className="visually-hidden" htmlFor="audit-action">
            Filter by action
          </label>
          <input
            id="audit-action"
            name="action"
            type="search"
            placeholder="Action, e.g. member."
            defaultValue={params.action ?? ''}
          />
          <label className="visually-hidden" htmlFor="audit-from">
            From date
          </label>
          <input id="audit-from" name="from" type="date" defaultValue={params.from ?? ''} />
          <label className="visually-hidden" htmlFor="audit-to">
            To date
          </label>
          <input id="audit-to" name="to" type="date" defaultValue={params.to ?? ''} />
          <button type="submit" className="button">
            Filter
          </button>
        </form>
      </div>

      {items.length === 0 ? (
        <div className="panel">
          <h2>No entries match</h2>
          <p className="muted">Try a wider window or a shorter action prefix.</p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">Audit entries</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">Action</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id}>
                  <td>
                    <RelativeTime iso={row.createdAt} />
                  </td>
                  <td>
                    {row.actorName ?? row.actorEmail ?? 'System'}
                    {row.ipAddress ? (
                      <>
                        <br />
                        <span className="muted">{row.ipAddress}</span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    <code>{row.action}</code>
                    {row.entityType ? (
                      <>
                        <br />
                        <span className="muted">{row.entityType}</span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    {Object.keys(row.detail).length > 0 ? (
                      <details>
                        <summary>View</summary>
                        <pre className="audit-detail">{JSON.stringify(row.detail, null, 2)}</pre>
                      </details>
                    ) : (
                      '—'
                    )}
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
