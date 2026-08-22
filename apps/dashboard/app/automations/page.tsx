import { redirect } from 'next/navigation';
import { apiFetch, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { RelativeTime } from '@/components/relative-time';

export const dynamic = 'force-dynamic';

/**
 * The automations list: what runs by itself, whether it is on, and — most
 * importantly — whether any of it is failing. A failed run is a customer who
 * did not get a message they were promised, so the failure count is the
 * loudest thing on the row.
 */

interface AutomationRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly enabled: boolean;
  readonly currentVersion: number;
  readonly triggerEvent: string | null;
  readonly runCount: number;
  readonly activeRunCount: number;
  readonly failedRunCount: number;
  readonly lastRunAt: string | null;
  readonly updatedAt: string;
}

const TRIGGER_LABELS: Record<string, string> = {
  'lead.created': 'When a new enquiry arrives',
  'form.submitted': 'When a form is submitted',
  'lead.stage_changed': 'When an enquiry changes stage',
  'lead.assigned': 'When an enquiry is assigned',
  'lead.converted': 'When an enquiry is won',
  'lead.lost': 'When an enquiry is lost',
  'contact.created': 'When a contact is created',
  'document.uploaded': 'When a document is uploaded',
  'document.verified': 'When a document passes checks',
  'task.completed': 'When a task is completed',
  'whatsapp.replied': 'When the person replies on WhatsApp',
  'appointment.created': 'When an appointment is booked',
};

export default async function AutomationsPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const { items } = await apiFetch<{ items: AutomationRow[] }>('/v1/automations').catch(() => ({
    items: [] as AutomationRow[],
  }));
  const canWrite = can(session, 'automations.write');

  return (
    <DashboardShell session={session} businessType="education_service" current="/automations">
      <div className="page-header">
        <div>
          <h1>Automations</h1>
          <p className="muted">
            Sequences that run by themselves — follow-ups, reminders, routing.
          </p>
        </div>
        {canWrite ? (
          <a className="button button--primary" href="/automations/new">
            New automation
          </a>
        ) : null}
      </div>

      {items.length === 0 ? (
        <div className="panel">
          <h2>Nothing automated yet</h2>
          <p className="muted">
            An automation reacts to something happening — a new enquiry, a form submission — and
            works through steps you define: send a WhatsApp template, wait a day, create a task
            for a colleague.
          </p>
          {canWrite ? (
            <p>
              <a className="button button--primary" href="/automations/new">
                Build the first one
              </a>
            </p>
          ) : null}
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">Automations</caption>
            <thead>
              <tr>
                <th scope="col">Automation</th>
                <th scope="col">Starts</th>
                <th scope="col">State</th>
                <th scope="col">Runs</th>
                <th scope="col">Last run</th>
              </tr>
            </thead>
            <tbody>
              {items.map((automation) => (
                <tr key={automation.id}>
                  <td>
                    <a href={`/automations/${automation.id}`}>
                      <strong>{automation.name}</strong>
                    </a>
                    {automation.description ? (
                      <>
                        <br />
                        <span className="muted">{automation.description}</span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    {automation.triggerEvent
                      ? (TRIGGER_LABELS[automation.triggerEvent] ?? automation.triggerEvent)
                      : '—'}
                  </td>
                  <td>
                    <span className={automation.enabled ? 'badge badge--won' : 'badge badge--muted'}>
                      {automation.enabled ? 'On' : 'Off'}
                    </span>
                  </td>
                  <td>
                    {automation.runCount}
                    {automation.activeRunCount > 0 ? (
                      <span className="muted"> · {automation.activeRunCount} in progress</span>
                    ) : null}
                    {automation.failedRunCount > 0 ? (
                      <>
                        {' '}
                        <span className="badge badge--lost">
                          {automation.failedRunCount} failed
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    {automation.lastRunAt ? <RelativeTime iso={automation.lastRunAt} /> : 'Never'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DashboardShell>
  );
}
