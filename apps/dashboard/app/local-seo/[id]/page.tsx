import { notFound, redirect } from 'next/navigation';
import { apiFetch, ApiRequestError, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { LocationForm } from '@/components/location-form';
import type { LocationPayload } from '@/lib/actions';

export const dynamic = 'force-dynamic';

export default async function LocationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const { id } = await params;
  let location: LocationPayload & { id: string };
  try {
    location = await apiFetch<LocationPayload & { id: string }>(`/v1/locations/${id}`);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) notFound();
    throw error;
  }
  return (
    <DashboardShell session={session} current="/local-seo">
      <div className="page-header">
        <div>
          <p className="breadcrumb">
            <a href="/local-seo">Local SEO</a>
          </p>
          <h1>{location.displayName}</h1>
        </div>
      </div>
      <LocationForm
        locationId={location.id}
        initial={location}
        canWrite={can(session, 'locations.write')}
      />
    </DashboardShell>
  );
}
