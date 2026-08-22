import { redirect } from 'next/navigation';
import { can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { LocationForm } from '@/components/location-form';
import type { LocationPayload } from '@/lib/actions';

export const metadata = { title: 'New location' };

const emptyLocation: LocationPayload = {
  slug: '',
  legalName: '',
  displayName: '',
  streetAddress: '',
  addressLocality: '',
  addressRegion: null,
  postalCode: null,
  addressCountry: 'BD',
  latitude: null,
  longitude: null,
  telephone: '',
  whatsapp: null,
  email: '',
  openingHours: [],
  areaServed: [],
  sameAs: [],
  googleBusinessProfileUrl: null,
  isPrimary: false,
};

export default async function NewLocationPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  if (!can(session, 'locations.write')) redirect('/local-seo');
  return (
    <DashboardShell session={session} current="/local-seo">
      <div className="page-header">
        <div>
          <p className="breadcrumb">
            <a href="/local-seo">Local SEO</a>
          </p>
          <h1>New location</h1>
        </div>
      </div>
      <LocationForm locationId={null} initial={emptyLocation} canWrite />
    </DashboardShell>
  );
}
