import { redirect } from 'next/navigation';
import { apiFetch, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { MediaLibrary, type MediaItem } from '@/components/media-library';

export const metadata = { title: 'Media' };
export const dynamic = 'force-dynamic';

export default async function MediaPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const params = await searchParams;
  const query = new URLSearchParams({ limit: '100' });
  if (params.search) query.set('search', params.search);

  const { items } = await apiFetch<{ items: MediaItem[] }>(
    `/v1/cms/media?${query.toString()}`,
  ).catch(() => ({ items: [] as MediaItem[] }));

  // Whether uploads can work is a deployment fact the page knows only by the
  // presence of a media origin; the API's own refusal is the real gate.
  const storageConfigured = Boolean(process.env.NEXT_PUBLIC_MEDIA_ORIGIN);

  return (
    <DashboardShell session={session} businessType="education_service" current="/media">
      <div className="page-header">
        <div>
          <h1>Media</h1>
          <p className="muted">
            {items.length} {items.length === 1 ? 'image' : 'images'}
          </p>
        </div>

        <form className="toolbar" method="get">
          <label className="visually-hidden" htmlFor="search">
            Search media
          </label>
          <input
            id="search"
            name="search"
            type="search"
            placeholder="Search by name or alt text"
            defaultValue={params.search ?? ''}
          />
          <button type="submit" className="button">
            Search
          </button>
        </form>
      </div>

      <MediaLibrary
        items={items}
        canWrite={can(session, 'media.write')}
        canDelete={can(session, 'media.delete')}
        storageConfigured={storageConfigured}
      />
    </DashboardShell>
  );
}
