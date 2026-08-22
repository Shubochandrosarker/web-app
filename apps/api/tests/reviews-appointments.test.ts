import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { schema, withoutTenantScope } from '@bos/database';
import {
  authHeaders,
  createHarness,
  createMember,
  createSecondaryWorkspace,
  login,
  type Harness,
} from './helpers.ts';

let harness: Harness;
let managerHeaders: Record<string, string>;
let viewerHeaders: Record<string, string>;
let contactId: string;

before(async () => {
  harness = await createHarness();
  const manager = await createMember(harness, 'manager');
  const viewer = await createMember(harness, 'viewer');
  managerHeaders = authHeaders(harness, (await login(harness, manager.email)).accessToken);
  viewerHeaders = authHeaders(harness, (await login(harness, viewer.email)).accessToken);
  contactId = await withoutTenantScope(harness.db, async (tx) => {
    const [contact] = await tx
      .insert(schema.contacts)
      .values({
        workspaceId: harness.workspaceId,
        fullName: 'Review and booking contact',
        email: `${randomUUID().slice(0, 8)}@example.test`,
      })
      .returning({ id: schema.contacts.id });
    return contact!.id;
  });
});

after(async () => {
  await harness?.close();
});

describe('reviews and appointments', () => {
  it('enforces review permissions and supports moderation', async () => {
    const denied = await harness.app.inject({
      method: 'POST',
      url: '/v1/reviews',
      headers: viewerHeaders,
      payload: { authorName: 'Nope', rating: 5 },
    });
    assert.equal(denied.statusCode, 403, denied.body);

    const created = await harness.app.inject({
      method: 'POST',
      url: '/v1/reviews',
      headers: managerHeaders,
      payload: {
        authorName: 'A real customer',
        rating: 5,
        title: 'Clear and helpful',
        body: 'The team answered every question.',
        contactId,
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const reviewId = (created.json() as { review: { id: string } }).review.id;

    const pending = await harness.app.inject({
      method: 'GET',
      url: '/v1/reviews?status=pending',
      headers: managerHeaders,
    });
    assert.equal(pending.statusCode, 200, pending.body);
    assert.equal(
      (pending.json() as { items: { id: string }[] }).items.some((row) => row.id === reviewId),
      true,
    );

    const approved = await harness.app.inject({
      method: 'POST',
      url: `/v1/reviews/${reviewId}/approve`,
      headers: managerHeaders,
      payload: {},
    });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal((approved.json() as { review: { approved: boolean } }).review.approved, true);
  });

  it('enforces appointment permissions and supports reschedule and cancellation', async () => {
    const denied = await harness.app.inject({
      method: 'POST',
      url: '/v1/appointments',
      headers: viewerHeaders,
      payload: {
        contactId,
        startsAt: '2026-08-23T10:00:00+06:00',
        endsAt: '2026-08-23T10:30:00+06:00',
        timeZone: 'Asia/Dhaka',
      },
    });
    assert.equal(denied.statusCode, 403, denied.body);

    const created = await harness.app.inject({
      method: 'POST',
      url: '/v1/appointments',
      headers: managerHeaders,
      payload: {
        contactId,
        startsAt: '2026-08-23T10:00:00+06:00',
        endsAt: '2026-08-23T10:30:00+06:00',
        timeZone: 'Asia/Dhaka',
        channel: 'phone',
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const appointmentId = (created.json() as { appointment: { id: string } }).appointment.id;

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/appointments/${appointmentId}`,
      headers: managerHeaders,
      payload: {
        status: 'confirmed',
        startsAt: '2026-08-23T11:00:00+06:00',
        endsAt: '2026-08-23T11:30:00+06:00',
      },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(
      (updated.json() as { appointment: { status: string } }).appointment.status,
      'confirmed',
    );

    const cancelled = await harness.app.inject({
      method: 'POST',
      url: `/v1/appointments/${appointmentId}/cancel`,
      headers: managerHeaders,
      payload: { reason: 'Customer requested a different day.' },
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(
      (cancelled.json() as { appointment: { status: string } }).appointment.status,
      'cancelled',
    );
  });

  it('rejects an appointment whose contact belongs to another workspace', async () => {
    const other = await createSecondaryWorkspace(harness);
    try {
      const [foreignContact] = await withoutTenantScope(harness.db, (tx) =>
        tx
          .insert(schema.contacts)
          .values({
            workspaceId: other.workspaceId,
            fullName: 'Somebody else entirely',
            email: `${randomUUID().slice(0, 8)}@example.test`,
          })
          .returning({ id: schema.contacts.id }),
      );

      const startsAt = new Date(Date.now() + 24 * 3600_000);
      const created = await harness.app.inject({
        method: 'POST',
        url: '/v1/appointments',
        headers: managerHeaders,
        payload: {
          contactId: foreignContact!.id,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + 3600_000).toISOString(),
          timeZone: 'Asia/Dhaka',
        },
      });
      assert.equal(created.statusCode, 400, created.body);
    } finally {
      await other.drop();
    }
  });

  it('rejects a review whose contact belongs to another workspace', async () => {
    const other = await createSecondaryWorkspace(harness);
    try {
      const [foreignContact] = await withoutTenantScope(harness.db, (tx) =>
        tx
          .insert(schema.contacts)
          .values({
            workspaceId: other.workspaceId,
            fullName: 'Foreign reviewer',
            email: `${randomUUID().slice(0, 8)}@example.test`,
          })
          .returning({ id: schema.contacts.id }),
      );

      const created = await harness.app.inject({
        method: 'POST',
        url: '/v1/reviews',
        headers: managerHeaders,
        payload: {
          authorName: 'Foreign reviewer',
          rating: 5,
          body: 'A review pinned to a contact from another tenant.',
          contactId: foreignContact!.id,
        },
      });
      assert.equal(created.statusCode, 400, created.body);
    } finally {
      await other.drop();
    }
  });
});
