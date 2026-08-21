'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { archiveContent, createContent, duplicateContent } from '@/lib/actions';

/**
 * Creating content, and the per-row actions.
 *
 * The create flow asks for the four decisions a page cannot exist without —
 * what kind, what it is called, and where it lives — and derives sensible
 * slugs from the title as the person types, because "untitled-7" URLs are
 * what happens when a slug field starts empty and stays that way.
 */

const CONTENT_TYPES = [
  { value: 'page', label: 'Page', pathPrefix: '/' },
  { value: 'service', label: 'Service', pathPrefix: '/services/' },
  { value: 'guide', label: 'Guide', pathPrefix: '/guides/' },
  { value: 'post', label: 'Post', pathPrefix: '/blog/' },
  { value: 'landing_page', label: 'Landing page', pathPrefix: '/l/' },
  { value: 'location', label: 'Location', pathPrefix: '/locations/' },
];

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 140);
}

export function NewContentButton({ locale }: { readonly locale: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState('page');
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const prefix = CONTENT_TYPES.find((entry) => entry.value === type)?.pathPrefix ?? '/';
  const effectiveSlug = slugTouched ? slug : slugify(title);
  const path = type === 'page' && effectiveSlug === 'home' ? '/' : `${prefix}${effectiveSlug}`;

  const submit = (): void => {
    if (!title.trim()) {
      setError('Give the page a title.');
      return;
    }
    if (!effectiveSlug) {
      setError('The title needs at least one letter or number for the URL.');
      return;
    }
    startTransition(async () => {
      const created = await createContent({
        type,
        title: title.trim(),
        slug: effectiveSlug,
        path,
        locale,
      });
      if (created.ok && created.id) {
        router.push(`/content/${created.id}`);
      } else {
        setError(created.message ?? 'The page could not be created.');
      }
    });
  };

  if (!open) {
    return (
      <button type="button" className="button button--primary" onClick={() => setOpen(true)}>
        New content
      </button>
    );
  }

  return (
    <div className="panel panel--dialog" role="dialog" aria-labelledby="new-content-heading">
      <h2 id="new-content-heading">New content</h2>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="field">
        <label htmlFor="new-type">Type</label>
        <select
          id="new-type"
          value={type}
          disabled={pending}
          onChange={(event) => setType(event.currentTarget.value)}
        >
          {CONTENT_TYPES.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="new-title">Title</label>
        <input
          id="new-title"
          value={title}
          maxLength={300}
          disabled={pending}
          onChange={(event) => setTitle(event.currentTarget.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="new-slug">URL slug</label>
        <input
          id="new-slug"
          value={effectiveSlug}
          maxLength={140}
          disabled={pending}
          onChange={(event) => {
            setSlugTouched(true);
            setSlug(slugify(event.currentTarget.value));
          }}
        />
        <p className="field-help">
          Will publish at <code>{path}</code>
        </p>
      </div>

      <div className="editor-actions">
        <button
          type="button"
          className="button button--primary"
          disabled={pending}
          onClick={submit}
        >
          {pending ? 'Creating…' : 'Create draft'}
        </button>
        <button type="button" className="button" disabled={pending} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ContentRowActions({
  contentId,
  status,
  canDelete,
}: {
  readonly contentId: string;
  readonly status: string;
  readonly canDelete: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmingArchive, setConfirmingArchive] = useState(false);

  return (
    <span className="section-actions">
      <button
        type="button"
        className="link-button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await duplicateContent(contentId);
            if (result.ok && result.id) router.push(`/content/${result.id}`);
          })
        }
      >
        Duplicate
      </button>
      {canDelete && status !== 'archived' ? (
        confirmingArchive ? (
          <>
            <button
              type="button"
              className="link-button link-button--danger"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  await archiveContent(contentId);
                  setConfirmingArchive(false);
                })
              }
            >
              Confirm archive
            </button>
            <button
              type="button"
              className="link-button"
              disabled={pending}
              onClick={() => setConfirmingArchive(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="link-button"
            disabled={pending}
            onClick={() => setConfirmingArchive(true)}
          >
            Archive
          </button>
        )
      ) : null}
    </span>
  );
}
