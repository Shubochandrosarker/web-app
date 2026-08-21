import { redirect } from 'next/navigation';
import { apiFetch, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';

export const dynamic = 'force-dynamic';

/**
 * The dashboard's front door.
 *
 * For someone who works leads, it answers the morning question — what needs
 * me? — with real counts from this workspace's rows: today's enquiries, the
 * unassigned queue, follow-ups that have come due, overdue tasks, documents
 * still owed a verdict. Every number is a link to the filtered screen where
 * the work happens, and a card whose number is zero says so rather than
 * hiding — an empty queue is information.
 *
 * Someone who cannot read leads goes straight to the screen they can use;
 * a landing page of tiles they cannot click is a click between them and
 * their job.
 */

interface Overview {
  readonly newLeadsToday: number;
  readonly unassignedLeads: number;
  readonly followUpsDue: number;
  readonly overdueTasks: number;
  readonly myOpenTasks: number;
  readonly documentsAwaiting: number;
  readonly leadsThisWeek: number;
  readonly leadsPreviousWeek: number;
}

export default async function IndexPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  if (!can(session, 'leads.read')) {
    if (can(session, 'content.read')) redirect('/content');
    redirect('/settings');
  }

  const overview = await apiFetch<Overview>('/v1/crm/overview');

  const attention = [
    {
      label: 'New leads today',
      value: overview.newLeadsToday,
      href: '/leads',
      urgent: false,
    },
    {
      label: 'Unassigned leads',
      value: overview.unassignedLeads,
      href: '/leads?assigned=unassigned',
      urgent: overview.unassignedLeads > 0,
    },
    {
      label: 'Follow-ups due',
      value: overview.followUpsDue,
      href: '/leads',
      urgent: overview.followUpsDue > 0,
    },
    {
      label: 'Overdue tasks',
      value: overview.overdueTasks,
      href: '/tasks?view=overdue',
      urgent: overview.overdueTasks > 0,
    },
    {
      label: 'My open tasks',
      value: overview.myOpenTasks,
      href: '/tasks?view=mine',
      urgent: false,
    },
    ...(can(session, 'documents.read')
      ? [
          {
            label: 'Documents being checked',
            value: overview.documentsAwaiting,
            href: '/documents?status=scanning',
            urgent: false,
          },
        ]
      : []),
  ];

  const weekDelta = overview.leadsThisWeek - overview.leadsPreviousWeek;

  return (
    <DashboardShell session={session} businessType="education_service" current="/">
      <div className="page-header">
        <div>
          <h1>Today</h1>
          <p className="muted">
            {overview.leadsThisWeek} {overview.leadsThisWeek === 1 ? 'lead' : 'leads'} in the last 7
            days
            {overview.leadsPreviousWeek > 0 || overview.leadsThisWeek > 0 ? (
              <>
                {' '}
                ({weekDelta >= 0 ? '+' : ''}
                {weekDelta} vs the week before)
              </>
            ) : null}
          </p>
        </div>
      </div>

      <ul className="stat-grid">
        {attention.map((card) => (
          <li key={card.label}>
            <a
              href={card.href}
              className={card.urgent ? 'stat-card stat-card--urgent' : 'stat-card'}
            >
              <span className="stat-value">{card.value}</span>
              <span className="stat-label">{card.label}</span>
            </a>
          </li>
        ))}
      </ul>

      <section className="panel">
        <h2>Quick actions</h2>
        <div className="panel-actions">
          <a className="button" href="/leads">
            Work the lead board
          </a>
          {can(session, 'content.write') ? (
            <a className="button" href="/content">
              Edit content
            </a>
          ) : null}
          {can(session, 'media.write') ? (
            <a className="button" href="/media">
              Upload media
            </a>
          ) : null}
          {can(session, 'forms.write') ? (
            <a className="button" href="/forms">
              Edit forms
            </a>
          ) : null}
        </div>
      </section>
    </DashboardShell>
  );
}
