'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { markAllNotificationsRead, markNotificationRead } from '@/lib/actions';

export function MarkReadButton({ id }: { readonly id: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className="link-button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await markNotificationRead(id);
          router.refresh();
        })
      }
    >
      {pending ? 'Marking…' : 'Mark read'}
    </button>
  );
}

export function MarkAllReadButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await markAllNotificationsRead();
          router.refresh();
        })
      }
    >
      {pending ? 'Marking…' : 'Mark all read'}
    </button>
  );
}
