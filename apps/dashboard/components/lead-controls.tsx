'use client';

import { useTransition } from 'react';
import { updateLead } from '@/lib/actions';
import type { Pipeline } from '@/app/leads/page';

/**
 * Stage, status and assignment.
 *
 * Each select submits on change through a Server Action — the move a person
 * makes forty times a day should not also require finding a save button. The
 * transition state is what stops a second change being submitted while the
 * first is still in flight.
 */
export function LeadControls({
  leadId,
  pipeline,
  currentStageId,
  currentStatus,
  currentAssignee,
  assignees,
  canAssign,
}: {
  leadId: string;
  pipeline: Pipeline;
  currentStageId: string | null;
  currentStatus: string;
  currentAssignee: string | null;
  assignees: readonly { userId: string; fullName: string; role: string }[];
  canAssign: boolean;
}) {
  const [pending, startTransition] = useTransition();

  const submit = (field: string, value: string): void => {
    const formData = new FormData();
    formData.set(field, value);
    startTransition(async () => {
      await updateLead(leadId, formData);
    });
  };

  const stages = [...pipeline.stages].sort((a, b) => a.position - b.position);

  return (
    <section className="panel">
      <h2>Progress</h2>

      <div className="control-row">
        <div className="field">
          <label htmlFor="stage">Stage</label>
          <select
            id="stage"
            defaultValue={currentStageId ?? ''}
            disabled={pending}
            onChange={(event) => submit('stageId', event.currentTarget.value)}
          >
            <option value="" disabled>
              Choose a stage
            </option>
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="status">Status</label>
          <select
            id="status"
            defaultValue={currentStatus}
            disabled={pending}
            onChange={(event) => submit('status', event.currentTarget.value)}
          >
            <option value="open">Open</option>
            <option value="won">Won</option>
            <option value="lost">Lost</option>
            <option value="archived">Archived</option>
          </select>
        </div>

        {canAssign ? (
          <div className="field">
            <label htmlFor="assignee">Assigned to</label>
            <select
              id="assignee"
              defaultValue={currentAssignee ?? ''}
              disabled={pending}
              onChange={(event) => submit('assignedToUserId', event.currentTarget.value)}
            >
              <option value="">Nobody</option>
              {assignees.map((assignee) => (
                <option key={assignee.userId} value={assignee.userId}>
                  {assignee.fullName}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {/* Announced politely rather than as an alert: it is progress, not a problem. */}
      <p className="muted" role="status">
        {pending ? 'Saving…' : ''}
      </p>
    </section>
  );
}
