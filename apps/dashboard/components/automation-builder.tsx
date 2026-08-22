'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { saveAutomation, type ActionResult } from '@/lib/actions';

/**
 * The automation builder.
 *
 * Everything here edits plain form controls — nobody is asked to write JSON.
 * The definition the API stores is assembled on save; validation failures
 * come back with the API's own explanation, which names the invariant rather
 * than the line number.
 *
 * Branch steps nest through recursion (`StepList` renders itself for the two
 * sides), which is also the natural cap on cleverness: the API refuses more
 * than five levels, and the indentation makes three levels already feel like
 * enough.
 */

export interface BuilderPredicate {
  path: string;
  comparator: string;
  value: string;
}

export interface BuilderCondition {
  match: 'all' | 'any';
  predicates: BuilderPredicate[];
}

export type BuilderStep =
  | {
      id: string;
      type: 'action';
      action: string;
      config: Record<string, string>;
      retry: { maxAttempts: number; backoffSeconds: number };
    }
  | { id: string; type: 'wait'; seconds: number }
  | {
      id: string;
      type: 'wait_for_event';
      event: string;
      correlateOn: string;
      timeoutSeconds: number;
    }
  | {
      id: string;
      type: 'branch';
      condition: BuilderCondition;
      then: BuilderStep[];
      otherwise: BuilderStep[];
    };

export interface BuilderDefinition {
  name: string;
  description: string;
  triggerKind: 'event' | 'schedule';
  triggerEvent: string;
  /** Five-field cron, used when triggerKind is 'schedule'. */
  triggerCron: string;
  condition: BuilderCondition | null;
  steps: BuilderStep[];
  reentry: 'once_per_contact' | 'once_per_entity' | 'always';
}

export interface PickerData {
  readonly templates: readonly { slug: string; name: string; body: string }[];
  readonly assignees: readonly { userId: string; fullName: string }[];
  readonly stages: readonly { id: string; name: string; pipelineName: string }[];
}

/**
 * Trigger events worth offering, with words a business owner uses. The raw
 * catalog has entries (email.bounced, indexing.failed) that only matter to
 * other machines; offering them all would make the picker read like a log
 * file.
 */
const TRIGGER_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'lead.created', label: 'A new enquiry arrives' },
  { value: 'form.submitted', label: 'A form is submitted' },
  { value: 'lead.stage_changed', label: 'An enquiry moves to another stage' },
  { value: 'lead.assigned', label: 'An enquiry is assigned to someone' },
  { value: 'lead.converted', label: 'An enquiry is won' },
  { value: 'lead.lost', label: 'An enquiry is lost' },
  { value: 'contact.created', label: 'A new contact is created' },
  { value: 'document.uploaded', label: 'A document is uploaded' },
  { value: 'document.verified', label: 'A document passes checks' },
  { value: 'task.completed', label: 'A task is completed' },
  { value: 'whatsapp.replied', label: 'The person replies on WhatsApp' },
  { value: 'appointment.created', label: 'An appointment is booked' },
  { value: 'appointment.reminder_due', label: 'An appointment reminder falls due' },
  { value: 'document.rejected', label: 'A document fails checks' },
  { value: 'task.overdue', label: 'A task goes overdue' },
  { value: 'order.created', label: 'An order is created' },
  { value: 'order.completed', label: 'An order is completed' },
  { value: 'order.cancelled', label: 'An order is cancelled' },
  { value: 'payment.completed', label: 'A payment is verified' },
  { value: 'review.requested', label: 'A review invitation falls due' },
  { value: 'review.received', label: 'A review arrives' },
];

const WAITABLE_EVENTS: readonly { value: string; label: string }[] = [
  { value: 'whatsapp.replied', label: 'the person replies on WhatsApp' },
  { value: 'document.uploaded', label: 'a document is uploaded' },
  { value: 'lead.stage_changed', label: 'the enquiry changes stage' },
  { value: 'task.completed', label: 'a task is completed' },
  { value: 'appointment.created', label: 'an appointment is booked' },
];

/** Only actions the engine executes today. A menu entry that would store a
 * step and then fail every run is not a feature. */
const ACTION_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'send_whatsapp', label: 'Send a WhatsApp template' },
  { value: 'send_email', label: 'Send an email' },
  { value: 'create_task', label: 'Create a task' },
  { value: 'assign_user', label: 'Assign the enquiry' },
  { value: 'update_lead', label: 'Update the enquiry' },
  { value: 'add_tag', label: 'Add a tag' },
  { value: 'remove_tag', label: 'Remove a tag' },
  { value: 'notify_admin', label: 'Notify the team by email' },
  { value: 'call_webhook', label: 'Call a webhook' },
];

const COMPARATOR_OPTIONS: readonly { value: string; label: string; needsValue: boolean }[] = [
  { value: 'equals', label: 'is', needsValue: true },
  { value: 'not_equals', label: 'is not', needsValue: true },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'not_contains', label: 'does not contain', needsValue: true },
  { value: 'starts_with', label: 'starts with', needsValue: true },
  { value: 'greater_than', label: 'is greater than', needsValue: true },
  { value: 'less_than', label: 'is less than', needsValue: true },
  { value: 'is_set', label: 'has a value', needsValue: false },
  { value: 'is_not_set', label: 'is empty', needsValue: false },
];

/** Context paths a condition can usefully test, offered as suggestions. */
const PATH_SUGGESTIONS = [
  'trigger.source',
  'trigger.serviceSlug',
  'trigger.formSlug',
  'contact.email',
  'contact.phone',
  'contact.whatsapp',
  'contact.locale',
  'lead.status',
  'lead.source',
];

export function newStep(type: BuilderStep['type']): BuilderStep {
  const id = crypto.randomUUID();
  switch (type) {
    case 'action':
      return {
        id,
        type,
        action: 'send_whatsapp',
        config: {},
        retry: { maxAttempts: 3, backoffSeconds: 60 },
      };
    case 'wait':
      return { id, type, seconds: 3600 };
    case 'wait_for_event':
      return {
        id,
        type,
        event: 'whatsapp.replied',
        correlateOn: 'contactId',
        timeoutSeconds: 24 * 3600,
      };
    case 'branch':
      return {
        id,
        type,
        condition: { match: 'all', predicates: [{ path: '', comparator: 'is_set', value: '' }] },
        then: [],
        otherwise: [],
      };
  }
}

/* ------------------------------------------------------------ duration UI */

function DurationInput({
  idPrefix,
  seconds,
  disabled,
  onChange,
}: {
  readonly idPrefix: string;
  readonly seconds: number;
  readonly disabled: boolean;
  readonly onChange: (seconds: number) => void;
}) {
  const unit = seconds % 86_400 === 0 ? 86_400 : seconds % 3_600 === 0 ? 3_600 : 60;
  const amount = Math.max(1, Math.round(seconds / unit));

  return (
    <div className="duration-input">
      <label htmlFor={`${idPrefix}-amount`} className="visually-hidden">
        Amount
      </label>
      <input
        id={`${idPrefix}-amount`}
        type="number"
        min={1}
        max={365}
        value={amount}
        disabled={disabled}
        onChange={(event) => {
          const next = Math.max(1, Number(event.currentTarget.value) || 1);
          onChange(next * unit);
        }}
      />
      <label htmlFor={`${idPrefix}-unit`} className="visually-hidden">
        Unit
      </label>
      <select
        id={`${idPrefix}-unit`}
        value={unit}
        disabled={disabled}
        onChange={(event) => onChange(amount * Number(event.currentTarget.value))}
      >
        <option value={60}>minutes</option>
        <option value={3600}>hours</option>
        <option value={86400}>days</option>
      </select>
    </div>
  );
}

/* ------------------------------------------------------------ conditions */

function ConditionEditor({
  idPrefix,
  condition,
  disabled,
  onChange,
}: {
  readonly idPrefix: string;
  readonly condition: BuilderCondition;
  readonly disabled: boolean;
  readonly onChange: (condition: BuilderCondition) => void;
}) {
  const updatePredicate = (index: number, patch: Partial<BuilderPredicate>): void => {
    onChange({
      ...condition,
      predicates: condition.predicates.map((predicate, position) =>
        position === index ? { ...predicate, ...patch } : predicate,
      ),
    });
  };

  return (
    <div className="condition-editor">
      <div className="field">
        <label htmlFor={`${idPrefix}-match`}>How to combine the checks</label>
        <select
          id={`${idPrefix}-match`}
          value={condition.match}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...condition, match: event.currentTarget.value as 'all' | 'any' })
          }
        >
          <option value="all">Every check must pass</option>
          <option value="any">Any one check is enough</option>
        </select>
      </div>

      {condition.predicates.map((predicate, index) => {
        const comparator = COMPARATOR_OPTIONS.find((entry) => entry.value === predicate.comparator);
        return (
          <div className="predicate-row" key={index}>
            <label htmlFor={`${idPrefix}-path-${index}`} className="visually-hidden">
              Field to check
            </label>
            <input
              id={`${idPrefix}-path-${index}`}
              list="automation-paths"
              placeholder="e.g. trigger.serviceSlug"
              value={predicate.path}
              maxLength={200}
              disabled={disabled}
              onChange={(event) => updatePredicate(index, { path: event.currentTarget.value })}
            />
            <label htmlFor={`${idPrefix}-cmp-${index}`} className="visually-hidden">
              Comparison
            </label>
            <select
              id={`${idPrefix}-cmp-${index}`}
              value={predicate.comparator}
              disabled={disabled}
              onChange={(event) =>
                updatePredicate(index, { comparator: event.currentTarget.value })
              }
            >
              {COMPARATOR_OPTIONS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
            {comparator?.needsValue !== false ? (
              <>
                <label htmlFor={`${idPrefix}-value-${index}`} className="visually-hidden">
                  Value
                </label>
                <input
                  id={`${idPrefix}-value-${index}`}
                  placeholder="value"
                  value={predicate.value}
                  maxLength={200}
                  disabled={disabled}
                  onChange={(event) => updatePredicate(index, { value: event.currentTarget.value })}
                />
              </>
            ) : null}
            {!disabled && condition.predicates.length > 1 ? (
              <button
                type="button"
                className="link-button link-button--danger"
                aria-label={`Remove check ${index + 1}`}
                onClick={() =>
                  onChange({
                    ...condition,
                    predicates: condition.predicates.filter((_, position) => position !== index),
                  })
                }
              >
                Remove
              </button>
            ) : null}
          </div>
        );
      })}

      {!disabled ? (
        <button
          type="button"
          className="link-button"
          onClick={() =>
            onChange({
              ...condition,
              predicates: [...condition.predicates, { path: '', comparator: 'is_set', value: '' }],
            })
          }
        >
          Add a check
        </button>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- step forms */

function ActionConfigForm({
  step,
  pickers,
  disabled,
  onConfig,
}: {
  readonly step: Extract<BuilderStep, { type: 'action' }>;
  readonly pickers: PickerData;
  readonly disabled: boolean;
  readonly onConfig: (patch: Record<string, string>) => void;
}) {
  const config = step.config;
  const set = (key: string) => (event: { currentTarget: { value: string } }) =>
    onConfig({ [key]: event.currentTarget.value });

  switch (step.action) {
    case 'send_whatsapp': {
      const template = pickers.templates.find((entry) => entry.slug === config.templateSlug);
      const variableCount = template
        ? Math.max(
            0,
            ...[...template.body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1])),
          )
        : 0;
      return (
        <>
          <div className="field">
            <label htmlFor={`cfg-${step.id}-template`}>Template</label>
            <select
              id={`cfg-${step.id}-template`}
              value={config.templateSlug ?? ''}
              disabled={disabled}
              onChange={set('templateSlug')}
            >
              <option value="">Choose a template…</option>
              {pickers.templates.map((entry) => (
                <option key={entry.slug} value={entry.slug}>
                  {entry.name}
                </option>
              ))}
            </select>
            {template ? <p className="field-help">{template.body}</p> : null}
            {pickers.templates.length === 0 ? (
              <p className="field-help">
                No WhatsApp templates exist yet — they are managed with your WhatsApp Business
                account.
              </p>
            ) : null}
          </div>
          {Array.from({ length: variableCount }, (_, index) => (
            <div className="field" key={index}>
              <label htmlFor={`cfg-${step.id}-var-${index}`}>{`Value for {{${index + 1}}}`}</label>
              <input
                id={`cfg-${step.id}-var-${index}`}
                value={config[`variable${index + 1}`] ?? ''}
                maxLength={500}
                disabled={disabled}
                placeholder="e.g. {{contact.fullName}}"
                onChange={set(`variable${index + 1}`)}
              />
            </div>
          ))}
          <p className="field-help">
            Values can use fields like <code>{'{{contact.fullName}}'}</code> — they are filled in
            per person when the message is sent.
          </p>
        </>
      );
    }

    case 'send_email':
    case 'notify_admin':
      return (
        <>
          <div className="field">
            <label htmlFor={`cfg-${step.id}-to`}>
              {step.action === 'notify_admin' ? 'Send to (team address)' : 'Send to'}
            </label>
            <input
              id={`cfg-${step.id}-to`}
              value={config.to ?? ''}
              maxLength={320}
              disabled={disabled}
              placeholder={
                step.action === 'notify_admin'
                  ? 'Defaults to the workspace sender address'
                  : "Leave empty to use the contact's email"
              }
              onChange={set('to')}
            />
          </div>
          <div className="field">
            <label htmlFor={`cfg-${step.id}-subject`}>Subject</label>
            <input
              id={`cfg-${step.id}-subject`}
              value={config.subject ?? ''}
              maxLength={300}
              disabled={disabled}
              onChange={set('subject')}
            />
          </div>
          <div className="field">
            <label htmlFor={`cfg-${step.id}-body`}>Message</label>
            <textarea
              id={`cfg-${step.id}-body`}
              rows={4}
              value={config.body ?? ''}
              maxLength={10_000}
              disabled={disabled}
              onChange={set('body')}
            />
            <p className="field-help">
              Fields like <code>{'{{contact.fullName}}'}</code> are filled in per person.
            </p>
          </div>
        </>
      );

    case 'create_task':
      return (
        <>
          <div className="field">
            <label htmlFor={`cfg-${step.id}-title`}>Task title</label>
            <input
              id={`cfg-${step.id}-title`}
              value={config.title ?? ''}
              maxLength={300}
              disabled={disabled}
              placeholder="e.g. Call {{contact.fullName}} back"
              onChange={set('title')}
            />
          </div>
          <div className="field">
            <label htmlFor={`cfg-${step.id}-due`}>Due within (hours)</label>
            <input
              id={`cfg-${step.id}-due`}
              type="number"
              min={0}
              max={720}
              value={config.dueInHours ?? ''}
              disabled={disabled}
              placeholder="No due date"
              onChange={set('dueInHours')}
            />
          </div>
          <div className="field">
            <label htmlFor={`cfg-${step.id}-assignee`}>Assign to</label>
            <select
              id={`cfg-${step.id}-assignee`}
              value={config.assignedToUserId ?? ''}
              disabled={disabled}
              onChange={set('assignedToUserId')}
            >
              <option value="">Whoever the enquiry is assigned to</option>
              {pickers.assignees.map((assignee) => (
                <option key={assignee.userId} value={assignee.userId}>
                  {assignee.fullName}
                </option>
              ))}
            </select>
          </div>
        </>
      );

    case 'assign_user':
      return (
        <div className="field">
          <label htmlFor={`cfg-${step.id}-user`}>Assign the enquiry to</label>
          <select
            id={`cfg-${step.id}-user`}
            value={config.userId ?? ''}
            disabled={disabled}
            onChange={set('userId')}
          >
            <option value="">Choose a person…</option>
            {pickers.assignees.map((assignee) => (
              <option key={assignee.userId} value={assignee.userId}>
                {assignee.fullName}
              </option>
            ))}
          </select>
        </div>
      );

    case 'update_lead':
      return (
        <>
          <div className="field">
            <label htmlFor={`cfg-${step.id}-stage`}>Move to stage</label>
            <select
              id={`cfg-${step.id}-stage`}
              value={config.stageId ?? ''}
              disabled={disabled}
              onChange={set('stageId')}
            >
              <option value="">Leave the stage as it is</option>
              {pickers.stages.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.pipelineName}: {stage.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`cfg-${step.id}-status`}>Set status</label>
            <select
              id={`cfg-${step.id}-status`}
              value={config.status ?? ''}
              disabled={disabled}
              onChange={set('status')}
            >
              <option value="">Leave the status as it is</option>
              <option value="open">Open</option>
              <option value="won">Won</option>
              <option value="lost">Lost</option>
              <option value="archived">Archived</option>
            </select>
          </div>
        </>
      );

    case 'add_tag':
    case 'remove_tag':
      return (
        <div className="field">
          <label htmlFor={`cfg-${step.id}-tag`}>Tag</label>
          <input
            id={`cfg-${step.id}-tag`}
            value={config.tag ?? ''}
            maxLength={140}
            disabled={disabled}
            placeholder="e.g. needs-follow-up"
            onChange={set('tag')}
          />
        </div>
      );

    case 'call_webhook':
      return (
        <>
          <div className="field">
            <label htmlFor={`cfg-${step.id}-url`}>Webhook URL (https only)</label>
            <input
              id={`cfg-${step.id}-url`}
              type="url"
              value={config.url ?? ''}
              maxLength={2048}
              disabled={disabled}
              placeholder="https://example.com/hooks/bos"
              onChange={set('url')}
            />
          </div>
          <div className="field">
            <label htmlFor={`cfg-${step.id}-secret`}>Signing secret (optional)</label>
            <input
              id={`cfg-${step.id}-secret`}
              value={config.secret ?? ''}
              maxLength={200}
              disabled={disabled}
              onChange={set('secret')}
            />
            <p className="field-help">
              When set, deliveries carry an <code>x-bos-signature</code> HMAC the receiver can
              verify.
            </p>
          </div>
        </>
      );

    default:
      return null;
  }
}

function stepSummary(step: BuilderStep, pickers: PickerData): string {
  switch (step.type) {
    case 'wait': {
      const days = step.seconds / 86_400;
      const hours = step.seconds / 3_600;
      if (Number.isInteger(days) && days > 0) return `Wait ${days} day${days === 1 ? '' : 's'}`;
      if (Number.isInteger(hours) && hours > 0)
        return `Wait ${hours} hour${hours === 1 ? '' : 's'}`;
      return `Wait ${Math.round(step.seconds / 60)} minutes`;
    }
    case 'wait_for_event': {
      const label =
        WAITABLE_EVENTS.find((entry) => entry.value === step.event)?.label ?? step.event;
      return `Wait until ${label}`;
    }
    case 'branch':
      return 'If…';
    case 'action': {
      const label =
        ACTION_OPTIONS.find((entry) => entry.value === step.action)?.label ?? step.action;
      if (step.action === 'send_whatsapp' && step.config.templateSlug) {
        const template = pickers.templates.find((entry) => entry.slug === step.config.templateSlug);
        return `${label}: ${template?.name ?? step.config.templateSlug}`;
      }
      if ((step.action === 'send_email' || step.action === 'notify_admin') && step.config.subject) {
        return `${label}: "${step.config.subject}"`;
      }
      if (step.action === 'create_task' && step.config.title) {
        return `${label}: "${step.config.title}"`;
      }
      if ((step.action === 'add_tag' || step.action === 'remove_tag') && step.config.tag) {
        return `${label}: ${step.config.tag}`;
      }
      return label;
    }
  }
}

function StepList({
  steps,
  depth,
  pickers,
  disabled,
  onChange,
}: {
  readonly steps: BuilderStep[];
  readonly depth: number;
  readonly pickers: PickerData;
  readonly disabled: boolean;
  readonly onChange: (steps: BuilderStep[]) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);

  const replace = (index: number, next: BuilderStep): void =>
    onChange(steps.map((step, position) => (position === index ? next : step)));

  const move = (index: number, direction: -1 | 1): void => {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(target, 0, moved);
    onChange(next);
  };

  const add = (type: BuilderStep['type']): void => {
    const step = newStep(type);
    onChange([...steps, step]);
    setOpen(step.id);
  };

  return (
    <div className={depth > 1 ? 'step-list step-list--nested' : 'step-list'}>
      {steps.length === 0 ? (
        <p className="muted">{depth > 1 ? 'Nothing yet.' : 'No steps yet — add the first one.'}</p>
      ) : (
        <ol className="section-editor">
          {steps.map((step, index) => (
            <li key={step.id} className="section-item">
              <header>
                <button
                  type="button"
                  className="section-title"
                  aria-expanded={open === step.id}
                  onClick={() => setOpen(open === step.id ? null : step.id)}
                >
                  <strong>
                    {index + 1}. {stepSummary(step, pickers)}
                  </strong>
                </button>
                {!disabled ? (
                  <span className="section-actions">
                    <button
                      type="button"
                      className="link-button"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                      aria-label={`Move step ${index + 1} up`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      disabled={index === steps.length - 1}
                      onClick={() => move(index, 1)}
                      aria-label={`Move step ${index + 1} down`}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="link-button link-button--danger"
                      onClick={() => onChange(steps.filter((_, position) => position !== index))}
                    >
                      Remove
                    </button>
                  </span>
                ) : null}
              </header>

              {open === step.id ? (
                <div className="section-form">
                  {step.type === 'action' ? (
                    <>
                      <div className="field">
                        <label htmlFor={`step-${step.id}-action`}>What to do</label>
                        <select
                          id={`step-${step.id}-action`}
                          value={step.action}
                          disabled={disabled}
                          onChange={(event) =>
                            replace(index, {
                              ...step,
                              action: event.currentTarget.value,
                              config: {},
                            })
                          }
                        >
                          {ACTION_OPTIONS.map((entry) => (
                            <option key={entry.value} value={entry.value}>
                              {entry.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <ActionConfigForm
                        step={step}
                        pickers={pickers}
                        disabled={disabled}
                        onConfig={(patch) =>
                          replace(index, { ...step, config: { ...step.config, ...patch } })
                        }
                      />
                    </>
                  ) : null}

                  {step.type === 'wait' ? (
                    <div className="field">
                      <label htmlFor={`step-${step.id}-amount`}>How long to wait</label>
                      <DurationInput
                        idPrefix={`step-${step.id}`}
                        seconds={step.seconds}
                        disabled={disabled}
                        onChange={(seconds) => replace(index, { ...step, seconds })}
                      />
                      <p className="field-help">
                        The wait survives restarts and deploys — it is stored, not a timer.
                      </p>
                    </div>
                  ) : null}

                  {step.type === 'wait_for_event' ? (
                    <>
                      <div className="field">
                        <label htmlFor={`step-${step.id}-event`}>Wait until</label>
                        <select
                          id={`step-${step.id}-event`}
                          value={step.event}
                          disabled={disabled}
                          onChange={(event) =>
                            replace(index, { ...step, event: event.currentTarget.value })
                          }
                        >
                          {WAITABLE_EVENTS.map((entry) => (
                            <option key={entry.value} value={entry.value}>
                              {entry.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label htmlFor={`step-${step.id}-timeout-amount`}>Give up after</label>
                        <DurationInput
                          idPrefix={`step-${step.id}-timeout`}
                          seconds={step.timeoutSeconds}
                          disabled={disabled}
                          onChange={(timeoutSeconds) => replace(index, { ...step, timeoutSeconds })}
                        />
                        <p className="field-help">
                          If it never happens, the automation continues after this long — a branch
                          can then check <code>timedOut</code> and take the other path.
                        </p>
                      </div>
                    </>
                  ) : null}

                  {step.type === 'branch' ? (
                    <>
                      <ConditionEditor
                        idPrefix={`branch-${step.id}`}
                        condition={step.condition}
                        disabled={disabled}
                        onChange={(condition) => replace(index, { ...step, condition })}
                      />
                      <fieldset className="branch-side">
                        <legend>If the checks pass</legend>
                        <StepList
                          steps={step.then}
                          depth={depth + 1}
                          pickers={pickers}
                          disabled={disabled}
                          onChange={(then) => replace(index, { ...step, then })}
                        />
                      </fieldset>
                      <fieldset className="branch-side">
                        <legend>Otherwise</legend>
                        <StepList
                          steps={step.otherwise}
                          depth={depth + 1}
                          pickers={pickers}
                          disabled={disabled}
                          onChange={(otherwise) => replace(index, { ...step, otherwise })}
                        />
                      </fieldset>
                    </>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      {!disabled && depth <= 5 ? (
        <div className="step-add">
          <button type="button" className="button" onClick={() => add('action')}>
            Add an action
          </button>
          <button type="button" className="button" onClick={() => add('wait')}>
            Add a wait
          </button>
          <button type="button" className="button" onClick={() => add('wait_for_event')}>
            Wait for a reply
          </button>
          {depth < 5 ? (
            <button type="button" className="button" onClick={() => add('branch')}>
              Add a branch
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- builder */

export function AutomationBuilder({
  automationId,
  initial,
  pickers,
  canWrite,
}: {
  readonly automationId: string | null;
  readonly initial: BuilderDefinition;
  readonly pickers: PickerData;
  readonly canWrite: boolean;
}) {
  const router = useRouter();
  const [definition, setDefinition] = useState<BuilderDefinition>(initial);
  const [result, setResult] = useState<ActionResult>({ ok: true });
  const [pending, startTransition] = useTransition();
  const disabled = !canWrite || pending;

  const update = (patch: Partial<BuilderDefinition>): void =>
    setDefinition((current) => ({ ...current, ...patch }));

  const save = (): void => {
    startTransition(async () => {
      const saved = await saveAutomation(automationId, definition);
      setResult(saved);
      if (saved.ok && !automationId && saved.id) router.push(`/automations/${saved.id}`);
      if (saved.ok && automationId) router.refresh();
    });
  };

  return (
    <div className="content-editor">
      {result.message ? (
        <p
          className={result.ok ? 'form-success' : 'form-error'}
          role={result.ok ? 'status' : 'alert'}
        >
          {result.message}
        </p>
      ) : null}

      <datalist id="automation-paths">
        {PATH_SUGGESTIONS.map((path) => (
          <option key={path} value={path} />
        ))}
      </datalist>

      <section className="panel">
        <h2>Automation</h2>
        <div className="field">
          <label htmlFor="automation-name">Name</label>
          <input
            id="automation-name"
            value={definition.name}
            maxLength={200}
            disabled={disabled}
            placeholder="e.g. Follow up on new enquiries"
            onChange={(event) => update({ name: event.currentTarget.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="automation-description">Description</label>
          <textarea
            id="automation-description"
            rows={2}
            value={definition.description}
            maxLength={1000}
            disabled={disabled}
            onChange={(event) => update({ description: event.currentTarget.value })}
          />
        </div>
      </section>

      <section className="panel">
        <h2>When</h2>
        <div className="field">
          <label htmlFor="automation-trigger-kind">Starts</label>
          <select
            id="automation-trigger-kind"
            value={definition.triggerKind}
            disabled={disabled}
            onChange={(event) =>
              update({ triggerKind: event.currentTarget.value as 'event' | 'schedule' })
            }
          >
            <option value="event">when something happens</option>
            <option value="schedule">on a schedule</option>
          </select>
        </div>
        {definition.triggerKind === 'event' ? (
          <div className="field">
            <label htmlFor="automation-trigger">Start when</label>
            <select
              id="automation-trigger"
              value={definition.triggerEvent}
              disabled={disabled}
              onChange={(event) => update({ triggerEvent: event.currentTarget.value })}
            >
              {TRIGGER_OPTIONS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="field">
            <label htmlFor="automation-cron">Schedule (five-field cron)</label>
            <input
              id="automation-cron"
              value={definition.triggerCron}
              disabled={disabled}
              onChange={(event) => update({ triggerCron: event.currentTarget.value })}
              placeholder="0 9 * * 1"
            />
            <p className="field-help">
              Minute, hour, day, month, weekday — in the workspace time zone. "0 9 * * 1" is every
              Monday at 09:00. Each matching minute starts one run.
            </p>
          </div>
        )}
        <div className="field">
          <label htmlFor="automation-reentry">The same person</label>
          <select
            id="automation-reentry"
            value={definition.reentry}
            disabled={disabled}
            onChange={(event) =>
              update({ reentry: event.currentTarget.value as BuilderDefinition['reentry'] })
            }
          >
            <option value="once_per_entity">enters once per enquiry</option>
            <option value="once_per_contact">enters only once, ever</option>
            <option value="always">enters every time it happens</option>
          </select>
          <p className="field-help">
            Stops a duplicate form submission from starting the sequence twice.
          </p>
        </div>
      </section>

      <section className="panel">
        <h2>Only if</h2>
        {definition.condition ? (
          <>
            <ConditionEditor
              idPrefix="entry"
              condition={definition.condition}
              disabled={disabled}
              onChange={(condition) => update({ condition })}
            />
            {!disabled ? (
              <button
                type="button"
                className="link-button link-button--danger"
                onClick={() => update({ condition: null })}
              >
                Remove the entry condition
              </button>
            ) : null}
          </>
        ) : (
          <>
            <p className="muted">Runs for every occurrence.</p>
            {!disabled ? (
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  update({
                    condition: {
                      match: 'all',
                      predicates: [{ path: '', comparator: 'is_set', value: '' }],
                    },
                  })
                }
              >
                Add an entry condition
              </button>
            ) : null}
          </>
        )}
      </section>

      <section className="panel">
        <h2>Steps</h2>
        <StepList
          steps={definition.steps}
          depth={1}
          pickers={pickers}
          disabled={disabled}
          onChange={(steps) => update({ steps })}
        />
      </section>

      {canWrite ? (
        <div className="editor-actions">
          <button
            type="button"
            className="button button--primary"
            disabled={pending || definition.steps.length === 0 || !definition.name}
            onClick={save}
          >
            {pending ? 'Saving…' : automationId ? 'Save changes' : 'Create automation'}
          </button>
          {automationId ? (
            <p className="field-help">
              Saving creates a new version. Sequences already in progress finish on the version they
              started with.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="muted">Your role can view this automation but not change it.</p>
      )}
    </div>
  );
}
