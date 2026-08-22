import { redirect } from 'next/navigation';
import { apiFetch, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { pickDays, WindowSwitch } from '@/components/analytics-bits';

export const dynamic = 'force-dynamic';

/**
 * Google Search Console, inside the dashboard.
 *
 * Three states, each honest: not configured (setup instructions), configured
 * but no rows yet (Google's data lags ~2 days), and data. Rows come from the
 * nightly ingest into `search_console_daily`, never live from Google — so
 * the screen is fast and works when Google's API is having a day.
 */

interface SearchData {
  readonly dimension: string;
  readonly configured: boolean;
  readonly latestDate: string | null;
  readonly rows: readonly {
    value: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }[];
}

const DIMENSIONS = [
  { key: 'query', label: 'Queries', column: 'Search query' },
  { key: 'page', label: 'Pages', column: 'Page' },
  { key: 'device', label: 'Devices', column: 'Device' },
  { key: 'country', label: 'Countries', column: 'Country' },
] as const;

export default async function SearchAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; dimension?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const params = await searchParams;
  const days = pickDays(params.days);
  const dimension = DIMENSIONS.some((entry) => entry.key === params.dimension)
    ? (params.dimension as string)
    : 'query';

  const data = await apiFetch<SearchData>(
    `/v1/analytics/search?days=${days}&dimension=${dimension}`,
  ).catch(() => null);

  const active = DIMENSIONS.find((entry) => entry.key === dimension)!;

  return (
    <DashboardShell session={session} current="/analytics/search">
      <div className="page-header">
        <div>
          <h1>Search performance</h1>
          <p className="muted">What Google shows for the site, from Search Console.</p>
        </div>
        <WindowSwitch base="/analytics/search" days={days} extra={`&dimension=${dimension}`} />
      </div>

      {!data || (!data.configured && data.rows.length === 0) ? (
        <div className="panel">
          <h2>Connect Search Console</h2>
          <p>
            This screen fills itself nightly once the platform can read the site&apos;s Search
            Console property:
          </p>
          <ol>
            <li>Create a Google Cloud service account and download its key.</li>
            <li>
              In Search Console, add the service account&apos;s email as a user on the property
              (Restricted access is enough).
            </li>
            <li>
              Set <code>GSC_CLIENT_EMAIL</code>, <code>GSC_PRIVATE_KEY</code> and{' '}
              <code>GSC_WORKSPACE</code> in the API environment (and <code>GSC_PROPERTY</code> if
              the property is not the site URL).
            </li>
          </ol>
          <p className="muted">
            Recorded as an owner task in <code>docs/owner-input-required.md</code> — nothing here
            blocks the rest of the platform.
          </p>
        </div>
      ) : (
        <>
          <nav className="view-switch" aria-label="Search dimensions">
            {DIMENSIONS.map((entry) => (
              <a
                key={entry.key}
                href={`/analytics/search?days=${days}&dimension=${entry.key}`}
                className={entry.key === dimension ? 'active' : ''}
              >
                {entry.label}
              </a>
            ))}
          </nav>

          {data.rows.length === 0 ? (
            <div className="panel">
              <h2>Waiting for Google</h2>
              <p className="muted">
                Search Console is connected but has not returned rows for this window yet — Google
                finalises data roughly two days late.
                {data.latestDate ? ` Latest ingested day: ${data.latestDate}.` : ''}
              </p>
            </div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <caption className="visually-hidden">Search performance by {active.label}</caption>
                <thead>
                  <tr>
                    <th scope="col">{active.column}</th>
                    <th scope="col">Clicks</th>
                    <th scope="col">Impressions</th>
                    <th scope="col">CTR</th>
                    <th scope="col">Avg. position</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.value}>
                      <td>{row.value || '—'}</td>
                      <td>{row.clicks.toLocaleString('en')}</td>
                      <td>{row.impressions.toLocaleString('en')}</td>
                      <td>{(row.ctr * 100).toFixed(1)}%</td>
                      <td>{row.position.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.latestDate ? (
            <p className="muted">Latest ingested day: {data.latestDate}.</p>
          ) : null}
        </>
      )}
    </DashboardShell>
  );
}
