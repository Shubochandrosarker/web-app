'use client';

import { useState, useTransition } from 'react';

/**
 * Two-factor enrolment.
 *
 * The secret is shown once, as text, alongside the `otpauth://` URI. There is
 * no QR image: rendering one needs a client-side library on a page that
 * currently ships almost no JavaScript, and every authenticator app accepts a
 * typed secret. When the media pipeline lands, the URI can be turned into a QR
 * code server-side and the trade disappears.
 *
 * Recovery codes are displayed exactly once. The server stores only their
 * hashes, so there is no second chance to show them — which is stated on the
 * screen rather than discovered later.
 */
export function MfaPanel({ enabled }: { enabled: boolean }) {
  const [enrolment, setEnrolment] = useState<{ secret: string; uri: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const apiUrl = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/+$/, '');

  const begin = (): void => {
    setError(null);
    startTransition(async () => {
      const response = await fetch(`${apiUrl}/v1/auth/mfa/enrol`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) {
        setError('Could not start enrolment. Please try again.');
        return;
      }
      setEnrolment((await response.json()) as { secret: string; uri: string });
    });
  };

  const confirm = (formData: FormData): void => {
    setError(null);
    startTransition(async () => {
      const response = await fetch(`${apiUrl}/v1/auth/mfa/confirm`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: String(formData.get('code') ?? '') }),
      });

      if (!response.ok) {
        setError('That code was not accepted. Check your authenticator app and try again.');
        return;
      }

      const body = (await response.json()) as { recoveryCodes: string[] };
      setRecoveryCodes(body.recoveryCodes);
      setEnrolment(null);
    });
  };

  if (recoveryCodes) {
    return (
      <section className="panel">
        <h2>Two-factor authentication is on</h2>
        <p className="form-success" role="status">
          Save these recovery codes somewhere safe. Each one works once, and they are the only way
          back in if you lose your phone.
        </p>
        <ul className="recovery-codes">
          {recoveryCodes.map((code) => (
            <li key={code}>
              <code>{code}</code>
            </li>
          ))}
        </ul>
        <p className="muted">They will not be shown again — only their hashes are stored.</p>
      </section>
    );
  }

  if (enabled) {
    return (
      <section className="panel">
        <h2>Two-factor authentication</h2>
        <p className="form-success" role="status">
          Two-factor authentication is on for this account.
        </p>
        <p className="muted">
          To turn it off you will be asked for your password. Ask an administrator if you have lost
          access to your authenticator app and your recovery codes.
        </p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Two-factor authentication</h2>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {enrolment ? (
        <>
          <p>Add this secret to your authenticator app, then enter the code it shows.</p>
          <p className="secret-block">
            <code>{enrolment.secret}</code>
          </p>
          <p className="muted">
            Most apps also accept the full setup link: <code className="wrap">{enrolment.uri}</code>
          </p>

          <form action={confirm} className="inline-form">
            <label className="visually-hidden" htmlFor="mfa-code">
              Authentication code
            </label>
            <input
              id="mfa-code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={10}
              required
            />
            <button type="submit" className="button button--primary" disabled={pending}>
              {pending ? 'Checking…' : 'Confirm'}
            </button>
          </form>
        </>
      ) : (
        <>
          <p>
            An account that can read a student&rsquo;s documents should not be protected by a
            password alone.
          </p>
          <button
            type="button"
            className="button button--primary"
            onClick={begin}
            disabled={pending}
          >
            {pending ? 'Starting…' : 'Turn on two-factor authentication'}
          </button>
        </>
      )}
    </section>
  );
}
