'use client';

import { useState, useTransition } from 'react';
import { revokeSession, signOutEverywhere } from '@/lib/actions';
import { RelativeTime } from '@/components/relative-time';

/**
 * Where this account is signed in.
 *
 * The list answers the question that matters after a shared computer or a
 * lost phone: "is something still holding my session?" — and gives the two
 * actions that follow from the answer, per session and all at once.
 */

export interface SessionRow {
  readonly id: string;
  readonly userAgent: string;
  readonly ipAddress: string;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
  readonly current: boolean;
}

/** A user agent is for machines; show the part a person recognises. */
function describeUserAgent(userAgent: string): string {
  if (!userAgent) return 'Unknown device';

  const browser = /firefox\/(\d+)/i.test(userAgent)
    ? 'Firefox'
    : /edg(e|a|ios)?\//i.test(userAgent)
      ? 'Edge'
      : /chrome|crios/i.test(userAgent)
        ? 'Chrome'
        : /safari/i.test(userAgent)
          ? 'Safari'
          : 'Browser';

  const platform = /windows/i.test(userAgent)
    ? 'Windows'
    : /android/i.test(userAgent)
      ? 'Android'
      : /iphone|ipad|ios/i.test(userAgent)
        ? 'iOS'
        : /mac os|macintosh/i.test(userAgent)
          ? 'macOS'
          : /linux/i.test(userAgent)
            ? 'Linux'
            : null;

  return platform ? `${browser} on ${platform}` : browser;
}

export function SessionsPanel({ sessions }: { readonly sessions: readonly SessionRow[] }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);

  const revoke = (sessionId: string) => {
    startTransition(async () => {
      const result = await revokeSession(sessionId);
      setMessage(result.message ?? null);
    });
  };

  return (
    <section className="panel" aria-labelledby="sessions-heading">
      <h2 id="sessions-heading">Where you are signed in</h2>

      {message ? (
        <p className="form-message" role="status">
          {message}
        </p>
      ) : null}

      {sessions.length === 0 ? (
        <p className="muted">No other active sessions.</p>
      ) : (
        <ul className="session-list">
          {sessions.map((session) => (
            <li key={session.id} className="session-row">
              <div>
                <strong>{describeUserAgent(session.userAgent)}</strong>
                {session.current ? (
                  <span className="badge badge--current"> This device</span>
                ) : null}
                <p className="muted">
                  {session.ipAddress ? <>From {session.ipAddress} · </> : null}
                  {session.lastSeenAt ? (
                    <>
                      Last active <RelativeTime iso={session.lastSeenAt} />
                    </>
                  ) : (
                    <>
                      Signed in <RelativeTime iso={session.createdAt} />
                    </>
                  )}
                </p>
              </div>
              {session.current ? null : (
                <button
                  type="button"
                  className="button button--small"
                  disabled={pending}
                  onClick={() => revoke(session.id)}
                >
                  Sign out
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="panel-actions">
        {confirmingAll ? (
          <div role="alertdialog" aria-labelledby="signout-all-confirm" className="confirm-inline">
            <p id="signout-all-confirm">
              Sign out on every device, including this one? You will need to sign in again.
            </p>
            <button
              type="button"
              className="button button--danger"
              disabled={pending}
              onClick={() => startTransition(() => signOutEverywhere())}
            >
              {pending ? 'Signing out…' : 'Sign out everywhere'}
            </button>
            <button
              type="button"
              className="button"
              disabled={pending}
              onClick={() => setConfirmingAll(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" className="button" onClick={() => setConfirmingAll(true)}>
            Sign out everywhere…
          </button>
        )}
      </div>
    </section>
  );
}
