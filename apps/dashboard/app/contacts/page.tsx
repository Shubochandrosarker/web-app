import { redirect } from 'next/navigation';
import { apiFetch, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { RelativeTime } from '@/components/relative-time';

export const metadata = { title: 'Contacts' };
export const dynamic = 'force-dynamic';

interface ContactSummary {
  readonly id: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly whatsapp: string | null;
  readonly marketingConsentAt: string | null;
  readonly lastActivityAt: string | null;
  readonly createdAt: string;
  readonly leadCount: number;
}

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; consent?: string; cursor?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const params = await searchParams;
  const query = new URLSearchParams({ limit: '50' });
  if (params.search) query.set('search', params.search);
  if (params.consent) query.set('consent', params.consent);
  if (params.cursor) query.set('cursor', params.cursor);

  const { items, nextCursor } = await apiFetch<{
    items: ContactSummary[];
    nextCursor?: string;
  }>(`/v1/crm/contacts?${query.toString()}`);

  const nextPageQuery = new URLSearchParams(query);
  if (nextCursor) nextPageQuery.set('cursor', nextCursor);

  return (
    <DashboardShell session={session} current="/contacts">
      <div className="page-header">
        <div>
          <h1>Contacts</h1>
          <p className="muted">Everyone who has enquired, with every lead they have raised.</p>
        </div>

        <form className="toolbar" method="get">
          <label className="visually-hidden" htmlFor="search">
            Search contacts
          </label>
          <input
            id="search"
            name="search"
            type="search"
            placeholder="Name, phone or email"
            defaultValue={params.search ?? ''}
          />
          <label className="visually-hidden" htmlFor="consent">
            Consent
          </label>
          <select id="consent" name="consent" defaultValue={params.consent ?? ''}>
            <option value="">Any consent</option>
            <option value="given">Consented to contact</option>
            <option value="none">No consent recorded</option>
          </select>
          <button type="submit" className="button">
            Filter
          </button>
        </form>
      </div>

      {items.length === 0 ? (
        <div className="panel">
          <h2>No contacts yet</h2>
          <p className="muted">
            {params.search || params.consent
              ? 'Nobody matches those filters.'
              : 'A contact is created automatically the first time somebody submits the service form.'}
          </p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">Contacts</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Reach them</th>
                <th scope="col">Leads</th>
                <th scope="col">Consent</th>
                <th scope="col">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {items.map((contact) => (
                <tr key={contact.id}>
                  <th scope="row">
                    <a href={`/contacts/${contact.id}`}>{contact.fullName}</a>
                  </th>
                  <td>
                    {[contact.phone, contact.email].filter(Boolean).join(' · ') || (
                      <span className="muted">No details</span>
                    )}
                  </td>
                  <td>{contact.leadCount}</td>
                  <td>
                    {contact.marketingConsentAt ? (
                      <span className="badge badge--won">Given</span>
                    ) : (
                      <span className="badge badge--muted">None</span>
                    )}
                  </td>
                  <td>
                    {contact.lastActivityAt ? (
                      <RelativeTime iso={contact.lastActivityAt} />
                    ) : (
                      <RelativeTime iso={contact.createdAt} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor ? (
        <p>
          <a className="button" href={`/contacts?${nextPageQuery.toString()}`}>
            Next page
          </a>
        </p>
      ) : null}
    </DashboardShell>
  );
}
