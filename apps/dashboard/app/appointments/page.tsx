import { redirect } from 'next/navigation';
import { apiFetch, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';

export const metadata = { title: 'Appointments' };
export const dynamic = 'force-dynamic';

interface AppointmentSummary {
  readonly id: string;
  readonly contactName: string | null;
  readonly contactEmail: string | null;
  readonly serviceName: string | null;
  readonly status: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
  readonly channel: string;
}

export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const params = await searchParams;
  const status = params.status ?? '';
  const query = status ? `?status=${encodeURIComponent(status)}&limit=100` : '?limit=100';
  const { items } = await apiFetch<{ items: AppointmentSummary[] }>(`/v1/appointments${query}`);
  return (
    <DashboardShell session={session} current="/appointments">
      <div className="page-header">
        <div>
          <h1>Appointments</h1>
          <p className="muted">
            Bookings, reschedules and cancellations in the workspace time zone.
          </p>
        </div>
        {can(session, 'appointments.write') ? (
          <a className="button button--primary" href="/appointments/new">
            New appointment
          </a>
        ) : null}
        <a className="button" href="/appointments/availability">
          Availability
        </a>
        <form className="toolbar" method="get">
          <label className="visually-hidden" htmlFor="appointment-status">
            Status
          </label>
          <select id="appointment-status" name="status" defaultValue={status}>
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="confirmed">Confirmed</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
            <option value="no_show">No show</option>
          </select>
          <button type="submit" className="button">
            Filter
          </button>
        </form>
      </div>
      {items.length === 0 ? (
        <div className="panel">
          <h2>No appointments</h2>
          <p className="muted">Bookings created through the public flow or by staff appear here.</p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">Appointments</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Contact</th>
                <th scope="col">Service</th>
                <th scope="col">Channel</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((appointment) => (
                <tr key={appointment.id}>
                  <th scope="row">
                    <a href={`/appointments/${appointment.id}`}>
                      {new Date(appointment.startsAt).toLocaleString()}
                    </a>
                    <br />
                    <span className="muted">{appointment.timeZone}</span>
                  </th>
                  <td>{appointment.contactName ?? appointment.contactEmail ?? appointment.id}</td>
                  <td>{appointment.serviceName ?? '—'}</td>
                  <td>{appointment.channel}</td>
                  <td>
                    <span className={`badge badge--${appointment.status}`}>
                      {appointment.status}
                    </span>
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
