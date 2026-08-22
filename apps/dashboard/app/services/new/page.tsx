import { redirect } from 'next/navigation';
import { can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { ServiceForm } from '@/components/service-form';
import type { ServicePayload } from '@/lib/actions';

export const metadata = { title: 'New service' };

const emptyService: ServicePayload = {
  name: '',
  slug: '',
  summary: null,
  status: 'draft',
  priceAmount: null,
  priceCurrency: null,
  priceNote: null,
  durationMinutes: null,
  turnaroundNote: null,
  requirements: [],
  bookable: false,
};

export default async function NewServicePage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  if (!can(session, 'services.write')) redirect('/services');

  return (
    <DashboardShell session={session} current="/services">
      <div className="page-header">
        <div>
          <p className="breadcrumb">
            <a href="/services">Services</a>
          </p>
          <h1>New service</h1>
        </div>
      </div>
      <ServiceForm serviceId={null} initial={emptyService} canWrite />
    </DashboardShell>
  );
}
