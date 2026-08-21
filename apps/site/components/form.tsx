'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ResolvedForm, ResolvedFormField } from '@bos/content';
import { readAttribution } from '@/lib/attribution';
import { Turnstile } from '@/components/turnstile';

/**
 * The service request form.
 *
 * The only client component on a public page, because it is the only thing
 * that needs state. Everything it renders exists in the server-rendered HTML
 * first: the fields, the labels, the submit button and the `action` are all
 * there before hydration, so the form is usable — and indexable — whether or
 * not the JavaScript arrives.
 *
 * The three anti-spam measures a browser has to participate in are here; the
 * ones that matter are on the server. This is a filter, not a gate.
 */

export interface ServiceRequestFormProps {
  readonly form: ResolvedForm;
  readonly workspaceSlug: string;
  readonly locale: string;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; message: string; reference: string }
  | { kind: 'error'; message: string; fieldErrors: Record<string, string> };

export function ServiceRequestForm({ form, workspaceSlug, locale }: ServiceRequestFormProps) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  // Incremented on every rejected submission: the server consumed the
  // Turnstile token, so the widget must mint a fresh one before a retry.
  const [turnstileReset, setTurnstileReset] = useState(0);
  const formId = useId();

  const turnstileSiteKey =
    form.turnstileSiteKey ?? process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? undefined;

  /*
   * When the form became visible to a person.
   *
   * A human takes seconds to read a form and fill it in; a bot posts in
   * milliseconds. Stamped in an effect rather than during render, because
   * `Date.now()` is impure and a render may happen more than once — and on the
   * server, where the clock has nothing to do with when the visitor arrived.
   *
   * Zero means "not yet stamped", and the submission simply omits the timing
   * signal rather than reporting a nonsensical one.
   */
  const renderedAt = useRef<number>(0);

  useEffect(() => {
    renderedAt.current = Date.now();
  }, []);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? '';

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (status.kind === 'submitting') return;

    setStatus({ kind: 'submitting' });

    const formData = new FormData(event.currentTarget);
    const values: Record<string, string | boolean> = {};

    for (const field of form.fields) {
      const raw = formData.get(field.name);
      if (field.type === 'checkbox') values[field.name] = raw === 'on';
      else if (typeof raw === 'string') values[field.name] = raw;
    }

    // The honeypot travels with the payload. The server decides what it means;
    // the browser's only job is to have rendered it.
    const honeypot = formData.get(form.honeypotField);
    if (typeof honeypot === 'string') values[form.honeypotField] = honeypot;

    const turnstileToken = formData.get('cf-turnstile-response');

    try {
      const response = await fetch(
        `${apiUrl}/v1/forms/${encodeURIComponent(form.slug)}/submissions?workspace=${encodeURIComponent(workspaceSlug)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            values,
            consent: formData.get('consent') === 'on',
            landingPath: window.location.pathname,
            locale,
            ...(renderedAt.current > 0 ? { elapsedMs: Date.now() - renderedAt.current } : {}),
            // Read from the first-party cookie the attribution helper wrote on
            // the first page of the visit — never from the current URL alone,
            // or every lead is attributed to the last page they happened to
            // land on.
            attribution: readAttribution(),
            ...(typeof turnstileToken === 'string' ? { turnstileToken } : {}),
          }),
        },
      );

      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
        reference?: string;
        error?: { message?: string; details?: { path: string; message: string }[] };
      };

      if (response.ok) {
        setStatus({
          kind: 'success',
          message: body.message ?? 'Thank you — we have your request.',
          reference: body.reference ?? '',
        });
        return;
      }

      const fieldErrors: Record<string, string> = {};
      for (const detail of body.error?.details ?? []) {
        fieldErrors[detail.path] = detail.message;
      }

      setTurnstileReset((count) => count + 1);
      setStatus({
        kind: 'error',
        message:
          body.error?.message ??
          'We could not send your request. Please check the form and try again.',
        fieldErrors,
      });
    } catch {
      // A network failure, not a rejection. Say something a person can act on
      // rather than "TypeError: Failed to fetch".
      setStatus({
        kind: 'error',
        message:
          'We could not reach our server. Please check your connection and try again, or call us.',
        fieldErrors: {},
      });
    }
  };

  if (status.kind === 'success') {
    return (
      // `role="status"` announces the confirmation to a screen reader without
      // stealing focus, which `role="alert"` would.
      <div className="form-success" role="status">
        <h3>Request received</h3>
        <p>{status.message}</p>
        {status.reference ? (
          <p className="card-meta">
            Your reference is <strong>{status.reference}</strong>.
          </p>
        ) : null}
      </div>
    );
  }

  const submitting = status.kind === 'submitting';
  const fieldErrors = status.kind === 'error' ? status.fieldErrors : {};

  return (
    <form
      className="lead-form"
      onSubmit={onSubmit}
      noValidate
      /*
       * A real action and method, so the markup describes a working form even
       * before hydration. The handler intercepts it when JavaScript is
       * available.
       */
      action={`${apiUrl}/v1/forms/${form.slug}/submissions?workspace=${workspaceSlug}`}
      method="post"
    >
      {status.kind === 'error' ? (
        <p className="form-error" role="alert">
          {status.message}
        </p>
      ) : null}

      {form.fields.map((field) => (
        <Field
          key={field.name}
          field={field}
          formId={formId}
          error={fieldErrors[field.name]}
          disabled={submitting}
        />
      ))}

      {/*
        The honeypot.
        `aria-hidden` and `tabIndex={-1}` keep it away from anybody using a
        screen reader or the keyboard; `autoComplete="off"` stops a browser
        helpfully filling it in and turning a real visitor into a false
        positive. It is positioned off-screen by CSS rather than
        `display: none`, because some bots skip hidden fields.
      */}
      <div className="honeypot" aria-hidden="true">
        <label htmlFor={`${formId}-${form.honeypotField}`}>
          Leave this field empty
          <input
            id={`${formId}-${form.honeypotField}`}
            type="text"
            name={form.honeypotField}
            tabIndex={-1}
            autoComplete="off"
          />
        </label>
      </div>

      {form.requiresConsent ? (
        <div className="field field--checkbox">
          <label htmlFor={`${formId}-consent`}>
            <input id={`${formId}-consent`} type="checkbox" name="consent" required />
            <span>
              {form.consentText ??
                'I agree to be contacted about this request by phone, WhatsApp or email.'}
            </span>
          </label>
        </div>
      ) : null}

      {turnstileSiteKey ? (
        <Turnstile siteKey={turnstileSiteKey} resetSignal={turnstileReset} />
      ) : null}

      <button type="submit" className="button button--primary" disabled={submitting}>
        {submitting ? 'Sending…' : form.submitLabel}
      </button>

      {/*
        Announced politely while the request is in flight, so a screen-reader
        user knows something is happening rather than pressing submit again.
      */}
      <p className="visually-hidden" role="status">
        {submitting ? 'Sending your request' : ''}
      </p>
    </form>
  );
}

function Field({
  field,
  formId,
  error,
  disabled,
}: {
  field: ResolvedFormField;
  formId: string;
  error: string | undefined;
  disabled: boolean;
}) {
  const id = `${formId}-${field.name}`;
  const describedBy = [field.helpText ? `${id}-help` : null, error ? `${id}-error` : null].filter(
    Boolean,
  );

  const shared = {
    id,
    name: field.name,
    required: field.required,
    disabled,
    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    ...(field.maxLength ? { maxLength: field.maxLength } : {}),
    ...(field.autocomplete ? { autoComplete: field.autocomplete } : {}),
    // `aria-invalid` plus `aria-describedby` is what makes an error message
    // reach somebody who cannot see the red text.
    ...(error ? { 'aria-invalid': true as const } : {}),
    ...(describedBy.length > 0 ? { 'aria-describedby': describedBy.join(' ') } : {}),
  };

  return (
    <div className={`field field--${field.type}`}>
      <label htmlFor={id}>
        {field.label}
        {field.required ? (
          <>
            {' '}
            <span className="required" aria-hidden="true">
              *
            </span>
            <span className="visually-hidden">(required)</span>
          </>
        ) : null}
      </label>

      {field.type === 'textarea' ? (
        <textarea {...shared} rows={5} />
      ) : field.type === 'select' ? (
        <select {...shared}>
          <option value="">Please choose…</option>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.type === 'checkbox' ? (
        <input {...shared} type="checkbox" />
      ) : (
        <input
          {...shared}
          type={
            field.type === 'email'
              ? 'email'
              : field.type === 'tel'
                ? 'tel'
                : field.type === 'number'
                  ? 'number'
                  : field.type === 'date'
                    ? 'date'
                    : 'text'
          }
          // `inputMode` is what puts a phone keypad in front of somebody on a
          // mobile, which is most of this audience.
          {...(field.type === 'tel' ? { inputMode: 'tel' as const } : {})}
        />
      )}

      {field.helpText ? (
        <p id={`${id}-help`} className="field-help">
          {field.helpText}
        </p>
      ) : null}

      {error ? (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
