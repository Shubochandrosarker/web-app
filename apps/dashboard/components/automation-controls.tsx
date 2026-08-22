'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  deleteAutomation,
  retryAutomationRun,
  setAutomationEnabled,
  type ActionResult,
} from '@/lib/actions';

/**
 * The on/off switch, delete, and per-run retry — the parts of the automation
 * screens that mutate.
 *
 * The switch is deliberately explicit about what "on" means: from the moment
 * it is on, real events start real sequences to real people. Nothing here
 * auto-enables.
 */

export function AutomationControls({
  automationId,
  enabled,
  canWrite,
}: {
  readonly automationId: string;
  readonly enabled: boolean;
  readonly canWrite: boolean;
}) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  if (!canWrite) {
    return (
      <span className={enabled ? 'badge badge--won' : 'badge badge--muted'}>
        {enabled ? 'On' : 'Off'}
      </span>
    );
  }

  return (
    <div className="automation-controls">
      {result?.message && !result.ok ? (
        <p className="form-error" role="alert">
          {result.message}
        </p>
      ) : null}
      <button
        type="button"
        className={enabled ? 'button' : 'button button--primary'}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const outcome = await setAutomationEnabled(automationId, !enabled);
            setResult(outcome);
            if (outcome.ok) router.refresh();
          })
        }
      >
        {pending ? 'Working…' : enabled ? 'Turn off' : 'Turn on'}
      </button>
      <button
        type="button"
        className="button button--danger"
        disabled={pending}
        onClick={() => {
          if (!window.confirm('Delete this automation? Its run history stays readable.')) return;
          startTransition(async () => {
            const outcome = await deleteAutomation(automationId);
            setResult(outcome);
            if (outcome.ok) router.push('/automations');
          });
        }}
      >
        Delete
      </button>
    </div>
  );
}

export function RetryRunButton({
  automationId,
  runId,
}: {
  readonly automationId: string;
  readonly runId: string;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <>
      <button
        type="button"
        className="link-button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const outcome = await retryAutomationRun(automationId, runId);
            setMessage(outcome.ok ? null : (outcome.message ?? 'Retry failed.'));
            if (outcome.ok) router.refresh();
          })
        }
      >
        {pending ? 'Retrying…' : 'Retry'}
      </button>
      {message ? (
        <span className="field-error" role="alert">
          {message}
        </span>
      ) : null}
    </>
  );
}
