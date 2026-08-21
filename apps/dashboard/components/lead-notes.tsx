'use client';

import { useRef, useTransition } from 'react';
import { addLeadNote, addLeadTask, completeTask } from '@/lib/actions';
import { RelativeTime } from './relative-time';

/**
 * Notes and follow-up tasks.
 *
 * Notes are rendered as plain text, never as markup: a note is an internal
 * record, not published content, and there is no reason for it to accept
 * markup — which also means there is no sanitisation question to get wrong.
 */
export function LeadNotes({
  leadId,
  notes,
  tasks,
  canWrite,
  canAddTask,
}: {
  leadId: string;
  notes: readonly { id: string; body: string; createdAt: string }[];
  tasks: readonly { id: string; title: string; status: string; dueAt: string | null }[];
  canWrite: boolean;
  canAddTask: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const noteForm = useRef<HTMLFormElement>(null);
  const taskForm = useRef<HTMLFormElement>(null);

  const openTasks = tasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled');
  const doneTasks = tasks.filter((task) => task.status === 'done');

  return (
    <>
      <section className="panel">
        <h2>Follow-up</h2>

        {openTasks.length === 0 && doneTasks.length === 0 ? (
          <p className="muted">Nothing scheduled.</p>
        ) : (
          <ul className="task-list">
            {openTasks.map((task) => (
              <li key={task.id}>
                <span>{task.title}</span>
                {task.dueAt ? (
                  <span className="muted">
                    due <RelativeTime iso={task.dueAt} />
                  </span>
                ) : null}
                {canAddTask ? (
                  <button
                    type="button"
                    className="link-button"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        await completeTask(task.id, leadId);
                      })
                    }
                  >
                    Mark done
                  </button>
                ) : null}
              </li>
            ))}
            {doneTasks.map((task) => (
              <li key={task.id} className="task-done">
                <s>{task.title}</s>
              </li>
            ))}
          </ul>
        )}

        {canAddTask ? (
          <form
            ref={taskForm}
            className="inline-form"
            action={(formData) =>
              startTransition(async () => {
                await addLeadTask(leadId, formData);
                taskForm.current?.reset();
              })
            }
          >
            <label className="visually-hidden" htmlFor="task-title">
              Task
            </label>
            <input id="task-title" name="title" placeholder="Call back about documents" required />

            <label className="visually-hidden" htmlFor="task-due">
              Due
            </label>
            <input id="task-due" name="dueAt" type="datetime-local" />

            <button type="submit" className="button" disabled={pending}>
              Add
            </button>
          </form>
        ) : null}
      </section>

      <section className="panel">
        <h2>Notes</h2>

        {canWrite ? (
          <form
            ref={noteForm}
            className="inline-form inline-form--stacked"
            action={(formData) =>
              startTransition(async () => {
                await addLeadNote(leadId, formData);
                noteForm.current?.reset();
              })
            }
          >
            <label className="visually-hidden" htmlFor="note-body">
              Note
            </label>
            <textarea
              id="note-body"
              name="body"
              rows={3}
              placeholder="Called, left a voicemail. Will try again tomorrow."
              required
            />
            <button type="submit" className="button" disabled={pending}>
              {pending ? 'Saving…' : 'Add note'}
            </button>
          </form>
        ) : null}

        {notes.length === 0 ? (
          <p className="muted">No notes yet.</p>
        ) : (
          <ul className="note-list">
            {notes.map((note) => (
              <li key={note.id}>
                {/* Plain text, deliberately. */}
                <p>{note.body}</p>
                <p className="muted">
                  <RelativeTime iso={note.createdAt} />
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
