import { redirect } from 'next/navigation';
import { apiFetch, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { pickDays, StatCard, WindowSwitch } from '@/components/analytics-bits';

export const dynamic = 'force-dynamic';

/**
 * Conversions: enquiries in, outcomes out, and which pages, sources and
 * services produced them. The question this screen answers is "where does
 * business actually come from" — which is different from where traffic comes
 * from.
 */

interface Conversions {
  readonly funnel: readonly { status: string; count: number; value: number }[];
  readonly bySource: readonly { source: string; leads: number; won: number }[];
  readonly byService: readonly { service: string; leads: number; won: number }[];
  readonly byLandingPath: readonly { path: string; conversions: number }[];
}

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  won: 'Won',
  lost: 'Lost',
  archived: 'Archived',
};

export default async function ConversionAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const params = await searchParams;
  const days = pickDays(params.days);

  const data = await apiFetch<Conversions>(`/v1/analytics/conversions?days=${days}`).catch(
    () => null,
  );

  const total = data?.funnel.reduce((sum, row) => sum + row.count, 0) ?? 0;
  const won = data?.funnel.find((row) => row.status === 'won');

  return (
    <DashboardShell session={session} current="/analytics/conversion">
      <div className="page-header">
        <div>
          <h1>Conversions</h1>
          <p className="muted">Enquiries created in this window, and what became of them.</p>
        </div>
        <WindowSwitch base="/analytics/conversion" days={days} />
      </div>

      {!data || total === 0 ? (
        <div className="panel">
          <h2>No enquiries in this window</h2>
          <p className="muted">
            Once forms start producing enquiries, this screen shows their outcomes by source,
            service and landing page.
          </p>
        </div>
      ) : (
        <>
          <div className="stat-grid">
            <StatCard label="Enquiries" value={total} />
            <StatCard label="Won" value={won?.count ?? 0} />
            <StatCard
              label="Win rate"
              value={total > 0 ? Math.round(((won?.count ?? 0) / total) * 100) : 0}
            />
            {data.funnel.some((row) => row.value > 0) ? (
              <StatCard
                label="Won value (minor units)"
                value={data.funnel
                  .filter((row) => row.status === 'won')
                  .reduce((sum, row) => sum + row.value, 0)}
              />
            ) : null}
          </div>

          <section className="panel">
            <h2>Outcomes</h2>
            <div className="table-scroll">
              <table className="data-table">
                <caption className="visually-hidden">Enquiry outcomes</caption>
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col">Enquiries</th>
                  </tr>
                </thead>
                <tbody>
                  {data.funnel.map((row) => (
                    <tr key={row.status}>
                      <td>{STATUS_LABELS[row.status] ?? row.status}</td>
                      <td>{row.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <h2>By source</h2>
            <div className="table-scroll">
              <table className="data-table">
                <caption className="visually-hidden">Enquiries by source</caption>
                <thead>
                  <tr>
                    <th scope="col">Source</th>
                    <th scope="col">Enquiries</th>
                    <th scope="col">Won</th>
                  </tr>
                </thead>
                <tbody>
                  {data.bySource.map((row) => (
                    <tr key={row.source}>
                      <td>{row.source}</td>
                      <td>{row.leads}</td>
                      <td>{row.won}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <h2>By service</h2>
            <div className="table-scroll">
              <table className="data-table">
                <caption className="visually-hidden">Enquiries by service</caption>
                <thead>
                  <tr>
                    <th scope="col">Service</th>
                    <th scope="col">Enquiries</th>
                    <th scope="col">Won</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byService.map((row) => (
                    <tr key={row.service}>
                      <td>{row.service}</td>
                      <td>{row.leads}</td>
                      <td>{row.won}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <h2>Converting pages</h2>
            {data.byLandingPath.length === 0 ? (
              <p className="muted">No form submissions recorded in this window.</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <caption className="visually-hidden">Form submissions by page</caption>
                  <thead>
                    <tr>
                      <th scope="col">Page</th>
                      <th scope="col">Form submissions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byLandingPath.map((row) => (
                      <tr key={row.path}>
                        <td>{row.path}</td>
                        <td>{row.conversions}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </DashboardShell>
  );
}
