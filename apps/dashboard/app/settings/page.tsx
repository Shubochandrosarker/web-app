import { redirect } from 'next/navigation';
import { apiFetch, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { MfaPanel } from '@/components/mfa-panel';
import { SessionsPanel, type SessionRow } from '@/components/sessions-panel';
import { IntegrationsPanel, type IntegrationsStatus } from '@/components/integrations-panel';

export const metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const { sessions } = await apiFetch<{ sessions: SessionRow[] }>('/v1/auth/sessions', {
    workspaceScoped: false,
  }).catch(() => ({ sessions: [] as SessionRow[] }));

  const integrations = can(session, 'settings.read')
    ? await apiFetch<IntegrationsStatus>('/v1/settings/integrations').catch(() => null)
    : null;

  return (
    <DashboardShell session={session} current="/settings">
      <div className="page-header">
        <div>
          <h1>Your account</h1>
          <p className="muted">{session.user.email}</p>
        </div>
      </div>

      <div className="detail-grid">
        <div className="detail-main">
          <MfaPanel enabled={session.user.mfaEnabled} />
          <SessionsPanel sessions={sessions} />
          {integrations ? (
            <IntegrationsPanel status={integrations} canWrite={can(session, 'settings.write')} />
          ) : null}
        </div>

        <aside className="detail-side">
          <section className="panel">
            <h2>Access</h2>
            <dl className="detail-list">
              <div>
                <dt>Workspace</dt>
                <dd>{session.workspace?.name ?? 'None'}</dd>
              </div>
              <div>
                <dt>Role</dt>
                <dd>{session.workspace?.role ?? '—'}</dd>
              </div>
            </dl>
            <details>
              <summary>What your role can do</summary>
              <ul className="permission-list">
                {(session.workspace?.permissions ?? []).map((permission) => (
                  <li key={permission}>
                    <code>{permission}</code>
                  </li>
                ))}
              </ul>
            </details>
          </section>
        </aside>
      </div>
    </DashboardShell>
  );
}
