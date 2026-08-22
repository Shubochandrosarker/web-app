import { redirect } from 'next/navigation';
import { apiFetch, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import {
  AvailabilityManager,
  type ExceptionRow,
  type RuleRow,
} from '@/components/availability-manager';

export const metadata = { title: 'Availability' };
export const dynamic = 'force-dynamic';

export default async function AvailabilityPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const { items: rules } = await apiFetch<{ items: RuleRow[] }>('/v1/availability/rules');
  const { items: exceptions } = await apiFetch<{ items: ExceptionRow[] }>(
    '/v1/availability/exceptions',
  );

  return (
    <DashboardShell session={session} current="/appointments">
      <div className="page-header">
        <div>
          <h1>Availability</h1>
          <p className="muted">
            Weekly hours, slot lengths, capacity and blackouts. Bookings are checked against these
            rules; slots are computed from them, never pre-generated.
          </p>
        </div>
        <a className="button" href="/appointments">
          Back to appointments
        </a>
      </div>
      <AvailabilityManager
        rules={rules}
        exceptions={exceptions}
        canWrite={can(session, 'appointments.write')}
      />
    </DashboardShell>
  );
}
