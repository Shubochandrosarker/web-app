import { notFound, redirect } from 'next/navigation';
import { apiFetch, ApiRequestError, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { RelativeTime } from '@/components/relative-time';
import {
  AutomationBuilder,
  type BuilderCondition,
  type BuilderDefinition,
  type BuilderStep,
  type PickerData,
} from '@/components/automation-builder';
import { AutomationControls, RetryRunButton } from '@/components/automation-controls';

export const dynamic = 'force-dynamic';

/**
 * One automation: the builder on top, the run history underneath. The two
 * belong on one screen because the question after every edit is "what did it
 * actually do" — and a failed run's retry button should be one scroll away
 * from the step that caused it.
 */

interface ApiPredicate {
  path: string;
  comparator: string;
  value?: string | number | boolean | (string | number)[];
}

interface ApiCondition {
  match: 'all' | 'any';
  predicates: ApiPredicate[];
}

interface ApiStep {
  id: string;
  type: 'action' | 'wait' | 'wait_for_event' | 'branch';
  action?: string;
  config?: Record<string, unknown>;
  retry?: { maxAttempts: number; backoffSeconds: number };
  seconds?: number;
  event?: string;
  correlateOn?: string;
  timeoutSeconds?: number;
  condition?: ApiCondition;
  then?: ApiStep[];
  otherwise?: ApiStep[];
}

interface AutomationDetail {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly enabled: boolean;
  readonly currentVersion: number;
  readonly definition: {
    name: string;
    description?: string;
    trigger: { kind: string; event?: string };
    condition?: ApiCondition;
    steps: ApiStep[];
    reentry: 'once_per_contact' | 'once_per_entity' | 'always';
  } | null;
}

interface RunRow {
  readonly id: string;
  readonly status: string;
  readonly contactName: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly resumeAt: string | null;
  readonly waitingForEvent: string | null;
  readonly failureReason: string | null;
}

function toBuilderCondition(condition: ApiCondition): BuilderCondition {
  return {
    match: condition.match,
    predicates: condition.predicates.map((predicate) => ({
      path: predicate.path,
      comparator: predicate.comparator,
      value: Array.isArray(predicate.value)
        ? predicate.value.join(', ')
        : String(predicate.value ?? ''),
    })),
  };
}

/** The stored definition, translated back into the builder's editable shape. */
function toBuilderSteps(steps: readonly ApiStep[]): BuilderStep[] {
  return steps.map((step): BuilderStep => {
    switch (step.type) {
      case 'wait':
        return { id: step.id, type: 'wait', seconds: step.seconds ?? 3600 };
      case 'wait_for_event':
        return {
          id: step.id,
          type: 'wait_for_event',
          event: step.event ?? 'whatsapp.replied',
          correlateOn: step.correlateOn ?? 'contactId',
          timeoutSeconds: step.timeoutSeconds ?? 86_400,
        };
      case 'branch':
        return {
          id: step.id,
          type: 'branch',
          condition: step.condition
            ? toBuilderCondition(step.condition)
            : { match: 'all', predicates: [{ path: '', comparator: 'is_set', value: '' }] },
          then: toBuilderSteps(step.then ?? []),
          otherwise: toBuilderSteps(step.otherwise ?? []),
        };
      case 'action': {
        const raw = step.config ?? {};
        const config: Record<string, string> = {};
        for (const [key, value] of Object.entries(raw)) {
          if (key === 'variables' && Array.isArray(value)) {
            value.forEach((variable, index) => {
              config[`variable${index + 1}`] = String(variable);
            });
          } else if (value !== null && value !== undefined) {
            config[key] = String(value);
          }
        }
        return {
          id: step.id,
          type: 'action',
          action: step.action ?? 'send_whatsapp',
          config,
          retry: step.retry ?? { maxAttempts: 3, backoffSeconds: 60 },
        };
      }
    }
  });
}

const STATUS_BADGE: Record<string, string> = {
  running: 'open',
  waiting: 'scheduled',
  completed: 'won',
  failed: 'lost',
  cancelled: 'muted',
};

export default async function AutomationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const { id } = await params;
  const isNew = id === 'new';
  const canWrite = can(session, 'automations.write');

  let initial: BuilderDefinition = {
    name: '',
    description: '',
    triggerEvent: 'lead.created',
    condition: null,
    steps: [],
    reentry: 'once_per_entity',
  };
  let detail: AutomationDetail | null = null;
  let runs: RunRow[] = [];

  if (!isNew) {
    try {
      detail = await apiFetch<AutomationDetail>(`/v1/automations/${id}`);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) notFound();
      throw error;
    }
    if (detail.definition) {
      initial = {
        name: detail.definition.name,
        description: detail.definition.description ?? '',
        triggerEvent: detail.definition.trigger.event ?? 'lead.created',
        condition: detail.definition.condition
          ? toBuilderCondition(detail.definition.condition)
          : null,
        steps: toBuilderSteps(detail.definition.steps),
        reentry: detail.definition.reentry,
      };
    } else {
      initial = { ...initial, name: detail.name, description: detail.description ?? '' };
    }

    runs = await apiFetch<{ items: RunRow[] }>(`/v1/automations/${id}/runs`)
      .then((response) => response.items)
      .catch(() => []);
  }

  const [templates, assignees, pipelines] = await Promise.all([
    apiFetch<{ items: { slug: string; name: string; body: string }[] }>(
      '/v1/crm/message-templates?channel=whatsapp',
    ).catch(() => ({ items: [] })),
    apiFetch<{ assignees: { userId: string; fullName: string }[] }>('/v1/crm/assignees').catch(
      () => ({ assignees: [] }),
    ),
    apiFetch<{ pipelines: { name: string; stages: { id: string; name: string }[] }[] }>(
      '/v1/crm/pipelines',
    ).catch(() => ({ pipelines: [] })),
  ]);

  const pickers: PickerData = {
    templates: templates.items,
    assignees: assignees.assignees,
    stages: pipelines.pipelines.flatMap((pipeline) =>
      pipeline.stages.map((stage) => ({
        id: stage.id,
        name: stage.name,
        pipelineName: pipeline.name,
      })),
    ),
  };

  return (
    <DashboardShell session={session} businessType="education_service" current="/automations">
      <div className="page-header">
        <div>
          <p className="breadcrumb">
            <a href="/automations">Automations</a>
          </p>
          <h1>{isNew ? 'New automation' : (detail?.name ?? 'Automation')}</h1>
          {detail ? (
            <p className="muted">
              Version {detail.currentVersion}
              {detail.enabled
                ? ' · running for new events'
                : ' · off — nothing new enrolls until it is turned on'}
            </p>
          ) : null}
        </div>
        {detail ? (
          <AutomationControls
            automationId={detail.id}
            enabled={detail.enabled}
            canWrite={canWrite}
          />
        ) : null}
      </div>

      <AutomationBuilder
        automationId={isNew ? null : id}
        initial={initial}
        pickers={pickers}
        canWrite={canWrite}
      />

      {!isNew ? (
        <section className="panel" aria-labelledby="runs-heading">
          <h2 id="runs-heading">Run history</h2>
          {runs.length === 0 ? (
            <p className="muted">
              No runs yet. Runs appear when the trigger fires while the automation is on.
            </p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <caption className="visually-hidden">Automation runs</caption>
                <thead>
                  <tr>
                    <th scope="col">Started</th>
                    <th scope="col">Who</th>
                    <th scope="col">Status</th>
                    <th scope="col">Detail</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id}>
                      <td>
                        <RelativeTime iso={run.startedAt} />
                      </td>
                      <td>{run.contactName ?? '—'}</td>
                      <td>
                        <span className={`badge badge--${STATUS_BADGE[run.status] ?? 'muted'}`}>
                          {run.status}
                        </span>
                      </td>
                      <td>
                        {run.status === 'failed' && run.failureReason ? (
                          <span className="field-error">{run.failureReason}</span>
                        ) : run.status === 'waiting' ? (
                          <span className="muted">
                            {run.waitingForEvent
                              ? `waiting for ${run.waitingForEvent}`
                              : run.resumeAt
                                ? 'sleeping'
                                : 'waiting'}
                          </span>
                        ) : run.completedAt ? (
                          <RelativeTime iso={run.completedAt} />
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <a className="link-button" href={`/automations/${id}/runs/${run.id}`}>
                          Steps
                        </a>{' '}
                        {run.status === 'failed' && canWrite ? (
                          <RetryRunButton automationId={id} runId={run.id} />
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </DashboardShell>
  );
}
