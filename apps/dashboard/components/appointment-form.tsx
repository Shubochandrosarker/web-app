'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { saveAppointment, type AppointmentPayload } from '@/lib/actions';

export function AppointmentForm({
  appointmentId,
  initial,
  canWrite,
}: {
  readonly appointmentId: string | null;
  readonly initial: AppointmentPayload;
  readonly canWrite: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState<AppointmentPayload>(initial);
  const [message, setMessage] = useState('');
  const [pending, startTransition] = useTransition();
  const update = <K extends keyof AppointmentPayload>(key: K, next: AppointmentPayload[K]): void =>
    setValue((current) => ({ ...current, [key]: next }));
  const save = (): void =>
    startTransition(async () => {
      const result = await saveAppointment(appointmentId, value);
      setMessage(result.message ?? (result.ok ? 'Saved.' : 'Unable to save.'));
      if (result.ok && !appointmentId && result.id) router.push(`/appointments/${result.id}`);
      if (result.ok && appointmentId) router.refresh();
    });

  return (
    <section className="panel">
      <div className="form-grid">
        <div className="field field--wide">
          <label htmlFor="appointment-contact">Contact ID</label>
          <input
            id="appointment-contact"
            value={value.contactId}
            disabled={!canWrite || pending}
            onChange={(event) => update('contactId', event.currentTarget.value)}
            placeholder="UUID from Contacts"
            required
          />
          <small className="muted">Choose the contact record before creating a booking.</small>
        </div>
        <div className="field">
          <label htmlFor="appointment-service">Service ID</label>
          <input
            id="appointment-service"
            value={value.serviceId ?? ''}
            disabled={!canWrite || pending}
            onChange={(event) => update('serviceId', event.currentTarget.value || null)}
          />
        </div>
        <div className="field">
          <label htmlFor="appointment-location">Location ID</label>
          <input
            id="appointment-location"
            value={value.locationId ?? ''}
            disabled={!canWrite || pending}
            onChange={(event) => update('locationId', event.currentTarget.value || null)}
          />
        </div>
        <div className="field">
          <label htmlFor="appointment-start">Starts at</label>
          <input
            id="appointment-start"
            type="datetime-local"
            value={value.startsAt}
            disabled={!canWrite || pending}
            onChange={(event) => update('startsAt', event.currentTarget.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="appointment-end">Ends at</label>
          <input
            id="appointment-end"
            type="datetime-local"
            value={value.endsAt}
            disabled={!canWrite || pending}
            onChange={(event) => update('endsAt', event.currentTarget.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="appointment-timezone">Time zone</label>
          <input
            id="appointment-timezone"
            value={value.timeZone}
            disabled={!canWrite || pending}
            onChange={(event) => update('timeZone', event.currentTarget.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="appointment-channel">Channel</label>
          <select
            id="appointment-channel"
            value={value.channel}
            disabled={!canWrite || pending}
            onChange={(event) =>
              update('channel', event.currentTarget.value as AppointmentPayload['channel'])
            }
          >
            <option value="on_site">On site</option>
            <option value="phone">Phone</option>
            <option value="video">Video</option>
            <option value="whatsapp">WhatsApp</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="appointment-status">Status</label>
          <select
            id="appointment-status"
            value={value.status ?? 'pending'}
            disabled={!canWrite || pending}
            onChange={(event) =>
              update(
                'status',
                event.currentTarget.value as NonNullable<AppointmentPayload['status']>,
              )
            }
          >
            <option value="pending">Pending</option>
            <option value="confirmed">Confirmed</option>
            <option value="completed">Completed</option>
            <option value="no_show">No show</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <div className="field field--wide">
          <label htmlFor="appointment-notes">Notes</label>
          <textarea
            id="appointment-notes"
            rows={4}
            value={value.notes ?? ''}
            disabled={!canWrite || pending}
            onChange={(event) => update('notes', event.currentTarget.value || null)}
          />
        </div>
      </div>
      {canWrite ? (
        <button type="button" className="button button--primary" onClick={save} disabled={pending}>
          {pending ? 'Saving…' : 'Save appointment'}
        </button>
      ) : null}
      <p className="muted" role="status">
        {message}
      </p>
    </section>
  );
}
