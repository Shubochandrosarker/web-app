import { notFound, redirect } from 'next/navigation';
import { apiFetch, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { AppointmentForm } from '@/components/appointment-form';
import type { AppointmentPayload } from '@/lib/actions';

export const metadata = { title: 'Appointment' };
export const dynamic = 'force-dynamic';

export default async function AppointmentPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const { id } = await params;
  const result = await apiFetch<{ appointment: AppointmentPayload & { id: string } }>(
    `/v1/appointments/${id}`,
  ).catch(() => null);
  if (!result) notFound();
  const initial: AppointmentPayload = {
    ...result.appointment,
    startsAt: new Date(result.appointment.startsAt).toISOString().slice(0, 16),
    endsAt: new Date(result.appointment.endsAt).toISOString().slice(0, 16),
  };
  return (
    <DashboardShell session={session} current="/appointments">
      <div className="page-header">
        <div>
          <h1>Appointment</h1>
          <p className="muted">Update timing, channel or status.</p>
        </div>
        <a className="button" href="/appointments">
          Back to appointments
        </a>
      </div>
      <AppointmentForm
        appointmentId={id}
        initial={initial}
        canWrite={can(session, 'appointments.write')}
      />
    </DashboardShell>
  );
}
