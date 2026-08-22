import { redirect } from 'next/navigation';
import { apiFetch, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { TeamManager, type MemberRow } from '@/components/team-manager';

export const metadata = { title: 'Team' };
export const dynamic = 'force-dynamic';

export default async function TeamPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const { items } = await apiFetch<{ items: MemberRow[] }>('/v1/members').catch(() => ({
    items: [] as MemberRow[],
  }));

  return (
    <DashboardShell session={session} current="/team">
      <div className="page-header">
        <div>
          <h1>Team</h1>
          <p className="muted">
            Who can sign in, with what role, and whether their account is protected. The last owner
            can never be demoted or suspended.
          </p>
        </div>
      </div>
      <TeamManager
        members={items}
        canInvite={can(session, 'members.invite')}
        canManage={can(session, 'members.manage')}
        selfUserId={session.user.userId}
      />
    </DashboardShell>
  );
}
