import { redirect } from 'next/navigation';
import { apiFetch, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';

export const metadata = { title: 'Services' };
export const dynamic = 'force-dynamic';

interface ServiceSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly summary: string | null;
  readonly priceAmount: number | null;
  readonly priceCurrency: string | null;
  readonly durationMinutes: number | null;
  readonly bookable: boolean;
}

export default async function ServicesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; search?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const params = await searchParams;
  const query = new URLSearchParams({ limit: '100' });
  if (params.status) query.set('status', params.status);
  if (params.search) query.set('search', params.search);
  const { items } = await apiFetch<{ items: ServiceSummary[] }>(`/v1/services?${query.toString()}`);

  return (
    <DashboardShell session={session} current="/services">
      <div className="page-header">
        <div>
          <h1>Services</h1>
          <p className="muted">The catalogue used by pages, forms and bookings.</p>
        </div>
        {can(session, 'services.write') ? (
          <a className="button button--primary" href="/services/new">
            New service
          </a>
        ) : null}
        <form className="toolbar" method="get">
          <label className="visually-hidden" htmlFor="service-search">
            Search services
          </label>
          <input
            id="service-search"
            name="search"
            type="search"
            placeholder="Search services"
            defaultValue={params.search ?? ''}
          />
          <select name="status" defaultValue={params.status ?? ''} aria-label="Filter by status">
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
          <h2>No services yet</h2>
          <p className="muted">
            Create the catalogue before publishing service pages or accepting requests.
          </p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">Services</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Status</th>
                <th scope="col">Price</th>
                <th scope="col">Duration</th>
                <th scope="col">Booking</th>
              </tr>
            </thead>
            <tbody>
              {items.map((service) => (
                <tr key={service.id}>
                  <th scope="row">
                    {can(session, 'services.write') ? (
                      <a href={`/services/${service.id}`}>{service.name}</a>
                    ) : (
                      service.name
                    )}
                    <br />
                    <code>{service.slug}</code>
                  </th>
                  <td>
                    <span className={`badge badge--${service.status}`}>{service.status}</span>
                  </td>
                  <td>
                    {service.priceAmount !== null
                      ? `${service.priceAmount} ${service.priceCurrency ?? ''}`
                      : 'On request'}
                  </td>
                  <td>{service.durationMinutes ? `${service.durationMinutes} min` : '—'}</td>
                  <td>{service.bookable ? 'Bookable' : 'Request only'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DashboardShell>
  );
}
