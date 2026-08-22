import { redirect } from 'next/navigation';
import { apiFetch, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { RelativeTime } from '@/components/relative-time';
import { MarkAllReadButton, MarkReadButton } from '@/components/notification-actions';

export const metadata = { title: 'Notifications' };
export const dynamic = 'force-dynamic';

interface Notification {
  readonly id: string;
  readonly kind: string;
  readonly severity: string;
  readonly title: string;
  readonly body: string | null;
  readonly href: string | null;
  readonly readAt: string | null;
  readonly createdAt: string;
}

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'lost',
  warning: 'scheduled',
  info: 'muted',
};

export default async function NotificationsPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const { items, unreadCount } = await apiFetch<{
    items: Notification[];
    unreadCount: number;
  }>('/v1/notifications?limit=100').catch(() => ({
    items: [] as Notification[],
    unreadCount: 0,
  }));

  return (
    <DashboardShell session={session} current="/notifications">
      <div className="page-header">
        <div>
          <h1>Notifications</h1>
          <p className="muted">
            {unreadCount > 0
              ? `${unreadCount} unread — things that may need a person.`
              : 'All caught up.'}
          </p>
        </div>
        {unreadCount > 0 ? <MarkAllReadButton /> : null}
      </div>

      {items.length === 0 ? (
        <div className="panel">
          <h2>Nothing yet</h2>
          <p className="muted">
            Rejected documents, reviews waiting for moderation, failed automations and new orders
            appear here.
          </p>
        </div>
      ) : (
        <ul className="notification-list">
          {items.map((notification) => (
            <li
              key={notification.id}
              className={`panel${notification.readAt ? ' notification--read' : ''}`}
            >
              <p>
                <span
                  className={`badge badge--${SEVERITY_BADGE[notification.severity] ?? 'muted'}`}
                >
                  {notification.severity}
                </span>{' '}
                <strong>{notification.title}</strong>{' '}
                <span className="muted">
                  · <RelativeTime iso={notification.createdAt} />
                </span>
              </p>
              {notification.body ? <p className="muted">{notification.body}</p> : null}
              <p>
                {notification.href ? <a href={notification.href}>Open</a> : null}{' '}
                {!notification.readAt ? <MarkReadButton id={notification.id} /> : null}
              </p>
            </li>
          ))}
        </ul>
      )}
    </DashboardShell>
  );
}
