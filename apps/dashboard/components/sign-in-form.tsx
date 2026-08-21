'use client';

import { useActionState } from 'react';
import { requestPasswordReset, signIn, verifyMfa, type ActionResult } from '@/lib/actions';

/**
 * Sign-in, in three states: credentials, second factor, forgotten password.
 *
 * A client component because it switches between those states, but the work
 * happens in Server Actions — the password is posted to the server and the
 * session cookie is set there. No token ever reaches this code.
 *
 * The form works without JavaScript too: `useActionState` degrades to a plain
 * form post, which is worth having on the one screen a person cannot get past
 * if it breaks.
 */

const EMPTY: ActionResult = { ok: false };

export function SignInForm() {
  const [state, submit, pending] = useActionState(signIn, EMPTY);
  const [mfaState, submitMfa, mfaPending] = useActionState(verifyMfa, EMPTY);
  const [resetState, submitReset, resetPending] = useActionState(requestPasswordReset, EMPTY);

  const challengeToken = mfaState.mfaChallengeToken ?? state.mfaChallengeToken;

  /* ---------------------------------------------------------- second factor */

  if (challengeToken) {
    return (
      <form action={submitMfa} className="auth-form">
        <input type="hidden" name="challengeToken" value={challengeToken} />

        {mfaState.message ? (
          <p className="form-error" role="alert">
            {mfaState.message}
          </p>
        ) : (
          <p className="muted">Enter the six-digit code from your authenticator app.</p>
        )}

        <div className="field">
          <label htmlFor="code">Authentication code</label>
          <input
            id="code"
            name="code"
            /*
             * `text` with a numeric input mode rather than `type="number"`,
             * which strips leading zeros — and a TOTP code beginning with a
             * zero is one in ten.
             */
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={10}
            required
            autoFocus
          />
          <p className="field-help">Lost your device? Enter one of your recovery codes instead.</p>
        </div>

        <button type="submit" className="button button--primary" disabled={mfaPending}>
          {mfaPending ? 'Checking…' : 'Verify'}
        </button>
      </form>
    );
  }

  /* -------------------------------------------------------- password reset */

  if (resetState.ok && resetState.message) {
    return (
      <div className="auth-form">
        <p className="form-success" role="status">
          {resetState.message}
        </p>
        <a href="/sign-in" className="button">
          Back to sign in
        </a>
      </div>
    );
  }

  /* ------------------------------------------------------------ credentials */

  return (
    <>
      <form action={submit} className="auth-form">
        {state.message ? (
          <p className="form-error" role="alert">
            {state.message}
          </p>
        ) : null}

        <div className="field">
          <label htmlFor="email">Email address</label>
          <input id="email" name="email" type="email" autoComplete="username" required autoFocus />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>

        <button type="submit" className="button button--primary" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <details className="auth-reset">
        <summary>Forgotten your password?</summary>
        <form action={submitReset} className="auth-form">
          <div className="field">
            <label htmlFor="reset-email">Email address</label>
            <input id="reset-email" name="email" type="email" autoComplete="username" required />
          </div>
          <button type="submit" className="button" disabled={resetPending}>
            {resetPending ? 'Sending…' : 'Send a reset link'}
          </button>
        </form>
      </details>
    </>
  );
}
