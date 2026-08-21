import { notFound, redirect } from 'next/navigation';
import { apiFetch, ApiRequestError, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { RelativeTime } from '@/components/relative-time';
import { LeadControls } from '@/components/lead-controls';
import { LeadNotes } from '@/components/lead-notes';
import type { Pipeline } from '@/app/leads/page';

export const dynamic = 'force-dynamic';

interface LeadDetail {
  readonly lead: {
    readonly id: string;
    readonly title: string | null;
    readonly status: string;
    readonly stageId: string | null;
    readonly source: string;
    readonly assignedToUserId: string | null;
    readonly followUpAt: string | null;
    readonly landingPath: string | null;
    readonly createdAt: string;
    readonly attribution: {
      readonly firstTouch?: {
        channel?: string;
        landingPath?: string;
        utm?: Record<string, string>;
      };
      readonly lastTouch?: { channel?: string; landingPath?: string; utm?: Record<string, string> };
    };
  };
  readonly contact: {
    readonly id: string;
    readonly fullName: string | null;
    readonly email: string | null;
    readonly phone: string | null;
    readonly whatsapp: string | null;
    readonly createdAt: string;
  };
  readonly serviceName: string | null;
  readonly stageName: string | null;
  readonly activities: readonly {
    readonly id: string;
    readonly type: string;
    readonly summary: string;
    readonly occurredAt: string;
  }[];
  readonly notes: readonly {
    readonly id: string;
    readonly body: string;
    readonly createdAt: string;
  }[];
  readonly tasks: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly dueAt: string | null;
  }[];
  readonly submission: {
    readonly id: string;
    readonly payload: Record<string, unknown>;
    readonly createdAt: string;
  } | null;
  readonly documents: readonly {
    readonly id: string;
    readonly kind: string;
    readonly originalFilename: string;
    readonly sizeBytes: number;
    readonly status: string;
  }[];
}

interface Assignee {
  readonly userId: string;
  readonly fullName: string;
  readonly role: string;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: `Request ${id.slice(0, 8)}` };
}

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const { id } = await params;

  let detail: LeadDetail;
  try {
    detail = await apiFetch<LeadDetail>(`/v1/crm/leads/${id}`);
  } catch (error) {
    // The API answers 404 for a lead in another workspace as well as one that
    // does not exist. Both are "not found" here, which is the point.
    if (error instanceof ApiRequestError && error.status === 404) notFound();
    throw error;
  }

  const [pipelines, assignees] = await Promise.all([
    apiFetch<{ pipelines: Pipeline[] }>('/v1/crm/pipelines'),
    can(session, 'leads.assign')
      ? apiFetch<{ assignees: Assignee[] }>('/v1/crm/assignees')
      : Promise.resolve({ assignees: [] as Assignee[] }),
  ]);

  const pipeline = pipelines.pipelines.find((entry) => entry.isDefault) ?? pipelines.pipelines[0];
  const { lead, contact } = detail;

  return (
    <DashboardShell session={session} businessType="education_service" current="/leads">
      <div className="page-header">
        <div>
          <p className="breadcrumb">
            <a href="/leads">Service requests</a>
          </p>
          <h1>{contact.fullName ?? 'Unnamed enquiry'}</h1>
          <p className="muted">
            {detail.serviceName ? `${detail.serviceName} · ` : ''}
            Received <RelativeTime iso={lead.createdAt} />
            {lead.landingPath ? ` from ${lead.landingPath}` : ''}
          </p>
        </div>

        {/*
          The two actions somebody takes first, at the top, as plain links. A
          member of staff opening a request is usually about to call.
        */}
        <div className="page-actions">
          {contact.phone ? (
            <a className="button button--primary" href={`tel:${contact.phone}`}>
              Call {contact.phone}
            </a>
          ) : null}
          {(contact.whatsapp ?? contact.phone) ? (
            <a
              className="button"
              href={`https://wa.me/${(contact.whatsapp ?? contact.phone ?? '').replace(/[^\d]/g, '')}`}
              rel="noopener noreferrer"
            >
              WhatsApp
            </a>
          ) : null}
        </div>
      </div>

      <div className="detail-grid">
        <div className="detail-main">
          {can(session, 'leads.write') && pipeline ? (
            <LeadControls
              leadId={lead.id}
              pipeline={pipeline}
              currentStageId={lead.stageId}
              currentStatus={lead.status}
              currentAssignee={lead.assignedToUserId}
              assignees={assignees.assignees}
              canAssign={can(session, 'leads.assign')}
            />
          ) : null}

          {/* ------------------------------------------------ what they asked */}

          {detail.submission ? (
            <section className="panel">
              <h2>What they submitted</h2>
              <dl className="detail-list">
                {Object.entries(detail.submission.payload).map(([key, value]) => (
                  <div key={key}>
                    <dt>{humanise(key)}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : (
            /*
             * Absent either because there is no submission, or because this
             * person does not hold `forms.submissions.read`. Saying so beats a
             * blank space that reads as a bug.
             */
            <section className="panel">
              <h2>What they submitted</h2>
              <p className="muted">The submitted details are not available to your role.</p>
            </section>
          )}

          {/* -------------------------------------------------------- documents */}

          {detail.documents.length > 0 ? (
            <section className="panel">
              <h2>Attached documents</h2>
              <ul className="document-list">
                {detail.documents.map((document) => (
                  <li key={document.id}>
                    <span>{document.originalFilename}</span>
                    <span className="muted">
                      {document.kind} · {Math.round(document.sizeBytes / 1024)} KB
                    </span>
                    {can(session, 'documents.download') ? (
                      /*
                       * A form, not a link: opening a document mints a
                       * short-lived signed URL and writes an audit row, and
                       * neither should happen because a page was prefetched.
                       */
                      <a className="button" href={`/documents/${document.id}`}>
                        Open
                      </a>
                    ) : (
                      <span className="badge badge--muted">Download not permitted</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <LeadNotes
            leadId={lead.id}
            notes={detail.notes}
            tasks={detail.tasks}
            canWrite={can(session, 'leads.write')}
            canAddTask={can(session, 'tasks.write')}
          />
        </div>

        <aside className="detail-side">
          <section className="panel">
            <h2>Contact</h2>
            <dl className="detail-list">
              <div>
                <dt>Name</dt>
                <dd>{contact.fullName ?? '—'}</dd>
              </div>
              <div>
                <dt>Phone</dt>
                <dd>
                  {contact.phone ? <a href={`tel:${contact.phone}`}>{contact.phone}</a> : '—'}
                </dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>
                  {contact.email ? <a href={`mailto:${contact.email}`}>{contact.email}</a> : '—'}
                </dd>
              </div>
              <div>
                <dt>First seen</dt>
                <dd>
                  <RelativeTime iso={contact.createdAt} />
                </dd>
              </div>
            </dl>
            <a href={`/contacts/${contact.id}`} className="muted">
              All requests from this person
            </a>
          </section>

          {/* ------------------------------------------------------ attribution */}

          <section className="panel">
            <h2>Where this came from</h2>
            <dl className="detail-list">
              <div>
                <dt>First touch</dt>
                <dd>{describeTouch(lead.attribution.firstTouch)}</dd>
              </div>
              <div>
                <dt>Last touch</dt>
                <dd>{describeTouch(lead.attribution.lastTouch)}</dd>
              </div>
              <div>
                <dt>Page</dt>
                <dd>{lead.landingPath ?? '—'}</dd>
              </div>
            </dl>
          </section>

          {/* --------------------------------------------------------- timeline */}

          <section className="panel">
            <h2>Timeline</h2>
            <ol className="timeline">
              {detail.activities.map((activity) => (
                <li key={activity.id}>
                  <p>{activity.summary}</p>
                  <p className="muted">
                    <RelativeTime iso={activity.occurredAt} />
                  </p>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </DashboardShell>
  );
}

function humanise(key: string): string {
  return key.replace(/[_-]+/g, ' ').replace(/^./, (character) => character.toUpperCase());
}

function describeTouch(
  touch: { channel?: string; utm?: Record<string, string> } | undefined,
): string {
  if (!touch?.channel) return 'Not recorded';
  const source = touch.utm?.source;
  const readable = touch.channel.replace(/_/g, ' ');
  return source ? `${readable} (${source})` : readable;
}
