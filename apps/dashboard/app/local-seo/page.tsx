import { redirect } from 'next/navigation';
import { apiFetch, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';

export const metadata = { title: 'Local SEO' };
export const dynamic = 'force-dynamic';

interface LocationSummary {
  readonly id: string;
  readonly displayName: string;
  readonly addressLocality: string;
  readonly telephone: string;
  readonly email: string;
  readonly openingHours: unknown;
  readonly sameAs: unknown;
  readonly googleBusinessProfileUrl: string | null;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly isPrimary: boolean;
}

export default async function LocalSeoPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const { items } = await apiFetch<{ items: LocationSummary[] }>('/v1/locations');
  const primary = items.find((item) => item.isPrimary) ?? items[0];
  const checks: readonly [string, boolean][] = [
    ['Primary location', Boolean(primary)],
    ['Opening hours', Array.isArray(primary?.openingHours) && primary.openingHours.length > 0],
    ['Verified profiles', Array.isArray(primary?.sameAs) && primary.sameAs.length > 0],
    ['Google Business Profile', Boolean(primary?.googleBusinessProfileUrl)],
    ['Coordinates', Boolean(primary?.latitude && primary.longitude)],
  ];

  return (
    <DashboardShell session={session} current="/local-seo">
      <div className="page-header">
        <div>
          <h1>Local SEO</h1>
          <p className="muted">Canonical NAP, location and corroboration coverage.</p>
        </div>
        {can(session, 'locations.write') ? (
          <a className="button button--primary" href="/local-seo/new">
            New location
          </a>
        ) : null}
      </div>

      <section className="panel">
        <h2>Coverage</h2>
        <div className="stat-grid">
          {checks.map(([label, ok]) => (
            <div key={label} className="stat-card">
              <strong>{ok ? 'Ready' : 'Missing'}</strong>
              <span>{label}</span>
            </div>
          ))}
        </div>
        <p className="muted">
          Missing data is shown as a gap; this screen never invents map pins, profiles or reviews.
        </p>
      </section>

      {items.length === 0 ? (
        <div className="panel">
          <h2>No locations yet</h2>
          <p className="muted">
            Add the real business location before publishing local structured data.
          </p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">Business locations</caption>
            <thead>
              <tr>
                <th scope="col">Location</th>
                <th scope="col">City</th>
                <th scope="col">Telephone</th>
                <th scope="col">Email</th>
                <th scope="col">Primary</th>
              </tr>
            </thead>
            <tbody>
              {items.map((location) => (
                <tr key={location.id}>
                  <th scope="row">
                    {can(session, 'locations.write') ? (
                      <a href={`/local-seo/${location.id}`}>{location.displayName}</a>
                    ) : (
                      location.displayName
                    )}
                  </th>
                  <td>{location.addressLocality}</td>
                  <td>{location.telephone}</td>
                  <td>{location.email}</td>
                  <td>{location.isPrimary ? 'Yes' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DashboardShell>
  );
}
