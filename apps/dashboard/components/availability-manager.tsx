'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  createAvailabilityException,
  createAvailabilityRule,
  deleteAvailabilityException,
  deleteAvailabilityRule,
  type AvailabilityRulePayload,
} from '@/lib/actions';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function minutesLabel(minutes: number): string {
  const hour = String(Math.floor(minutes / 60)).padStart(2, '0');
  const minute = String(minutes % 60).padStart(2, '0');
  return `${hour}:${minute}`;
}

function toMinutes(value: string): number {
  const [hour = '0', minute = '0'] = value.split(':');
  return Number(hour) * 60 + Number(minute);
}

export interface RuleRow {
  readonly id: string;
  readonly staffProfileId: string | null;
  readonly weekday: number;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly slotMinutes: number;
  readonly capacity: number;
}

export interface ExceptionRow {
  readonly id: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly isAvailable: boolean;
  readonly reason: string | null;
}

export function AvailabilityManager({
  rules,
  exceptions,
  canWrite,
}: {
  readonly rules: readonly RuleRow[];
  readonly exceptions: readonly ExceptionRow[];
  readonly canWrite: boolean;
}) {
  const router = useRouter();
  const [message, setMessage] = useState('');
  const [pending, startTransition] = useTransition();

  const [draft, setDraft] = useState<AvailabilityRulePayload>({
    staffProfileId: null,
    locationId: null,
    serviceId: null,
    weekday: 1,
    startMinute: 9 * 60,
    endMinute: 17 * 60,
    slotMinutes: 30,
    capacity: 1,
  });

  const [blackout, setBlackout] = useState({ startsAt: '', endsAt: '', reason: '' });

  const addRule = (): void =>
    startTransition(async () => {
      const result = await createAvailabilityRule(draft);
      setMessage(result.message ?? '');
      if (result.ok) router.refresh();
    });

  const addBlackout = (): void =>
    startTransition(async () => {
      if (!blackout.startsAt || !blackout.endsAt) {
        setMessage('A blackout needs a start and an end.');
        return;
      }
      const result = await createAvailabilityException({
        startsAt: new Date(blackout.startsAt).toISOString(),
        endsAt: new Date(blackout.endsAt).toISOString(),
        isAvailable: false,
        reason: blackout.reason || null,
      });
      setMessage(result.message ?? '');
      if (result.ok) {
        setBlackout({ startsAt: '', endsAt: '', reason: '' });
        router.refresh();
      }
    });

  const removeRule = (id: string): void =>
    startTransition(async () => {
      const result = await deleteAvailabilityRule(id);
      setMessage(result.message ?? '');
      if (result.ok) router.refresh();
    });

  const removeException = (id: string): void =>
    startTransition(async () => {
      const result = await deleteAvailabilityException(id);
      setMessage(result.message ?? '');
      if (result.ok) router.refresh();
    });

  return (
    <>
      <section className="panel">
        <h2>Weekly hours</h2>
        <p className="muted">
          Bookings outside these windows are refused (managers can force an exception). No rules at
          all means booking is unconstrained.
        </p>
        {rules.length === 0 ? (
          <p className="muted">No rules configured.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <caption className="visually-hidden">Availability rules</caption>
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col">Window</th>
                  <th scope="col">Slot</th>
                  <th scope="col">Capacity</th>
                  <th scope="col">Scope</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <th scope="row">{WEEKDAYS[rule.weekday]}</th>
                    <td>
                      {minutesLabel(rule.startMinute)}–{minutesLabel(rule.endMinute)}
                    </td>
                    <td>{rule.slotMinutes} min</td>
                    <td>{rule.capacity}</td>
                    <td>{rule.staffProfileId ? 'One staff member' : 'Whole business'}</td>
                    <td>
                      {canWrite ? (
                        <button
                          type="button"
                          className="button"
                          disabled={pending}
                          onClick={() => removeRule(rule.id)}
                        >
                          Remove
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canWrite ? (
          <div className="form-grid">
            <div className="field">
              <label htmlFor="rule-weekday">Day</label>
              <select
                id="rule-weekday"
                value={draft.weekday}
                disabled={pending}
                onChange={(event) =>
                  setDraft({ ...draft, weekday: Number(event.currentTarget.value) })
                }
              >
                {WEEKDAYS.map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="rule-start">Opens</label>
              <input
                id="rule-start"
                type="time"
                value={minutesLabel(draft.startMinute)}
                disabled={pending}
                onChange={(event) =>
                  setDraft({ ...draft, startMinute: toMinutes(event.currentTarget.value) })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="rule-end">Closes</label>
              <input
                id="rule-end"
                type="time"
                value={minutesLabel(draft.endMinute)}
                disabled={pending}
                onChange={(event) =>
                  setDraft({ ...draft, endMinute: toMinutes(event.currentTarget.value) })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="rule-slot">Slot minutes</label>
              <input
                id="rule-slot"
                type="number"
                min={5}
                max={480}
                value={draft.slotMinutes}
                disabled={pending}
                onChange={(event) =>
                  setDraft({ ...draft, slotMinutes: Number(event.currentTarget.value) || 30 })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="rule-capacity">Capacity per slot</label>
              <input
                id="rule-capacity"
                type="number"
                min={1}
                max={500}
                value={draft.capacity}
                disabled={pending}
                onChange={(event) =>
                  setDraft({ ...draft, capacity: Number(event.currentTarget.value) || 1 })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="rule-staff">Staff profile ID (optional)</label>
              <input
                id="rule-staff"
                value={draft.staffProfileId ?? ''}
                disabled={pending}
                onChange={(event) =>
                  setDraft({ ...draft, staffProfileId: event.currentTarget.value || null })
                }
              />
            </div>
          </div>
        ) : null}
        {canWrite ? (
          <button
            type="button"
            className="button button--primary"
            disabled={pending}
            onClick={addRule}
          >
            {pending ? 'Saving…' : 'Add rule'}
          </button>
        ) : null}
      </section>

      <section className="panel">
        <h2>Blackouts and exceptions</h2>
        <p className="muted">Holidays, leave and one-off closures. Exceptions beat rules.</p>
        {exceptions.length === 0 ? (
          <p className="muted">No exceptions.</p>
        ) : (
          <ul>
            {exceptions.map((exception) => (
              <li key={exception.id}>
                {new Date(exception.startsAt).toLocaleString()} –{' '}
                {new Date(exception.endsAt).toLocaleString()} ·{' '}
                {exception.isAvailable ? 'extra hours' : 'blocked'}
                {exception.reason ? ` · ${exception.reason}` : ''}{' '}
                {canWrite ? (
                  <button
                    type="button"
                    className="button"
                    disabled={pending}
                    onClick={() => removeException(exception.id)}
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canWrite ? (
          <div className="form-grid">
            <div className="field">
              <label htmlFor="blackout-start">From</label>
              <input
                id="blackout-start"
                type="datetime-local"
                value={blackout.startsAt}
                disabled={pending}
                onChange={(event) =>
                  setBlackout({ ...blackout, startsAt: event.currentTarget.value })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="blackout-end">To</label>
              <input
                id="blackout-end"
                type="datetime-local"
                value={blackout.endsAt}
                disabled={pending}
                onChange={(event) =>
                  setBlackout({ ...blackout, endsAt: event.currentTarget.value })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="blackout-reason">Reason</label>
              <input
                id="blackout-reason"
                value={blackout.reason}
                disabled={pending}
                onChange={(event) =>
                  setBlackout({ ...blackout, reason: event.currentTarget.value })
                }
              />
            </div>
          </div>
        ) : null}
        {canWrite ? (
          <button type="button" className="button" disabled={pending} onClick={addBlackout}>
            Add blackout
          </button>
        ) : null}
      </section>

      <p className="muted" role="status">
        {message}
      </p>
    </>
  );
}
