import type { ReactNode } from 'react';
import { signOut } from '@/lib/actions';
import { buildNavigation } from '@/lib/navigation';
import type { Session } from '@/lib/api';
import type { BusinessType, ModuleId } from '@bos/business-types';

/**
 * The authenticated shell.
 *
 * Navigation is a projection of two things and nothing else: which modules the
 * workspace has enabled, and which permissions the signed-in person holds. It
 * is never a list somebody edits per client — that is the reusability claim
 * made concrete, and it is why a tour operator and a consultancy get different
 * sidebars from the same build.
 *
 * Hiding a link is a courtesy, not a control. The API re-checks every request,
 * so a person who guesses a URL gets a 403 rather than a screen they should
 * not see.
 *
 * A server component with one native disclosure for the mobile sidebar. No
 * client JavaScript, which for an operations tool means it works on a bad
 * connection in a queue outside a university office.
 */
export function DashboardShell({
  session,
  current,
  children,
}: {
  session: Session;
  /** The nav item that should read as active, by href prefix. */
  current: string;
  children: ReactNode;
}) {
  const workspace = session.workspace;

  // The vocabulary follows the workspace the person is signed into — the
  // same build serves an education service and a tour operator.
  const groups = workspace
    ? buildNavigation(
        workspace.enabledModules as ModuleId[],
        workspace.businessType as BusinessType,
        workspace.permissions,
      )
    : [];

  const initials = (session.user.fullName ?? session.user.email)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div className="shell">
      <header className="shell-topbar">
        <div className="shell-topbar-inner">
          {/*
            The sidebar toggle is a `<details>` whose content is the sidebar
            itself on narrow screens. Native disclosure semantics, keyboard
            support and screen-reader announcement, with no script.
          */}
          <details className="shell-menu">
            <summary aria-label="Menu">
              <span aria-hidden="true">☰</span>
            </summary>
            <nav aria-label="Sections (mobile)">
              <NavGroups groups={groups} current={current} />
            </nav>
          </details>

          <a href="/" className="shell-brand">
            {workspace?.name ?? 'Business OS'}
          </a>

          <details className="shell-account">
            <summary aria-label="Account">
              <span className="avatar-initials" aria-hidden="true">
                {initials}
              </span>
            </summary>
            <div className="shell-account-menu">
              <p className="shell-account-name">{session.user.fullName ?? session.user.email}</p>
              <p className="shell-account-meta">
                {session.user.email}
                <br />
                {workspace ? `${workspace.role} · ${workspace.name}` : 'No workspace'}
              </p>
              {!session.user.mfaEnabled ? (
                <p className="shell-account-warning">
                  Two-factor authentication is off. <a href="/settings">Turn it on</a>.
                </p>
              ) : null}
              <a href="/settings">Settings</a>
              {/*
                Sign-out is a form posting to a Server Action, not a link. A
                GET that ends a session can be triggered by any page that
                embeds the URL as an image.
              */}
              <form action={signOut}>
                <button type="submit" className="link-button">
                  Sign out
                </button>
              </form>
            </div>
          </details>
        </div>
      </header>

      <div className="shell-body">
        <nav className="shell-sidebar" aria-label="Sections">
          <NavGroups groups={groups} current={current} />
        </nav>

        <main className="shell-main" id="main">
          {workspace ? (
            children
          ) : (
            /*
             * Signed in, but not a member of the workspace this deployment
             * serves. A real state — an account created for a different
             * tenant — and one that deserves a sentence rather than an empty
             * screen or a crash.
             */
            <div className="panel">
              <h1>No access to this workspace</h1>
              <p>
                Your account is not a member of <strong>{process.env.BOS_WORKSPACE_SLUG}</strong>.
                Ask an administrator to invite you, or sign in with a different account.
              </p>
              <form action={signOut}>
                <button type="submit" className="button">
                  Sign out
                </button>
              </form>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function NavGroups({
  groups,
  current,
}: {
  groups: ReturnType<typeof buildNavigation>;
  current: string;
}) {
  if (groups.length === 0) {
    return <p className="shell-nav-empty">No modules are enabled for this workspace.</p>;
  }

  return (
    <>
      {groups.map((group) => (
        <div key={group.title} className="shell-nav-group">
          <h2>{group.title}</h2>
          <ul>
            {group.items.map((item) => {
              const active = current === item.href || current.startsWith(`${item.href}/`);
              return (
                <li key={item.href}>
                  <a
                    href={item.href}
                    className={active ? 'active' : undefined}
                    // `aria-current` is what tells a screen reader which page
                    // this is; a CSS class tells it nothing.
                    {...(active ? { 'aria-current': 'page' as const } : {})}
                  >
                    {item.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}
