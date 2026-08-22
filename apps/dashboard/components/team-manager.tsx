'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { inviteMember, updateMember } from '@/lib/actions';

export interface MemberRow {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string | null;
  readonly status: string;
  readonly role: string;
  readonly mfaEnabled: boolean;
  readonly activeSessions: number;
  readonly joinedAt: string;
}

const ASSIGNABLE_ROLES = ['owner', 'admin', 'manager', 'staff', 'viewer'] as const;

export function TeamManager({
  members,
  canInvite,
  canManage,
  selfUserId,
}: {
  readonly members: readonly MemberRow[];
  readonly canInvite: boolean;
  readonly canManage: boolean;
  readonly selfUserId: string;
}) {
  const router = useRouter();
  const [message, setMessage] = useState('');
  const [invite, setInvite] = useState({ email: '', fullName: '', role: 'staff' });
  const [pending, startTransition] = useTransition();

  const changeRole = (userId: string, role: string): void =>
    startTransition(async () => {
      const result = await updateMember(userId, { role });
      setMessage(result.message ?? '');
      if (result.ok) router.refresh();
    });

  const setStatus = (userId: string, status: 'active' | 'suspended'): void =>
    startTransition(async () => {
      const result = await updateMember(userId, { status });
      setMessage(result.message ?? '');
      if (result.ok) router.refresh();
    });

  const sendInvite = (): void =>
    startTransition(async () => {
      const result = await inviteMember(invite);
      setMessage(result.message ?? '');
      if (result.ok) {
        setInvite({ email: '', fullName: '', role: 'staff' });
        router.refresh();
      }
    });

  return (
    <>
      <section className="panel">
        <h2>Members</h2>
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">Workspace members</caption>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">MFA</th>
                <th scope="col">Sessions</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.userId}>
                  <th scope="row">
                    {member.fullName ?? member.email}
                    <br />
                    <span className="muted">{member.email}</span>
                  </th>
                  <td>
                    {canManage && member.userId !== selfUserId ? (
                      <>
                        <label
                          className="visually-hidden"
                          htmlFor={`role-${member.userId}`}
                        >{`Role for ${member.email}`}</label>
                        <select
                          id={`role-${member.userId}`}
                          value={member.role}
                          disabled={pending}
                          onChange={(event) => changeRole(member.userId, event.currentTarget.value)}
                        >
                          {ASSIGNABLE_ROLES.map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                        </select>
                      </>
                    ) : (
                      member.role
                    )}
                  </td>
                  <td>
                    <span
                      className={`badge badge--${member.status === 'active' ? 'won' : member.status === 'suspended' ? 'lost' : 'muted'}`}
                    >
                      {member.status}
                    </span>
                  </td>
                  <td>{member.mfaEnabled ? 'On' : 'Off'}</td>
                  <td>{member.activeSessions}</td>
                  <td>
                    {canManage && member.userId !== selfUserId ? (
                      member.status === 'suspended' ? (
                        <button
                          type="button"
                          className="button"
                          disabled={pending}
                          onClick={() => setStatus(member.userId, 'active')}
                        >
                          Reactivate
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="button"
                          disabled={pending}
                          onClick={() => setStatus(member.userId, 'suspended')}
                        >
                          Suspend
                        </button>
                      )
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {canInvite ? (
        <section className="panel">
          <h2>Invite someone</h2>
          <p className="muted">
            They set their own password through the emailed link — an invitation never contains
            credentials.
          </p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="invite-name">Full name</label>
              <input
                id="invite-name"
                value={invite.fullName}
                disabled={pending}
                onChange={(event) => setInvite({ ...invite, fullName: event.currentTarget.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="invite-email">Email</label>
              <input
                id="invite-email"
                type="email"
                value={invite.email}
                disabled={pending}
                onChange={(event) => setInvite({ ...invite, email: event.currentTarget.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="invite-role">Role</label>
              <select
                id="invite-role"
                value={invite.role}
                disabled={pending}
                onChange={(event) => setInvite({ ...invite, role: event.currentTarget.value })}
              >
                <option value="admin">admin</option>
                <option value="manager">manager</option>
                <option value="staff">staff</option>
                <option value="viewer">viewer</option>
              </select>
            </div>
          </div>
          <button
            type="button"
            className="button button--primary"
            disabled={pending}
            onClick={sendInvite}
          >
            {pending ? 'Inviting…' : 'Send invitation'}
          </button>
        </section>
      ) : null}

      <p className="muted" role="status">
        {message}
      </p>
    </>
  );
}
