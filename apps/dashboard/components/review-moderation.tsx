'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { moderateReview } from '@/lib/actions';

export function ReviewModeration({
  reviewId,
  approved,
  canWrite,
}: {
  readonly reviewId: string;
  readonly approved: boolean;
  readonly canWrite: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  if (!canWrite) return <span className="muted">Read only</span>;
  return (
    <span className="section-actions">
      <button
        type="button"
        className="link-button"
        disabled={pending || approved}
        onClick={() =>
          startTransition(async () => {
            await moderateReview(reviewId, true);
            router.refresh();
          })
        }
      >
        Approve
      </button>
      <button
        type="button"
        className="link-button link-button--danger"
        disabled={pending || !approved}
        onClick={() =>
          startTransition(async () => {
            await moderateReview(reviewId, false);
            router.refresh();
          })
        }
      >
        Reject
      </button>
    </span>
  );
}
