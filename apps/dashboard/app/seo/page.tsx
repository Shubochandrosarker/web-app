import { redirect } from 'next/navigation';
import { apiFetch, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { SeoSuggestionsPanel } from '@/components/seo-suggestions';

export const dynamic = 'force-dynamic';

/**
 * The SEO screen: the audit's findings with plain-language explanations,
 * Search Console opportunities, and the AI suggestions panel.
 *
 * No composite score anywhere, on purpose — the audit reports what is wrong
 * and why it matters, which is actionable in a way "73/100" is not.
 */

interface Audit {
  readonly generatedAt: string;
  readonly pagesAudited: number;
  readonly summary: { critical: number; warning: number; notice: number };
  readonly checks: readonly {
    id: string;
    severity: 'critical' | 'warning' | 'notice';
    category?: 'technical' | 'content' | 'answers';
    label: string;
    explanation: string;
    findings: readonly { path: string; title: string; detail: string }[];
  }[];
  readonly opportunities: readonly {
    query: string;
    clicks: number;
    impressions: number;
    position: number;
    kind: 'striking_distance' | 'low_ctr';
  }[];
  readonly aiProvider: string | null;
}

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'lost',
  warning: 'scheduled',
  notice: 'muted',
};

export default async function SeoPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const [audit, published] = await Promise.all([
    apiFetch<Audit>('/v1/seo/audit').catch(() => null),
    apiFetch<{ items: { id: string; path: string; title: string }[] }>(
      '/v1/cms/content?status=published&limit=100',
    ).catch(() => ({ items: [] })),
  ]);

  return (
    <DashboardShell session={session} current="/seo">
      <div className="page-header">
        <div>
          <h1>SEO</h1>
          <p className="muted">
            What search engines see, what needs fixing, and where the easy wins are.
          </p>
        </div>
      </div>

      {!audit ? (
        <div className="panel">
          <h2>The audit could not run</h2>
          <p className="muted">Try again in a moment; if it persists, check the API logs.</p>
        </div>
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat-card">
              <p className="stat-value">{audit.pagesAudited}</p>
              <p className="stat-label">Published pages audited</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">{audit.summary.critical}</p>
              <p className="stat-label">Critical findings</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">{audit.summary.warning}</p>
              <p className="stat-label">Warnings</p>
            </div>
            <div className="stat-card">
              <p className="stat-value">{audit.summary.notice}</p>
              <p className="stat-label">Notices</p>
            </div>
          </div>

          {audit.checks.length === 0 ? (
            <div className="panel">
              <h2>Nothing to fix</h2>
              <p className="muted">
                Every check passed across {audit.pagesAudited} published page
                {audit.pagesAudited === 1 ? '' : 's'}.
              </p>
            </div>
          ) : (
            audit.checks.map((check) => (
              <details className="panel" key={check.id} open={check.severity === 'critical'}>
                <summary>
                  <span className={`badge badge--${SEVERITY_BADGE[check.severity] ?? 'muted'}`}>
                    {check.severity}
                  </span>{' '}
                  {check.category ? (
                    <span className="badge badge--muted">{check.category}</span>
                  ) : null}{' '}
                  <strong>{check.label}</strong>{' '}
                  <span className="muted">({check.findings.length})</span>
                </summary>
                <p className="muted">{check.explanation}</p>
                <div className="table-scroll">
                  <table className="data-table">
                    <caption className="visually-hidden">{check.label}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Page</th>
                        <th scope="col">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {check.findings.map((finding, index) => (
                        <tr key={`${finding.path}-${index}`}>
                          <td>
                            {finding.path}
                            <br />
                            <span className="muted">{finding.title}</span>
                          </td>
                          <td>{finding.detail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ))
          )}

          <section className="panel">
            <h2>Search opportunities</h2>
            {audit.opportunities.length === 0 ? (
              <p className="muted">
                Appears once Search Console is connected and has data: queries ranking just off page
                one (worth strengthening) and page-one queries nobody clicks (worth a better title
                and description).
              </p>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <caption className="visually-hidden">Search Console opportunities</caption>
                  <thead>
                    <tr>
                      <th scope="col">Query</th>
                      <th scope="col">Why it is an opportunity</th>
                      <th scope="col">Clicks</th>
                      <th scope="col">Impressions</th>
                      <th scope="col">Position</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.opportunities.map((opportunity) => (
                      <tr key={`${opportunity.kind}-${opportunity.query}`}>
                        <td>{opportunity.query}</td>
                        <td>
                          {opportunity.kind === 'striking_distance'
                            ? 'Ranks just off the top — strengthening the page could move it up'
                            : 'On page one but rarely clicked — the title/description need work'}
                        </td>
                        <td>{opportunity.clicks}</td>
                        <td>{opportunity.impressions}</td>
                        <td>{opportunity.position.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {can(session, 'seo.write') ? (
            <SeoSuggestionsPanel pages={published.items} aiConfigured={audit.aiProvider !== null} />
          ) : null}
        </>
      )}
    </DashboardShell>
  );
}
