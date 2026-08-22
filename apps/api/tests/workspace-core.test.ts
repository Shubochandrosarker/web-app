import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import { schema, withoutTenantScope } from '@bos/database';
import {
  authHeaders,
  createHarness,
  createMember,
  createSecondaryWorkspace,
  login,
  type Harness,
} from './helpers.ts';

/**
 * The core workspace surfaces added in the closeout: global search (gated per
 * entity permission), the notifications centre (per-recipient rows), team
 * operations (invite, role change, suspension, the last-owner guard) and the
 * audit trail read.
 */

let harness: Harness;
let adminHeaders: Record<string, string>;
let viewerHeaders: Record<string, string>;
let adminUserId: string;
let viewerUserId: string;
let ownerUserId: string;
let staffHeaders: Record<string, string>;

before(async () => {
  harness = await createHarness();
  const owner = await createMember(harness, 'owner');
  const admin = await createMember(harness, 'admin');
  const viewer = await createMember(harness, 'viewer');
  const staff = await createMember(harness, 'staff');
  ownerUserId = owner.userId;
  adminUserId = admin.userId;
  viewerUserId = viewer.userId;
  adminHeaders = authHeaders(harness, (await login(harness, admin.email)).accessToken);
  viewerHeaders = authHeaders(harness, (await login(harness, viewer.email)).accessToken);
  staffHeaders = authHeaders(harness, (await login(harness, staff.email)).accessToken);
});

after(async () => {
  await harness?.close();
});

describe('global search', () => {
  it('finds records by name and stays inside the workspace', async () => {
    const marker = `srch${randomUUID().slice(0, 6)}`;
    const other = await createSecondaryWorkspace(harness);
    try {
      await withoutTenantScope(harness.db, async (tx) => {
        await tx.insert(schema.contacts).values({
          workspaceId: harness.workspaceId,
          fullName: `Searchable ${marker}`,
        });
        await tx.insert(schema.contacts).values({
          workspaceId: other.workspaceId,
          fullName: `Foreign ${marker}`,
        });
      });

      const response = await harness.app.inject({
        method: 'GET',
        url: `/v1/search?q=${marker}`,
        headers: adminHeaders,
      });
      assert.equal(response.statusCode, 200, response.body);
      const { items } = response.json() as { items: { title: string; type: string }[] };
      assert.equal(items.length, 1, 'only this workspace’s contact');
      assert.match(items[0]!.title, /Searchable/);
    } finally {
      await other.drop();
    }
  });

  it('a two-character minimum is enforced', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/search?q=a',
      headers: adminHeaders,
    });
    assert.equal(response.statusCode, 400, response.body);
  });
});

describe('notifications', () => {
  it('fans out to role holders, and read state is per recipient', async () => {
    const { fanOutNotification } = await import('../src/services/notify.ts');
    const delivered = await fanOutNotification(harness.db, harness.workspaceId, {
      kind: 'test.ping',
      title: 'Something needs a manager',
      roles: ['owner', 'admin', 'manager'],
    });
    assert.ok(delivered >= 1, 'the admin received it');

    const adminList = await harness.app.inject({
      method: 'GET',
      url: '/v1/notifications?unread=true',
      headers: adminHeaders,
    });
    const adminBody = adminList.json() as { items: { id: string }[]; unreadCount: number };
    assert.ok(adminBody.unreadCount >= 1);

    const viewerList = await harness.app.inject({
      method: 'GET',
      url: '/v1/notifications',
      headers: viewerHeaders,
    });
    const viewerBody = viewerList.json() as { items: unknown[] };
    assert.equal(viewerBody.items.length, 0, 'viewers were not in the audience');

    // Reading someone else's notification is a 404, not a state change.
    const foreignRead = await harness.app.inject({
      method: 'POST',
      url: `/v1/notifications/${adminBody.items[0]!.id}/read`,
      headers: viewerHeaders,
      payload: {},
    });
    assert.equal(foreignRead.statusCode, 404, foreignRead.body);

    const read = await harness.app.inject({
      method: 'POST',
      url: `/v1/notifications/${adminBody.items[0]!.id}/read`,
      headers: adminHeaders,
      payload: {},
    });
    assert.equal(read.statusCode, 200, read.body);
  });
});

describe('team operations', () => {
  it('lists members with role, MFA and session posture', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/members',
      headers: adminHeaders,
    });
    assert.equal(response.statusCode, 200, response.body);
    const { items } = response.json() as {
      items: { userId: string; role: string; mfaEnabled: boolean; activeSessions: number }[];
    };
    const self = items.find((member) => member.userId === adminUserId);
    assert.ok(self, 'the admin appears in the list');
    assert.equal(typeof self!.mfaEnabled, 'boolean');
    assert.ok(self!.activeSessions >= 1, 'their own session counts');
  });

  it('viewers cannot read the member list', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/members',
      headers: viewerHeaders,
    });
    assert.equal(response.statusCode, 403, response.body);
  });

  it('invites create an invited user without a usable password', async () => {
    const email = `invitee-${randomUUID().slice(0, 8)}@example.test`;
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/members/invite',
      headers: adminHeaders,
      payload: { email, fullName: 'Invited Person', role: 'staff' },
    });
    assert.equal(response.statusCode, 201, response.body);
    // The response explains the set-password flow; it must never carry an
    // actual credential or token.
    const message = (response.json() as { message: string }).message;
    assert.ok(!/token|hash|[A-Za-z0-9+/]{32,}/.test(message), message);

    const [user] = await withoutTenantScope(harness.db, (tx) =>
      tx
        .select({ status: schema.users.status })
        .from(schema.users)
        .where(eq(schema.users.email, email)),
    );
    assert.equal(user!.status, 'invited');
  });

  it('changes a role and suspends, revoking sessions', async () => {
    const promote = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/members/${viewerUserId}`,
      headers: adminHeaders,
      payload: { role: 'staff' },
    });
    assert.equal(promote.statusCode, 200, promote.body);

    const suspend = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/members/${viewerUserId}`,
      headers: adminHeaders,
      payload: { status: 'suspended' },
    });
    assert.equal(suspend.statusCode, 200, suspend.body);

    // The suspended member's session no longer works.
    const attempt = await harness.app.inject({
      method: 'GET',
      url: '/v1/notifications',
      headers: viewerHeaders,
    });
    assert.equal(attempt.statusCode, 401, attempt.body);

    const reactivate = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/members/${viewerUserId}`,
      headers: adminHeaders,
      payload: { status: 'active' },
    });
    assert.equal(reactivate.statusCode, 200, reactivate.body);
  });

  it('refuses to demote or suspend the last owner', async () => {
    const demote = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/members/${ownerUserId}`,
      headers: adminHeaders,
      payload: { role: 'staff' },
    });
    assert.equal(demote.statusCode, 400, demote.body);
    assert.match(demote.body, /only owner/);
  });
});

describe('audit trail', () => {
  it('exposes recent entries with filters, to audit.read only', async () => {
    // Staff hold no audit.read; the suspended-then-reactivated viewer's old
    // token is revoked, so staff are the clean case for the 403.
    const denied = await harness.app.inject({
      method: 'GET',
      url: '/v1/settings/audit',
      headers: staffHeaders,
    });
    assert.equal(denied.statusCode, 403, denied.body);

    const listed = await harness.app.inject({
      method: 'GET',
      url: '/v1/settings/audit?action=member.',
      headers: adminHeaders,
    });
    assert.equal(listed.statusCode, 200, listed.body);
    const { items } = listed.json() as { items: { action: string }[] };
    assert.ok(items.length >= 1, 'the invite and role changes were audited');
    assert.ok(items.every((row) => row.action.startsWith('member.')));
  });
});
