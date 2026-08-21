import { redirect } from 'next/navigation';
import { apiFetch, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { DocumentList, type DocumentRow } from '@/components/document-list';

export const metadata = { title: 'Documents' };
export const dynamic = 'force-dynamic';

const STATUS_FILTERS = [
  { value: '', label: 'Everything' },
  { value: 'clean', label: 'Verified' },
  { value: 'scanning', label: 'Being checked' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'expired', label: 'Expired' },
];

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const params = await searchParams;
  const query = new URLSearchParams({ limit: '100' });
  if (params.status) query.set('status', params.status);

  const { items } = await apiFetch<{ items: DocumentRow[] }>(
    `/v1/documents?${query.toString()}`,
  ).catch(() => ({ items: [] as DocumentRow[] }));

  return (
    <DashboardShell session={session} businessType="education_service" current="/documents">
      <div className="page-header">
        <div>
          <h1>Documents</h1>
          <p className="muted">
            Everything visitors have uploaded, with its verification state. Opening a file is
            recorded.
          </p>
        </div>

        <form className="toolbar" method="get">
          <label className="visually-hidden" htmlFor="status">
            Status
          </label>
          <select id="status" name="status" defaultValue={params.status ?? ''}>
            {STATUS_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button type="submit" className="button">
            Filter
          </button>
        </form>
      </div>

      <div className="panel">
        <DocumentList
          documents={items}
          canDownload={can(session, 'documents.download')}
          canDelete={can(session, 'documents.delete')}
        />
      </div>

      {!can(session, 'documents.download') ? (
        <p className="muted">
          Your role can see that documents exist but not open them — opening needs the separate
          download permission, so the audit trail has someone to name.
        </p>
      ) : null}
    </DashboardShell>
  );
}
