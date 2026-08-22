import { redirect } from 'next/navigation';
import { apiFetch, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { pickDays, StatCard, WindowSwitch } from '@/components/analytics-bits';

export const dynamic = 'force-dynamic';

/**
 * Traffic overview: what happened, against the same window before it.
 *
 * Rendered server-side as tables with proportional bars — legible, printable,
 * screen-reader-friendly, and honest about being counts rather than a chart
 * with implied precision.
 */

interface Overview {
  readonly current: { sessions: number; page_views: number; conversions: number; leads: number };
  readonly previous: { sessions: number; page_views: number; conversions: number; leads: number };
  readonly series: readonly {
    date: string;
    sessions: number;
    pageViews: number;
    conversions: number;
    leads: number;
  }[];
}

interface Pages {
  readonly pages: readonly {
    path: string;
    page_views: number;
    sessions: number;
    conversions: number;
  }[];
}

interface Sources {
  readonly channels: readonly { channel: string; sessions: number; conversions: number }[];
  readonly sources: readonly { channel: string; source: string; sessions: number }[];
}

const CHANNEL_LABELS: Record<string, string> = {
  direct: 'Direct',
  organic_search: 'Search engines',
  ai_assistant: 'AI assistants',
  social: 'Social media',
  referral: 'Other websites',
  paid_search: 'Paid search',
  email: 'Email',
};

function delta(current: number, previous: number): string {
  if (previous === 0) return current > 0 ? 'new' : '—';
  const change = Math.round(((current - previous) / previous) * 100);
  return `${change > 0 ? '+' : ''}${change}%`;
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const params = await searchParams;
  const days = pickDays(params.days);

  const [overview, pages, sources] = await Promise.all([
    apiFetch<Overview>(`/v1/analytics/overview?days=${days}`).catch(() => null),
    apiFetch<Pages>(`/v1/analytics/pages?days=${days}`).catch(() => ({ pages: [] })),
    apiFetch<Sources>(`/v1/analytics/sources?days=${days}`).catch(() => ({
      channels: [],
      sources: [],
    })),
  ]);

  const maxSessions = Math.max(1, ...(overview?.series.map((day) => day.sessions) ?? [1]));

  return (
    <DashboardShell session={session} current="/analytics">
      <div className="page-header">
        <div>
          <h1>Traffic</h1>
          <p className="muted">First-party analytics — no third-party trackers, no cookies.</p>
        </div>
        <WindowSwitch base="/analytics" days={days} />
      </div>

      {!overview ? (
        <div className="panel">
          <h2>No data yet</h2>
          <p className="muted">
            Numbers appear once the public site starts reporting visits. If the site is live and
            this stays empty, check that the edge collector is deployed.
          </p>
        </div>
      ) : (
        <>
          <div className="stat-grid">
            <StatCard
              label="Sessions"
              value={overview.current.sessions}
              compare={delta(overview.current.sessions, overview.previous.sessions)}
            />
            <StatCard
              label="Page views"
              value={overview.current.page_views}
              compare={delta(overview.current.page_views, overview.previous.page_views)}
            />
            <StatCard
              label="Form submissions"
              value={overview.current.conversions}
              compare={delta(overview.current.conversions, overview.previous.conversions)}
            />
            <StatCard
              label="New enquiries"
              value={overview.current.leads}
              compare={delta(overview.current.leads, overview.previous.leads)}
            />
          </div>

          <section className="panel">
            <h2>Day by day</h2>
            {overview.series.length === 0 ? (
              <p className="muted">
                The nightly rollup has not produced rows for this window yet — today&apos;s headline
                numbers above are live.
              </p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <caption className="visually-hidden">Sessions per day</caption>
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Sessions</th>
                      <th scope="col" className="bar-cell-header" aria-hidden="true"></th>
                      <th scope="col">Views</th>
                      <th scope="col">Submissions</th>
                      <th scope="col">Enquiries</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.series.map((day) => (
                      <tr key={day.date}>
                        <td>{day.date}</td>
                        <td>{day.sessions}</td>
                        <td className="bar-cell" aria-hidden="true">
                          <span
                            className="bar"
                            style={{ width: `${(day.sessions / maxSessions) * 100}%` }}
                          />
                        </td>
                        <td>{day.pageViews}</td>
                        <td>{day.conversions}</td>
                        <td>{day.leads}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      <section className="panel">
        <h2>Where visitors come from</h2>
        {sources.channels.length === 0 ? (
          <p className="muted">Nothing recorded in this window.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <caption className="visually-hidden">Traffic channels</caption>
              <thead>
                <tr>
                  <th scope="col">Channel</th>
                  <th scope="col">Sessions</th>
                  <th scope="col">Became a contact</th>
                </tr>
              </thead>
              <tbody>
                {sources.channels.map((channel) => (
                  <tr key={channel.channel}>
                    <td>{CHANNEL_LABELS[channel.channel] ?? channel.channel}</td>
                    <td>{channel.sessions}</td>
                    <td>{channel.conversions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {sources.sources.some((source) => source.channel === 'ai_assistant') ? (
          <>
            <h3>AI assistant referrals</h3>
            <ul>
              {sources.sources
                .filter((source) => source.channel === 'ai_assistant')
                .map((source) => (
                  <li key={source.source}>
                    {source.source} — {source.sessions} session{source.sessions === 1 ? '' : 's'}
                  </li>
                ))}
            </ul>
          </>
        ) : null}
      </section>

      <section className="panel">
        <h2>Top pages</h2>
        {pages.pages.length === 0 ? (
          <p className="muted">Nothing recorded in this window.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <caption className="visually-hidden">Top pages</caption>
              <thead>
                <tr>
                  <th scope="col">Page</th>
                  <th scope="col">Views</th>
                  <th scope="col">Sessions</th>
                  <th scope="col">Submissions</th>
                </tr>
              </thead>
              <tbody>
                {pages.pages.slice(0, 25).map((page) => (
                  <tr key={page.path}>
                    <td>{page.path}</td>
                    <td>{page.page_views}</td>
                    <td>{page.sessions}</td>
                    <td>{page.conversions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </DashboardShell>
  );
}
