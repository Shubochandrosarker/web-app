import { redirect } from 'next/navigation';
import { apiFetch, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { RelativeTime } from '@/components/relative-time';
import { TaskToggle } from '@/components/task-toggle';

export const metadata = { title: 'Tasks' };
export const dynamic = 'force-dynamic';

interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly dueAt: string | null;
  readonly leadId: string | null;
  readonly leadTitle: string | null;
  readonly createdAt: string;
  /** Computed by the API against the database clock — one clock, no skew. */
  readonly overdue: boolean;
}

const VIEWS = [
  { key: '', label: 'Open', query: 'status=open' },
  { key: 'mine', label: 'Mine', query: 'status=open&assigned=me' },
  { key: 'today', label: 'Due today', query: 'status=open&due=today' },
  { key: 'overdue', label: 'Overdue', query: 'status=open&due=overdue' },
  { key: 'done', label: 'Done', query: 'status=done' },
];

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const params = await searchParams;
  const view = VIEWS.find((candidate) => candidate.key === (params.view ?? '')) ?? VIEWS[0]!;

  const { items } = await apiFetch<{ items: TaskRow[] }>(`/v1/crm/tasks?${view.query}`);

  return (
    <DashboardShell session={session} current="/tasks">
      <div className="page-header">
        <div>
          <h1>Tasks</h1>
          <p className="muted">
            {items.length} {view.label.toLowerCase()} {items.length === 1 ? 'task' : 'tasks'}
          </p>
        </div>
      </div>

      <nav className="view-switch" aria-label="Task views">
        {VIEWS.map((candidate) => (
          <a
            key={candidate.key}
            href={candidate.key ? `/tasks?view=${candidate.key}` : '/tasks'}
            className={candidate.key === view.key ? 'active' : ''}
            aria-current={candidate.key === view.key ? 'page' : undefined}
          >
            {candidate.label}
          </a>
        ))}
      </nav>

      {items.length === 0 ? (
        <div className="panel">
          <h2>Nothing here</h2>
          <p className="muted">
            {view.key === 'overdue'
              ? 'No overdue tasks — the queue is healthy.'
              : 'Tasks created on leads appear here.'}
          </p>
        </div>
      ) : (
        <ul className="task-list panel">
          {items.map((task) => {
            const overdue = task.overdue;
            return (
              <li key={task.id}>
                <span>
                  <TaskToggle taskId={task.id} leadId={task.leadId} done={task.status === 'done'} />
                  <span className={task.status === 'done' ? 'task-done' : ''}>{task.title}</span>
                  {task.leadId && task.leadTitle ? (
                    <span className="muted">
                      {' '}
                      · <a href={`/leads/${task.leadId}`}>{task.leadTitle}</a>
                    </span>
                  ) : null}
                </span>
                <span className={overdue ? 'badge badge--lost' : 'muted'}>
                  {task.dueAt ? (
                    <>
                      {overdue ? 'Overdue — due ' : 'Due '}
                      <RelativeTime iso={task.dueAt} />
                    </>
                  ) : (
                    'No due date'
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </DashboardShell>
  );
}
