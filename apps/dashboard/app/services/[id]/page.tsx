import { notFound, redirect } from 'next/navigation';
import { apiFetch, ApiRequestError, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { ServiceForm } from '@/components/service-form';
import type { ServicePayload } from '@/lib/actions';

export const dynamic = 'force-dynamic';

interface ServiceDetail extends ServicePayload {
  readonly id: string;
  readonly updatedAt: string;
}

export default async function ServiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const { id } = await params;

  let service: ServiceDetail;
  try {
    service = await apiFetch<ServiceDetail>(`/v1/services/${id}`);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) notFound();
    throw error;
  }

  return (
    <DashboardShell session={session} current="/services">
      <div className="page-header">
        <div>
          <p className="breadcrumb">
            <a href="/services">Services</a>
          </p>
          <h1>{service.name}</h1>
          <p className="muted">
            <code>{service.slug}</code>
          </p>
        </div>
      </div>
      <ServiceForm
        serviceId={service.id}
        initial={{
          name: service.name,
          slug: service.slug,
          summary: service.summary,
          status: service.status,
          priceAmount: service.priceAmount,
          priceCurrency: service.priceCurrency,
          priceNote: service.priceNote,
          durationMinutes: service.durationMinutes,
          turnaroundNote: service.turnaroundNote,
          requirements: Array.isArray(service.requirements) ? service.requirements.map(String) : [],
          bookable: service.bookable,
        }}
        canWrite={can(session, 'services.write')}
      />
    </DashboardShell>
  );
}
