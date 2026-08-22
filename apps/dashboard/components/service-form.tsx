'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { archiveService, duplicateService, saveService, type ServicePayload } from '@/lib/actions';

export function ServiceForm({
  serviceId,
  initial,
  canWrite,
}: {
  readonly serviceId: string | null;
  readonly initial: ServicePayload;
  readonly canWrite: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState<ServicePayload>(initial);
  const [message, setMessage] = useState('');
  const [pending, startTransition] = useTransition();

  const update = <K extends keyof ServicePayload>(key: K, next: ServicePayload[K]): void => {
    setValue((current) => ({ ...current, [key]: next }));
  };

  const save = (): void => {
    startTransition(async () => {
      const result = await saveService(serviceId, value);
      setMessage(result.message ?? (result.ok ? 'Saved.' : 'Unable to save.'));
      if (result.ok && !serviceId && result.id) router.push(`/services/${result.id}`);
      if (result.ok && serviceId) router.refresh();
    });
  };

  const archive = (): void => {
    if (
      !serviceId ||
      !window.confirm('Archive this service? It will stay in history but stop being offered.')
    )
      return;
    startTransition(async () => {
      const result = await archiveService(serviceId);
      setMessage(result.message ?? '');
      if (result.ok) router.refresh();
    });
  };

  const duplicate = (): void => {
    if (!serviceId) return;
    startTransition(async () => {
      const result = await duplicateService(serviceId);
      setMessage(result.message ?? '');
      if (result.ok && result.id) router.push(`/services/${result.id}`);
    });
  };

  return (
    <section className="panel">
      <div className="form-grid">
        <div className="field">
          <label htmlFor="service-name">Name</label>
          <input
            id="service-name"
            value={value.name}
            disabled={!canWrite || pending}
            onChange={(event) => update('name', event.currentTarget.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="service-slug">Slug</label>
          <input
            id="service-slug"
            value={value.slug}
            disabled={!canWrite || pending}
            onChange={(event) => update('slug', event.currentTarget.value)}
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            required
          />
          <small className="muted">Used in the public service URL.</small>
        </div>
        <div className="field field--wide">
          <label htmlFor="service-summary">Summary</label>
          <textarea
            id="service-summary"
            rows={3}
            value={value.summary ?? ''}
            disabled={!canWrite || pending}
            onChange={(event) => update('summary', event.currentTarget.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="service-status">Status</label>
          <select
            id="service-status"
            value={value.status}
            disabled={!canWrite || pending}
            onChange={(event) =>
              update('status', event.currentTarget.value as ServicePayload['status'])
            }
          >
            <option value="draft">Draft</option>
            <option value="scheduled">Scheduled</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="service-price">Price (minor units)</label>
          <input
            id="service-price"
            type="number"
            min="0"
            value={value.priceAmount ?? ''}
            disabled={!canWrite || pending}
            onChange={(event) =>
              update(
                'priceAmount',
                event.currentTarget.value ? Number(event.currentTarget.value) : null,
              )
            }
          />
          <small className="muted">Leave blank for on-request pricing.</small>
        </div>
        <div className="field">
          <label htmlFor="service-currency">Currency</label>
          <input
            id="service-currency"
            maxLength={3}
            value={value.priceCurrency ?? ''}
            disabled={!canWrite || pending}
            onChange={(event) =>
              update('priceCurrency', event.currentTarget.value.toUpperCase() || null)
            }
          />
        </div>
        <div className="field">
          <label htmlFor="service-duration">Duration (minutes)</label>
          <input
            id="service-duration"
            type="number"
            min="1"
            value={value.durationMinutes ?? ''}
            disabled={!canWrite || pending}
            onChange={(event) =>
              update(
                'durationMinutes',
                event.currentTarget.value ? Number(event.currentTarget.value) : null,
              )
            }
          />
        </div>
        <div className="field field--wide">
          <label htmlFor="service-requirements">Requirements</label>
          <textarea
            id="service-requirements"
            rows={5}
            value={value.requirements.join('\n')}
            disabled={!canWrite || pending}
            onChange={(event) => update('requirements', event.currentTarget.value.split('\n'))}
          />
          <small className="muted">One requirement per line.</small>
        </div>
        <label className="checkbox-row field--wide">
          <input
            type="checkbox"
            checked={value.bookable}
            disabled={!canWrite || pending}
            onChange={(event) => update('bookable', event.currentTarget.checked)}
          />
          Available for booking
        </label>
      </div>

      <div className="page-actions">
        {canWrite ? (
          <button
            type="button"
            className="button button--primary"
            onClick={save}
            disabled={pending}
          >
            {pending ? 'Saving…' : 'Save service'}
          </button>
        ) : null}
        {serviceId && canWrite ? (
          <>
            <button type="button" className="button" onClick={duplicate} disabled={pending}>
              Duplicate
            </button>
            <button
              type="button"
              className="button button--danger"
              onClick={archive}
              disabled={pending}
            >
              Archive
            </button>
          </>
        ) : null}
      </div>
      <p className="muted" role="status">
        {message}
      </p>
    </section>
  );
}
