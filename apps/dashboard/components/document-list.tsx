'use client';

import { useState, useTransition } from 'react';
import { removeDocument, requestDocumentDownload } from '@/lib/actions';
import { RelativeTime } from '@/components/relative-time';

/**
 * Private documents as staff see them: what arrived, what state it is in,
 * and the two guarded actions. Opening a file mints a minutes-long signed
 * URL and is audited before the URL exists; only `clean` documents get one
 * at all, and the status column says why the button is missing. Deletion is
 * confirmed and destroys the object before the row admits it is gone.
 */

export interface DocumentRow {
  readonly id: string;
  readonly kind: string;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly status: string;
  readonly scanResult: Record<string, unknown> | null;
  readonly leadId: string | null;
  readonly contactId: string | null;
  readonly createdAt: string;
}

const STATUS_LABELS: Record<string, { label: string; badge: string; explain?: string }> = {
  pending_upload: { label: 'Never completed', badge: 'muted' },
  uploaded: { label: 'Awaiting verification', badge: 'scheduled' },
  scanning: {
    label: 'Being checked',
    badge: 'scheduled',
    explain: 'The malware scan has not finished. Nobody can open it yet.',
  },
  clean: { label: 'Verified', badge: 'won' },
  rejected: { label: 'Rejected', badge: 'lost' },
  expired: { label: 'Expired', badge: 'muted' },
  deleted: { label: 'Deleted', badge: 'muted' },
};

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function DocumentList({
  documents,
  canDownload,
  canDelete,
}: {
  readonly documents: readonly DocumentRow[];
  readonly canDownload: boolean;
  readonly canDelete: boolean;
}) {
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const download = (documentId: string): void => {
    startTransition(async () => {
      const minted = await requestDocumentDownload(documentId);
      if (minted.ok && minted.message) {
        // The URL is single-purpose and dies in minutes; opening it directly
        // is the entire flow.
        window.open(minted.message, '_blank', 'noopener');
        setMessage(null);
      } else {
        setMessage({ ok: false, text: minted.message ?? 'The download could not be authorised.' });
      }
    });
  };

  if (documents.length === 0) {
    return <p className="muted">No documents.</p>;
  }

  return (
    <div>
      {message ? (
        <p className={message.ok ? 'form-success' : 'form-error'} role="alert">
          {message.text}
        </p>
      ) : null}

      <ul className="document-list">
        {documents.map((document) => {
          const status = STATUS_LABELS[document.status] ?? {
            label: document.status,
            badge: 'muted',
          };
          const rejectedReason =
            document.status === 'rejected'
              ? String(document.scanResult?.reason ?? 'failed verification')
              : null;

          return (
            <li key={document.id}>
              <span>
                <strong>{document.originalFilename}</strong>
                <span className="muted">
                  {' '}
                  · {document.kind.replace(/_/g, ' ')} · {formatBytes(document.sizeBytes)} ·{' '}
                  <RelativeTime iso={document.createdAt} />
                </span>
                <br />
                <span className={`badge badge--${status.badge}`}>{status.label}</span>
                {rejectedReason ? (
                  <span className="muted"> — {rejectedReason.replace(/_/g, ' ')}</span>
                ) : null}
                {status.explain ? <span className="muted"> — {status.explain}</span> : null}
              </span>

              <span className="section-actions">
                {canDownload && document.status === 'clean' ? (
                  <button
                    type="button"
                    className="link-button"
                    disabled={pending}
                    onClick={() => download(document.id)}
                  >
                    Open
                  </button>
                ) : null}

                {canDelete && document.status !== 'deleted' ? (
                  confirming === document.id ? (
                    <>
                      <button
                        type="button"
                        className="link-button link-button--danger"
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () => {
                            const outcome = await removeDocument(document.id);
                            setMessage({ ok: outcome.ok, text: outcome.message ?? '' });
                            setConfirming(null);
                          })
                        }
                      >
                        Confirm delete
                      </button>
                      <button
                        type="button"
                        className="link-button"
                        disabled={pending}
                        onClick={() => setConfirming(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="link-button"
                      disabled={pending}
                      onClick={() => setConfirming(document.id)}
                    >
                      Delete…
                    </button>
                  )
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
