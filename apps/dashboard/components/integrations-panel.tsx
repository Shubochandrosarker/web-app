'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { checkContentProvider, syncSearchConsole } from '@/lib/actions';

export interface IntegrationsStatus {
  readonly searchConsole: {
    readonly configured: boolean;
    readonly targetsThisWorkspace: boolean;
    readonly property: string | null;
    readonly serviceAccount: string | null;
    readonly latestDate: string | null;
    readonly totalRows: number;
  };
  readonly contentProvider: {
    readonly provider: string;
    readonly wordpressHost: string | null;
  };
}

/**
 * Integration status with a button per integration — no terminal required to
 * see whether Search Console data flows or the content provider answers.
 * Nothing here shows or accepts credentials.
 */
export function IntegrationsPanel({
  status,
  canWrite,
}: {
  readonly status: IntegrationsStatus;
  readonly canWrite: boolean;
}) {
  const router = useRouter();
  const [gscMessage, setGscMessage] = useState('');
  const [probe, setProbe] = useState<string>('');
  const [pending, startTransition] = useTransition();
  const { searchConsole, contentProvider } = status;

  return (
    <>
      <section className="panel" aria-labelledby="gsc-heading">
        <h2 id="gsc-heading">Search Console</h2>
        {!searchConsole.configured ? (
          <p className="muted">
            Not connected. Set <code>GSC_CLIENT_EMAIL</code>, <code>GSC_PRIVATE_KEY</code> and{' '}
            <code>GSC_WORKSPACE</code> in the API environment, and grant the service account access
            to the property in Search Console.
          </p>
        ) : (
          <>
            <p>
              Connected as <code>{searchConsole.serviceAccount}</code>
              {searchConsole.property ? (
                <>
                  {' '}
                  reading <code>{searchConsole.property}</code>
                </>
              ) : (
                ' reading the workspace site URL as a URL-prefix property'
              )}
              .
            </p>
            <p className="muted">
              {searchConsole.totalRows > 0
                ? `${searchConsole.totalRows} rows ingested; newest day ${searchConsole.latestDate}. Search Console lags about two days.`
                : 'No rows ingested yet — run a sync, and check the property access if it stays empty.'}
            </p>
            {!searchConsole.targetsThisWorkspace ? (
              <p className="form-error">
                The configured ingest targets a different workspace, so syncing from here is
                disabled.
              </p>
            ) : null}
            {canWrite && searchConsole.targetsThisWorkspace ? (
              <button
                type="button"
                className="button button--primary"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const outcome = await syncSearchConsole();
                    setGscMessage(outcome.message ?? '');
                    if (outcome.ok) router.refresh();
                  })
                }
              >
                {pending ? 'Syncing…' : 'Sync now'}
              </button>
            ) : null}
            <p className="muted" role="status">
              {gscMessage}
            </p>
          </>
        )}
      </section>

      <section className="panel" aria-labelledby="cp-heading">
        <h2 id="cp-heading">Content provider</h2>
        <p>
          Content is served by the <strong>{contentProvider.provider}</strong> provider
          {contentProvider.wordpressHost ? (
            <>
              {' '}
              from <code>{contentProvider.wordpressHost}</code>
            </>
          ) : null}
          .
        </p>
        {contentProvider.provider === 'wordpress' ? (
          <p className="muted">
            The Application Password stays on the server; the check below probes the public REST API
            the adapter reads.
          </p>
        ) : null}
        <button
          type="button"
          className="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const outcome = await checkContentProvider();
              setProbe(
                outcome.ok
                  ? `${outcome.reachable === false ? 'Problem: ' : ''}${outcome.detail ?? ''}`
                  : (outcome.message ?? 'Check failed.'),
              );
            })
          }
        >
          {pending ? 'Checking…' : 'Run diagnostics'}
        </button>
        <p className="muted" role="status">
          {probe}
        </p>
      </section>
    </>
  );
}
