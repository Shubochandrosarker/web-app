'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { archiveLocation, saveLocation, type LocationPayload } from '@/lib/actions';

export function LocationForm({
  locationId,
  initial,
  canWrite,
}: {
  readonly locationId: string | null;
  readonly initial: LocationPayload;
  readonly canWrite: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState<LocationPayload>(initial);
  const [message, setMessage] = useState('');
  const [pending, startTransition] = useTransition();

  const update = <K extends keyof LocationPayload>(key: K, next: LocationPayload[K]): void => {
    setValue((current) => ({ ...current, [key]: next }));
  };

  const save = (): void => {
    startTransition(async () => {
      const result = await saveLocation(locationId, value);
      setMessage(result.message ?? (result.ok ? 'Saved.' : 'Unable to save.'));
      if (result.ok && !locationId && result.id) router.push(`/local-seo/${result.id}`);
      if (result.ok && locationId) router.refresh();
    });
  };

  const archive = (): void => {
    if (!locationId || !window.confirm('Archive this location?')) return;
    startTransition(async () => {
      const result = await archiveLocation(locationId);
      setMessage(result.message ?? '');
      if (result.ok) router.push('/local-seo');
    });
  };

  return (
    <section className="panel">
      <div className="form-grid">
        <div className="field">
          <label htmlFor="location-display-name">Display name</label>
          <input
            id="location-display-name"
            value={value.displayName}
            disabled={!canWrite || pending}
            onChange={(event) => update('displayName', event.currentTarget.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="location-slug">Slug</label>
          <input
            id="location-slug"
            value={value.slug}
            disabled={!canWrite || pending}
            onChange={(event) => update('slug', event.currentTarget.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="location-legal-name">Legal name</label>
          <input
            id="location-legal-name"
            value={value.legalName}
            disabled={!canWrite || pending}
            onChange={(event) => update('legalName', event.currentTarget.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="location-country">Country code</label>
          <input
            id="location-country"
            maxLength={2}
            value={value.addressCountry}
            disabled={!canWrite || pending}
            onChange={(event) => update('addressCountry', event.currentTarget.value.toUpperCase())}
            required
          />
        </div>
        <div className="field field--wide">
          <label htmlFor="location-address">Street address</label>
          <input
            id="location-address"
            value={value.streetAddress}
            disabled={!canWrite || pending}
            onChange={(event) => update('streetAddress', event.currentTarget.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="location-city">City / locality</label>
          <input
            id="location-city"
            value={value.addressLocality}
            disabled={!canWrite || pending}
            onChange={(event) => update('addressLocality', event.currentTarget.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="location-region">Region</label>
          <input
            id="location-region"
            value={value.addressRegion ?? ''}
            disabled={!canWrite || pending}
            onChange={(event) => update('addressRegion', event.currentTarget.value || null)}
          />
        </div>
        <div className="field">
          <label htmlFor="location-phone">Telephone (E.164)</label>
          <input
            id="location-phone"
            value={value.telephone}
            disabled={!canWrite || pending}
            onChange={(event) => update('telephone', event.currentTarget.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="location-whatsapp">WhatsApp (E.164)</label>
          <input
            id="location-whatsapp"
            value={value.whatsapp ?? ''}
            disabled={!canWrite || pending}
            onChange={(event) => update('whatsapp', event.currentTarget.value || null)}
          />
        </div>
        <div className="field">
          <label htmlFor="location-email">Monitored email</label>
          <input
            id="location-email"
            type="email"
            value={value.email}
            disabled={!canWrite || pending}
            onChange={(event) => update('email', event.currentTarget.value)}
            required
          />
        </div>
        <div className="field field--wide">
          <label htmlFor="location-hours">Opening hours</label>
          <textarea
            id="location-hours"
            rows={3}
            value={value.openingHours.join('\n')}
            disabled={!canWrite || pending}
            onChange={(event) => update('openingHours', event.currentTarget.value.split('\n'))}
          />
        </div>
        <div className="field field--wide">
          <label htmlFor="location-same-as">Verified profiles (sameAs)</label>
          <textarea
            id="location-same-as"
            rows={3}
            value={value.sameAs.join('\n')}
            disabled={!canWrite || pending}
            onChange={(event) => update('sameAs', event.currentTarget.value.split('\n'))}
          />
        </div>
        <div className="field">
          <label htmlFor="location-latitude">Latitude</label>
          <input
            id="location-latitude"
            value={value.latitude ?? ''}
            disabled={!canWrite || pending}
            onChange={(event) => update('latitude', event.currentTarget.value || null)}
          />
        </div>
        <div className="field">
          <label htmlFor="location-longitude">Longitude</label>
          <input
            id="location-longitude"
            value={value.longitude ?? ''}
            disabled={!canWrite || pending}
            onChange={(event) => update('longitude', event.currentTarget.value || null)}
          />
        </div>
        <div className="field field--wide">
          <label htmlFor="location-gbp">Google Business Profile URL</label>
          <input
            id="location-gbp"
            type="url"
            value={value.googleBusinessProfileUrl ?? ''}
            disabled={!canWrite || pending}
            onChange={(event) =>
              update('googleBusinessProfileUrl', event.currentTarget.value || null)
            }
          />
        </div>
        <label className="checkbox-row field--wide">
          <input
            type="checkbox"
            checked={value.isPrimary}
            disabled={!canWrite || pending}
            onChange={(event) => update('isPrimary', event.currentTarget.checked)}
          />
          Primary location
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
            {pending ? 'Saving…' : 'Save location'}
          </button>
        ) : null}
        {locationId && canWrite ? (
          <button
            type="button"
            className="button button--danger"
            onClick={archive}
            disabled={pending}
          >
            Archive
          </button>
        ) : null}
      </div>
      <p className="muted" role="status">
        {message}
      </p>
    </section>
  );
}
