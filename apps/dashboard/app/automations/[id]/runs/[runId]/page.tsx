import { notFound, redirect } from 'next/navigation';
import { apiFetch, ApiRequestError, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { RelativeTime } from '@/components/relative-time';
import { RetryRunButton } from '@/components/automation-controls';

export const dynamic = 'force-dynamic';

/**
 * One run, step by step: what executed, what it produced, what failed and
 * why. This is the screen that answers "did the customer get the message" —
 * so outputs are shown in words where the shape is known, with the raw
 * record available underneath for debugging.
 */

interface RunStep {
  readonly id: string;
  readonly stepId: string;
  readonly sequence: number;
  readonly type: string;
  readonly action: string | null;
  readonly status: string;
  readonly attempt: number;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly output: Record<string, unknown> | null;
  readonly failureReason: string | null;
}

interface DefinitionStep {
  id: string;
  type: string;
  action?: string;
  event?: string;
  seconds?: number;
  then?: DefinitionStep[];
  otherwise?: DefinitionStep[];
}

interface RunDetail {
  readonly id: string;
  readonly automationId: string;
  readonly status: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly resumeAt: string | null;
  readonly waitingForEvent: string | null;
  readonly failureReason: string | null;
  readonly definition: { name?: string; steps?: DefinitionStep[] } | null;
  readonly steps: RunStep[];
}

const STATUS_BADGE: Record<string, string> = {
  running: 'open',
  waiting: 'scheduled',
  completed: 'won',
  failed: 'lost',
  cancelled: 'muted',
};

const ACTION_LABELS: Record<string, string> = {
  send_whatsapp: 'Send WhatsApp template',
  send_email: 'Send email',
  create_task: 'Create task',
  assign_user: 'Assign the enquiry',
  update_lead: 'Update the enquiry',
  add_tag: 'Add tag',
  remove_tag: 'Remove tag',
  call_webhook: 'Call webhook',
  notify_admin: 'Notify the team',
};

/** Human line for a step's recorded output, where the shape is known. */
function describeOutput(step: RunStep): string | null {
  const output = step.output ?? {};
  if (typeof output.skipped === 'string') return `Skipped: ${output.skipped}`;
  if (typeof output.sentTo === 'string') return `Sent to ${output.sentTo}`;
  if (typeof output.taskId === 'string') return 'Task created';
  if (typeof output.assignedTo === 'string') return 'Assigned';
  if (typeof output.decision === 'string')
    return output.decision === 'then' ? 'Checks passed' : 'Checks did not pass — other path';
  if (typeof output.tag === 'string') return `Tag: ${output.tag}`;
  if (typeof output.status === 'number') return `Webhook answered ${output.status}`;
  if (typeof output.seconds === 'number') {
    const hours = output.seconds / 3600;
    return `Slept ${hours >= 1 ? `${Math.round(hours)}h` : `${Math.round(output.seconds / 60)}m`}`;
  }
  if (typeof output.event === 'string') return `Waited for ${output.event}`;
  return null;
}

export default async function AutomationRunPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const { id, runId } = await params;

  let run: RunDetail;
  try {
    run = await apiFetch<RunDetail>(`/v1/automations/runs/${runId}`);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) notFound();
    throw error;
  }

  // Step labels come from the pinned definition — the version this run
  // actually executed, not whatever the automation says today.
  const labels = new Map<string, string>();
  const walk = (steps: DefinitionStep[] | undefined): void => {
    for (const step of steps ?? []) {
      labels.set(
        step.id,
        step.type === 'action'
          ? (ACTION_LABELS[step.action ?? ''] ?? step.action ?? 'Action')
          : step.type === 'wait'
            ? 'Wait'
            : step.type === 'wait_for_event'
              ? `Wait for ${step.event ?? 'event'}`
              : 'Branch',
      );
      walk(step.then);
      walk(step.otherwise);
    }
  };
  walk(run.definition?.steps);

  return (
    <DashboardShell session={session} businessType="education_service" current="/automations">
      <div className="page-header">
        <div>
          <p className="breadcrumb">
            <a href="/automations">Automations</a> ·{' '}
            <a href={`/automations/${id}`}>{run.definition?.name ?? 'Automation'}</a>
          </p>
          <h1>Run detail</h1>
          <p className="muted">
            Started <RelativeTime iso={run.startedAt} />
            {run.completedAt ? (
              <>
                {' '}
                · finished <RelativeTime iso={run.completedAt} />
              </>
            ) : null}
          </p>
        </div>
        <div>
          <span className={`badge badge--${STATUS_BADGE[run.status] ?? 'muted'}`}>
            {run.status}
          </span>{' '}
          {run.status === 'failed' && can(session, 'automations.write') ? (
            <RetryRunButton automationId={id} runId={run.id} />
          ) : null}
        </div>
      </div>

      {run.failureReason ? (
        <p className="form-error" role="alert">
          {run.failureReason}
        </p>
      ) : null}
      {run.status === 'waiting' ? (
        <p className="form-success" role="status">
          {run.waitingForEvent
            ? `Waiting for ${run.waitingForEvent}`
            : run.resumeAt
              ? 'Sleeping — resumes on schedule.'
              : 'Waiting.'}
        </p>
      ) : null}

      <section className="panel">
        <h2>Steps</h2>
        {run.steps.length === 0 ? (
          <p className="muted">Nothing has executed yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <caption className="visually-hidden">Executed steps</caption>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Step</th>
                  <th scope="col">Status</th>
                  <th scope="col">Attempt</th>
                  <th scope="col">What happened</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {run.steps.map((step) => (
                  <tr key={step.id}>
                    <td>{step.sequence}</td>
                    <td>{labels.get(step.stepId) ?? step.action ?? step.type}</td>
                    <td>
                      <span
                        className={`badge badge--${
                          step.status === 'completed'
                            ? 'won'
                            : step.status === 'failed'
                              ? 'lost'
                              : 'open'
                        }`}
                      >
                        {step.status}
                      </span>
                    </td>
                    <td>{step.attempt}</td>
                    <td>
                      {step.failureReason ? (
                        <span className="field-error">{step.failureReason}</span>
                      ) : (
                        (describeOutput(step) ?? '—')
                      )}
                    </td>
                    <td>
                      {step.completedAt ?? step.startedAt ? (
                        <RelativeTime iso={(step.completedAt ?? step.startedAt)!} />
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <details className="panel">
        <summary>Raw run record (for debugging)</summary>
        <pre className="code-block">{JSON.stringify(run, null, 2)}</pre>
      </details>
    </DashboardShell>
  );
}
