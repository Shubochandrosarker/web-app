'use client';

import { useId, useRef, useState } from 'react';
import type { ResolvedFormField } from '@bos/content';

/**
 * The document upload field on the public service-request form.
 *
 * The file goes **directly to private storage** via a one-shot signed URL —
 * it never travels through the site or the API process. The flow the visitor
 * experiences as "attach your transcript" is three requests:
 *
 *  1. ask the API to authorise one bounded upload → signed URL + claim token
 *  2. PUT the file to the signed URL
 *  3. confirm, presenting the claim token → the API verifies the real bytes
 *     (size, file signature, checksum) and scans them
 *
 * What the form submission later sends is the `{documentId, claimToken}`
 * pair — possession of the token is what ties the upload to this visitor's
 * submission and nobody else's.
 *
 * Everything here degrades honestly: with JavaScript unavailable the field
 * explains that documents can be sent after submitting, rather than
 * pretending to be an input that silently does nothing.
 */

export interface UploadedDocument {
  readonly documentId: string;
  readonly claimToken: string;
  readonly filename: string;
}

type UploadState =
  | { kind: 'idle' }
  | { kind: 'uploading'; filename: string }
  | { kind: 'scanning'; filename: string }
  | { kind: 'done'; filename: string }
  | { kind: 'error'; message: string };

const DEFAULT_ACCEPT = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];
const MAX_BYTES = 15 * 1024 * 1024;

export function FileUploadField({
  field,
  workspaceSlug,
  disabled,
  onUploaded,
  onRemoved,
}: {
  readonly field: ResolvedFormField;
  readonly workspaceSlug: string;
  readonly disabled: boolean;
  readonly onUploaded: (document: UploadedDocument) => void;
  readonly onRemoved: (documentId: string) => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<UploadState>({ kind: 'idle' });
  const [uploaded, setUploaded] = useState<UploadedDocument[]>([]);

  const accept = field.accept.length > 0 ? field.accept : DEFAULT_ACCEPT;
  const apiUrl = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/+$/, '');

  const upload = async (file: File): Promise<void> => {
    if (file.size > MAX_BYTES) {
      setState({
        kind: 'error',
        message: 'That file is larger than 15 MB. Please upload a smaller scan.',
      });
      return;
    }
    if (!accept.includes(file.type)) {
      setState({
        kind: 'error',
        message: 'Please upload a PDF or a photograph (JPEG, PNG, WebP or HEIC).',
      });
      return;
    }

    setState({ kind: 'uploading', filename: file.name });

    try {
      const authorise = await fetch(`${apiUrl}/v1/documents/upload-url`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspace: workspaceSlug,
          filename: file.name,
          contentType: file.type,
          contentLength: file.size,
          kind: 'other',
        }),
      });

      if (!authorise.ok) {
        const body = (await authorise.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setState({
          kind: 'error',
          message: body.error?.message ?? 'We could not start the upload. Please try again.',
        });
        return;
      }

      const grant = (await authorise.json()) as {
        documentId: string;
        claimToken: string;
        uploadUrl: string;
        requiredHeaders: Record<string, string>;
      };

      const put = await fetch(grant.uploadUrl, {
        method: 'PUT',
        headers: grant.requiredHeaders,
        body: file,
      });
      if (!put.ok) {
        setState({
          kind: 'error',
          message: 'The upload did not complete. Please check your connection and try again.',
        });
        return;
      }

      setState({ kind: 'scanning', filename: file.name });

      const confirm = await fetch(`${apiUrl}/v1/documents/${grant.documentId}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: workspaceSlug, claimToken: grant.claimToken }),
      });

      const confirmation = (await confirm.json().catch(() => ({}))) as {
        status?: string;
        message?: string;
      };

      if (!confirm.ok || confirmation.status === 'rejected') {
        setState({
          kind: 'error',
          message:
            confirmation.message ?? 'That file could not be accepted. Please try a different scan.',
        });
        return;
      }

      const document: UploadedDocument = {
        documentId: grant.documentId,
        claimToken: grant.claimToken,
        filename: file.name,
      };
      setUploaded((current) => [...current, document]);
      onUploaded(document);
      setState({ kind: 'done', filename: file.name });
    } catch {
      setState({
        kind: 'error',
        message: 'We could not reach our server. Please check your connection and try again.',
      });
    } finally {
      // Allow the same file to be picked again after an error.
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = (documentId: string): void => {
    setUploaded((current) => current.filter((entry) => entry.documentId !== documentId));
    onRemoved(documentId);
    setState({ kind: 'idle' });
  };

  const busy = state.kind === 'uploading' || state.kind === 'scanning';

  return (
    <div className="field field--file">
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

      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={accept.join(',')}
        disabled={disabled || busy}
        aria-describedby={`${id}-status${field.helpText ? ` ${id}-help` : ''}`}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void upload(file);
        }}
      />

      {field.helpText ? (
        <p id={`${id}-help`} className="field-help">
          {field.helpText}
        </p>
      ) : null}

      <p
        id={`${id}-status`}
        className={state.kind === 'error' ? 'field-error' : 'field-help'}
        role="status"
      >
        {state.kind === 'uploading'
          ? `Uploading ${state.filename}…`
          : state.kind === 'scanning'
            ? `Checking ${state.filename}…`
            : state.kind === 'error'
              ? state.message
              : ''}
      </p>

      {uploaded.length > 0 ? (
        <ul className="uploaded-files">
          {uploaded.map((entry) => (
            <li key={entry.documentId}>
              <span>{entry.filename}</span>
              <button
                type="button"
                className="link-button"
                disabled={disabled}
                onClick={() => remove(entry.documentId)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <noscript>
        <p className="field-help">
          Document upload needs JavaScript. You can submit the form without it — we will ask for
          your documents by reply.
        </p>
      </noscript>
    </div>
  );
}
