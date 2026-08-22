import { redirect } from 'next/navigation';
import { can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { AppointmentForm } from '@/components/appointment-form';
import type { AppointmentPayload } from '@/lib/actions';

export const metadata = { title: 'New appointment' };
export const dynamic = 'force-dynamic';

export default async function NewAppointmentPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const initial: AppointmentPayload = {
    contactId: '',
    leadId: null,
    serviceId: null,
    staffProfileId: null,
    locationId: null,
    startsAt: '',
    endsAt: '',
    timeZone: 'Asia/Dhaka',
    channel: 'on_site',
    meetingUrl: null,
    notes: null,
    status: 'pending',
  };
  return (
    <DashboardShell session={session} current="/appointments">
      <div className="page-header">
        <div>
          <h1>New appointment</h1>
          <p className="muted">
            Create a workspace-scoped booking. The contact must already exist.
          </p>
        </div>
      </div>
      <AppointmentForm
        appointmentId={null}
        initial={initial}
        canWrite={can(session, 'appointments.write')}
      />
    </DashboardShell>
  );
}
