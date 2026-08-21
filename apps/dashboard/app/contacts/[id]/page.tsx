import { notFound, redirect } from 'next/navigation';
import { apiFetch, ApiRequestError, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { RelativeTime } from '@/components/relative-time';
import { DocumentList, type DocumentRow } from '@/components/document-list';

export const dynamic = 'force-dynamic';

interface ContactDetail {
  readonly contact: {
    readonly id: string;
    readonly fullName: string;
    readonly email: string | null;
    readonly phone: string | null;
    readonly whatsapp: string | null;
    readonly locale: string | null;
    readonly marketingConsentAt: string | null;
    readonly createdAt: string;
    readonly lastActivityAt: string | null;
  };
  readonly leads: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly createdAt: string;
  }[];
  readonly activities: readonly {
    readonly id: string;
    readonly type: string;
    readonly summary: string | null;
    readonly occurredAt: string;
  }[];
}

export default async function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const { id } = await params;

  let detail: ContactDetail;
  try {
    detail = await apiFetch<ContactDetail>(`/v1/crm/contacts/${id}`);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) notFound();
    throw error;
  }

  const documents = can(session, 'documents.read')
    ? await apiFetch<{ items: DocumentRow[] }>(`/v1/documents?contactId=${id}`).catch(() => ({
        items: [] as DocumentRow[],
      }))
    : { items: [] as DocumentRow[] };

  const { contact } = detail;

  return (
    <DashboardShell session={session} businessType="education_service" current="/contacts">
      <div className="page-header">
        <div>
          <p className="breadcrumb">
            <a href="/contacts">Contacts</a>
          </p>
          <h1>{contact.fullName}</h1>
          <p className="muted">
            First seen <RelativeTime iso={contact.createdAt} />
            {contact.lastActivityAt ? (
              <>
                {' '}
                · last activity <RelativeTime iso={contact.lastActivityAt} />
              </>
            ) : null}
          </p>
        </div>
      </div>

      <div className="detail-grid">
        <div className="detail-main">
          <section className="panel">
            <h2>Leads</h2>
            {detail.leads.length === 0 ? (
              <p className="muted">No leads yet.</p>
            ) : (
              <ul className="task-list">
                {detail.leads.map((lead) => (
                  <li key={lead.id}>
                    <span>
                      <a href={`/leads/${lead.id}`}>{lead.title}</a>{' '}
                      <span className={`badge badge--${lead.status}`}>{lead.status}</span>
                    </span>
                    <RelativeTime iso={lead.createdAt} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {can(session, 'documents.read') ? (
            <section className="panel">
              <h2>Documents</h2>
              <DocumentList
                documents={documents.items}
                canDownload={can(session, 'documents.download')}
                canDelete={can(session, 'documents.delete')}
              />
            </section>
          ) : null}

          <section className="panel">
            <h2>Activity</h2>
            {detail.activities.length === 0 ? (
              <p className="muted">Nothing recorded yet.</p>
            ) : (
              <ol className="timeline">
                {detail.activities.map((activity) => (
                  <li key={activity.id}>
                    <p>{activity.summary ?? activity.type}</p>
                    <p className="muted">
                      <RelativeTime iso={activity.occurredAt} />
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside className="detail-side">
          <section className="panel">
            <h2>Reach them</h2>
            <dl className="detail-list">
              <div>
                <dt>Phone</dt>
                <dd>{contact.phone ?? '—'}</dd>
              </div>
              <div>
                <dt>WhatsApp</dt>
                <dd>{contact.whatsapp ?? '—'}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{contact.email ?? '—'}</dd>
              </div>
              <div>
                <dt>Consent to contact</dt>
                <dd>
                  {contact.marketingConsentAt ? (
                    <>
                      Given <RelativeTime iso={contact.marketingConsentAt} />
                    </>
                  ) : (
                    'Not recorded'
                  )}
                </dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </DashboardShell>
  );
}
