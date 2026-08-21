'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { completeTask, reopenTask } from '@/lib/actions';

/** The checkbox that closes (or reopens) a task, wherever tasks are listed. */
export function TaskToggle({
  taskId,
  leadId,
  done,
}: {
  readonly taskId: string;
  readonly leadId: string | null;
  readonly done: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <input
      type="checkbox"
      checked={done}
      disabled={pending}
      aria-label={done ? 'Reopen this task' : 'Mark this task done'}
      onChange={() =>
        startTransition(async () => {
          if (done) await reopenTask(taskId, leadId ?? undefined);
          else await completeTask(taskId, leadId ?? '');
          router.refresh();
        })
      }
    />
  );
}
