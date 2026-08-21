'use client';

import { useRef, useState, useTransition } from 'react';
import { deleteMedia, updateMedia, uploadMedia, type ActionResult } from '@/lib/actions';

/**
 * The media library screen.
 *
 * The grid is the catalogue; the panel under a selected image is where the
 * work happens — alt text above all, because an image without it is a hole
 * in the page for anyone using a screen reader and a missed signal for
 * search. Deletion is confirmed, and the API refuses it outright while the
 * image is still placed on a page.
 */

export interface MediaItem {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly alt: string | null;
  readonly caption: string | null;
  readonly url: string | null;
  readonly createdAt: string;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function MediaLibrary({
  items,
  canWrite,
  canDelete,
  storageConfigured,
}: {
  readonly items: readonly MediaItem[];
  readonly canWrite: boolean;
  readonly canDelete: boolean;
  readonly storageConfigured: boolean;
}) {
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [result, setResult] = useState<ActionResult>({ ok: true });
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const upload = (file: File): void => {
    const formData = new FormData();
    formData.set('file', file, file.name);
    startTransition(async () => {
      setResult(await uploadMedia(formData));
      if (fileInputRef.current) fileInputRef.current.value = '';
    });
  };

  return (
    <div>
      {result.message ? (
        <p
          className={result.ok ? 'form-success' : 'form-error'}
          role={result.ok ? 'status' : 'alert'}
        >
          {result.message}
        </p>
      ) : null}

      {canWrite ? (
        <div className="panel">
          <label htmlFor="media-upload">
            <strong>Upload an image</strong>
          </label>
          {storageConfigured ? (
            <>
              <input
                ref={fileInputRef}
                id="media-upload"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={pending}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) upload(file);
                }}
              />
              <p className="field-help">
                JPEG, PNG or WebP, up to 10 MB. The site serves AVIF/WebP variants automatically.
              </p>
            </>
          ) : (
            <p className="field-help">
              Media storage is not configured on this deployment. Set the R2 variables to enable
              uploads.
            </p>
          )}
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="panel">
          <h2>No images yet</h2>
          <p className="muted">Everything uploaded here becomes available in the page editor.</p>
        </div>
      ) : (
        <ul className="media-grid">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={selected?.id === item.id ? 'media-cell selected' : 'media-cell'}
                onClick={() => {
                  setSelected(selected?.id === item.id ? null : item);
                  setConfirmingDelete(false);
                }}
                aria-pressed={selected?.id === item.id}
              >
                {item.url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- the
                  // dashboard shows small thumbnails of arbitrary library
                  // images; the optimizer adds latency and nothing else here.
                  <img src={item.url} alt={item.alt ?? item.filename} loading="lazy" />
                ) : (
                  <span className="media-cell-placeholder">{item.filename}</span>
                )}
                <span className="media-cell-name">{item.filename}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected ? (
        <MediaDetail
          key={selected.id}
          item={selected}
          canWrite={canWrite}
          canDelete={canDelete}
          pending={pending}
          confirmingDelete={confirmingDelete}
          setConfirmingDelete={setConfirmingDelete}
          onSave={(alt, caption) =>
            startTransition(async () => {
              setResult(await updateMedia(selected.id, { alt, caption }));
            })
          }
          onDelete={() =>
            startTransition(async () => {
              const outcome = await deleteMedia(selected.id);
              setResult(outcome);
              if (outcome.ok) setSelected(null);
              setConfirmingDelete(false);
            })
          }
        />
      ) : null}
    </div>
  );
}

function MediaDetail({
  item,
  canWrite,
  canDelete,
  pending,
  confirmingDelete,
  setConfirmingDelete,
  onSave,
  onDelete,
}: {
  readonly item: MediaItem;
  readonly canWrite: boolean;
  readonly canDelete: boolean;
  readonly pending: boolean;
  readonly confirmingDelete: boolean;
  readonly setConfirmingDelete: (value: boolean) => void;
  readonly onSave: (alt: string, caption: string) => void;
  readonly onDelete: () => void;
}) {
  const [alt, setAlt] = useState(item.alt ?? '');
  const [caption, setCaption] = useState(item.caption ?? '');

  return (
    <section className="panel" aria-label={`Details for ${item.filename}`}>
      <h2>{item.filename}</h2>
      <p className="muted">
        {item.mimeType} · {formatBytes(item.sizeBytes)}
        {item.width && item.height ? ` · ${item.width}×${item.height}px` : ''}
      </p>

      <div className="field">
        <label htmlFor="media-alt">Alternative text</label>
        <input
          id="media-alt"
          value={alt}
          maxLength={300}
          disabled={!canWrite || pending}
          onChange={(event) => setAlt(event.currentTarget.value)}
        />
        <p className="field-help">
          What the image shows, for people who cannot see it. Usages in the editor can override it.
        </p>
      </div>

      <div className="field">
        <label htmlFor="media-caption">Caption</label>
        <textarea
          id="media-caption"
          rows={2}
          value={caption}
          maxLength={2000}
          disabled={!canWrite || pending}
          onChange={(event) => setCaption(event.currentTarget.value)}
        />
      </div>

      <div className="editor-actions">
        {canWrite ? (
          <button
            type="button"
            className="button button--primary"
            disabled={pending}
            onClick={() => onSave(alt, caption)}
          >
            Save details
          </button>
        ) : null}

        {canDelete ? (
          confirmingDelete ? (
            <>
              <button
                type="button"
                className="button button--danger"
                disabled={pending}
                onClick={onDelete}
              >
                Delete permanently
              </button>
              <button
                type="button"
                className="button"
                disabled={pending}
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="button" onClick={() => setConfirmingDelete(true)}>
              Delete…
            </button>
          )
        ) : null}
      </div>
    </section>
  );
}
