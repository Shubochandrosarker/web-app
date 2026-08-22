'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { saveReview, type ReviewPayload } from '@/lib/actions';

export function ReviewForm({
  reviewId,
  initial,
  canWrite,
}: {
  readonly reviewId: string | null;
  readonly initial: ReviewPayload;
  readonly canWrite: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState<ReviewPayload>(initial);
  const [message, setMessage] = useState('');
  const [pending, startTransition] = useTransition();
  const update = <K extends keyof ReviewPayload>(key: K, next: ReviewPayload[K]): void => {
    setValue((current) => ({ ...current, [key]: next }));
  };

  const save = (): void => {
    startTransition(async () => {
      const result = await saveReview(reviewId, value);
      setMessage(result.message ?? (result.ok ? 'Saved.' : 'Unable to save.'));
      if (result.ok && !reviewId && result.id) router.push(`/reviews/${result.id}`);
      if (result.ok && reviewId) router.refresh();
    });
  };

  return (
    <section className="panel">
      <div className="form-grid">
        <div className="field">
          <label htmlFor="review-author">Author name</label>
          <input
            id="review-author"
            value={value.authorName}
            disabled={!canWrite || pending}
            onChange={(event) => update('authorName', event.currentTarget.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="review-rating">Rating</label>
          <select
            id="review-rating"
            value={value.rating}
            disabled={!canWrite || pending}
            onChange={(event) => update('rating', Number(event.currentTarget.value))}
          >
            {[5, 4, 3, 2, 1].map((rating) => (
              <option key={rating} value={rating}>
                {rating} / 5
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="review-source">Source</label>
          <select
            id="review-source"
            value={value.source}
            disabled={!canWrite || pending}
            onChange={(event) =>
              update('source', event.currentTarget.value as ReviewPayload['source'])
            }
          >
            <option value="internal">Internal</option>
            <option value="google">Google</option>
            <option value="facebook">Facebook</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="review-external-id">External ID</label>
          <input
            id="review-external-id"
            value={value.externalId ?? ''}
            disabled={!canWrite || pending}
            onChange={(event) => update('externalId', event.currentTarget.value || null)}
          />
        </div>
        <div className="field field--wide">
          <label htmlFor="review-title">Title</label>
          <input
            id="review-title"
            value={value.title ?? ''}
            disabled={!canWrite || pending}
            onChange={(event) => update('title', event.currentTarget.value || null)}
          />
        </div>
        <div className="field field--wide">
          <label htmlFor="review-body">Review</label>
          <textarea
            id="review-body"
            rows={6}
            value={value.body ?? ''}
            disabled={!canWrite || pending}
            onChange={(event) => update('body', event.currentTarget.value || null)}
          />
        </div>
        <div className="field field--wide">
          <label htmlFor="review-contact">Contact ID (optional)</label>
          <input
            id="review-contact"
            value={value.contactId ?? ''}
            disabled={!canWrite || pending}
            onChange={(event) => update('contactId', event.currentTarget.value || null)}
            placeholder="UUID from Contacts"
          />
        </div>
        <div className="field field--wide">
          <label htmlFor="review-response">Business response (optional)</label>
          <textarea
            id="review-response"
            rows={4}
            value={value.response ?? ''}
            disabled={!canWrite || pending}
            onChange={(event) => update('response', event.currentTarget.value || null)}
          />
        </div>
      </div>
      {canWrite ? (
        <button type="button" className="button button--primary" onClick={save} disabled={pending}>
          {pending ? 'Saving…' : 'Save review'}
        </button>
      ) : null}
      <p className="muted" role="status">
        {message}
      </p>
    </section>
  );
}
