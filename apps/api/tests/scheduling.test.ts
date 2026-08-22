import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { schema, withoutTenantScope } from '@bos/database';
import { dispatchDueReminders, zonedInstant, zonedParts } from '../src/services/scheduling.ts';
import { authHeaders, createHarness, createMember, login, type Harness } from './helpers.ts';

/**
 * The scheduling engine: configured hours, capacity, blackouts, staff
 * conflicts and reminders — enforced at booking time, computed at read time.
 */

let harness: Harness;
let managerHeaders: Record<string, string>;
let contactId: string;
let staffProfileId: string;

/** Next occurrence of a weekday (0=Sunday) at a given UTC hour. */
function nextWeekdayAt(weekday: number, hourUtc: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 7 + ((weekday - date.getUTCDay() + 7) % 7));
  date.setUTCHours(hourUtc, 0, 0, 0);
  return date;
}

async function book(payload: Record<string, unknown>) {
  return harness.app.inject({
    method: 'POST',
    url: '/v1/appointments',
    headers: managerHeaders,
    payload: {
      contactId,
      timeZone: 'UTC',
      ...payload,
    },
  });
}

before(async () => {
  harness = await createHarness();
  const manager = await createMember(harness, 'manager');
  managerHeaders = authHeaders(harness, (await login(harness, manager.email)).accessToken);

  await withoutTenantScope(harness.db, async (tx) => {
    const [contact] = await tx
      .insert(schema.contacts)
      .values({ workspaceId: harness.workspaceId, fullName: 'Booking contact' })
      .returning({ id: schema.contacts.id });
    contactId = contact!.id;
    const [staff] = await tx
      .insert(schema.staffProfiles)
      .values({
        workspaceId: harness.workspaceId,
        fullName: 'Dr Booking',
        slug: `staff-${randomUUID().slice(0, 8)}`,
      })
      .returning({ id: schema.staffProfiles.id });
    staffProfileId = staff!.id;
  });
});

after(async () => {
  await harness?.close();
});

describe('time zone helpers', () => {
  it('computes weekday and minutes in a named zone', () => {
    // 2026-01-05 is a Monday; 09:30 in Dhaka is 03:30 UTC.
    const instant = new Date('2026-01-05T03:30:00Z');
    const parts = zonedParts(instant, 'Asia/Dhaka');
    assert.equal(parts.weekday, 1);
    assert.equal(parts.minutes, 9 * 60 + 30);
  });

  it('inverts back to the same instant', () => {
    const instant = zonedInstant('2026-01-05', 9 * 60 + 30, 'Asia/Dhaka');
    assert.equal(instant.toISOString(), '2026-01-05T03:30:00.000Z');
  });
});

describe('booking enforcement', () => {
  it('is unconstrained while no rules exist, then enforces hours once they do', async () => {
    // Tuesday 03:00–04:00 UTC — no rules yet, so it books.
    const start = nextWeekdayAt(2, 3);
    const free = await book({
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 3600_000).toISOString(),
    });
    assert.equal(free.statusCode, 200, free.body);

    // Configure Tuesday 09:00–17:00 with capacity 1.
    const rule = await harness.app.inject({
      method: 'POST',
      url: '/v1/availability/rules',
      headers: managerHeaders,
      payload: { weekday: 2, startMinute: 9 * 60, endMinute: 17 * 60, capacity: 1 },
    });
    assert.equal(rule.statusCode, 200, rule.body);

    // 03:00 UTC on a Tuesday is now outside hours.
    const outside = await book({
      startsAt: nextWeekdayAt(2, 3).toISOString(),
      endsAt: new Date(nextWeekdayAt(2, 3).getTime() + 1800_000).toISOString(),
    });
    assert.equal(outside.statusCode, 409, outside.body);

    // 10:00–10:30 UTC fits and books.
    const inHours = nextWeekdayAt(2, 10);
    const booked = await book({
      startsAt: inHours.toISOString(),
      endsAt: new Date(inHours.getTime() + 1800_000).toISOString(),
    });
    assert.equal(booked.statusCode, 200, booked.body);

    // The same window again is full (capacity 1).
    const full = await book({
      startsAt: inHours.toISOString(),
      endsAt: new Date(inHours.getTime() + 1800_000).toISOString(),
    });
    assert.equal(full.statusCode, 409, full.body);
    assert.match(full.body, /fully booked/);

    // A manager recording reality forces past capacity.
    const forced = await book({
      startsAt: inHours.toISOString(),
      endsAt: new Date(inHours.getTime() + 1800_000).toISOString(),
      force: true,
    });
    assert.equal(forced.statusCode, 200, forced.body);

    // Slots for that Tuesday report the overbooked window as unavailable.
    const date = inHours.toISOString().slice(0, 10);
    const slots = await harness.app.inject({
      method: 'GET',
      url: `/v1/availability/slots?date=${date}&timeZone=UTC`,
      headers: managerHeaders,
    });
    assert.equal(slots.statusCode, 200, slots.body);
    const body = slots.json() as { slots: { startsAt: string; available: number }[] };
    const slot = body.slots.find((candidate) => candidate.startsAt === inHours.toISOString());
    assert.ok(slot, 'the 10:00 slot exists');
    assert.equal(slot!.available, 0);
  });

  it('never lets one staff member be double-booked, even with force', async () => {
    const start = nextWeekdayAt(2, 11);
    const first = await book({
      staffProfileId,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 1800_000).toISOString(),
    });
    assert.equal(first.statusCode, 200, first.body);

    const overlap = await book({
      staffProfileId,
      startsAt: new Date(start.getTime() + 900_000).toISOString(),
      endsAt: new Date(start.getTime() + 2700_000).toISOString(),
      force: true,
    });
    assert.equal(overlap.statusCode, 409, overlap.body);
    assert.match(overlap.body, /already has an appointment/);
  });

  it('blocks a blacked-out window and honours force', async () => {
    const start = nextWeekdayAt(2, 13);
    const blackout = await harness.app.inject({
      method: 'POST',
      url: '/v1/availability/exceptions',
      headers: managerHeaders,
      payload: {
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 3600_000).toISOString(),
        isAvailable: false,
        reason: 'Public holiday',
      },
    });
    assert.equal(blackout.statusCode, 200, blackout.body);

    const refused = await book({
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 1800_000).toISOString(),
    });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.match(refused.body, /blocked out/);

    const forced = await book({
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 1800_000).toISOString(),
      force: true,
    });
    assert.equal(forced.statusCode, 200, forced.body);
  });

  it('re-checks availability on reschedule', async () => {
    const start = nextWeekdayAt(2, 14);
    const created = await book({
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 1800_000).toISOString(),
    });
    assert.equal(created.statusCode, 200, created.body);
    const id = (created.json() as { appointment: { id: string } }).appointment.id;

    // Rescheduling to 03:00 UTC (outside the Tuesday rule) is refused.
    const outside = nextWeekdayAt(2, 3);
    const moved = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/appointments/${id}`,
      headers: managerHeaders,
      payload: {
        startsAt: outside.toISOString(),
        endsAt: new Date(outside.getTime() + 1800_000).toISOString(),
      },
    });
    assert.equal(moved.statusCode, 409, moved.body);
  });
});

describe('reminders', () => {
  it('schedules reminder rows, drops them on cancel, and dispatches due ones', async () => {
    const start = nextWeekdayAt(2, 15);
    const created = await book({
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 1800_000).toISOString(),
    });
    assert.equal(created.statusCode, 200, created.body);
    const id = (created.json() as { appointment: { id: string } }).appointment.id;

    const rows = await withoutTenantScope(harness.db, (tx) =>
      tx
        .select()
        .from(schema.appointmentReminders)
        .where(eq(schema.appointmentReminders.appointmentId, id)),
    );
    assert.equal(rows.length, 2, '24h and 2h reminders');

    // Make one due and dispatch: it becomes an outbox event, exactly once.
    await withoutTenantScope(harness.db, (tx) =>
      tx
        .update(schema.appointmentReminders)
        .set({ sendAt: new Date(Date.now() - 60_000) })
        .where(eq(schema.appointmentReminders.id, rows[0]!.id)),
    );
    const dispatched = await dispatchDueReminders(harness.db);
    assert.equal(dispatched, 1);
    const again = await dispatchDueReminders(harness.db);
    assert.equal(again, 0, 'a sent reminder is not re-sent');

    const events = await withoutTenantScope(harness.db, (tx) =>
      tx
        .select({ name: schema.eventOutbox.name })
        .from(schema.eventOutbox)
        .where(eq(schema.eventOutbox.idempotencyKey, `appointment.reminder:${rows[0]!.id}`)),
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]!.name, 'appointment.reminder_due');

    // Cancelling removes the remaining unsent reminder.
    const cancelled = await harness.app.inject({
      method: 'POST',
      url: `/v1/appointments/${id}/cancel`,
      headers: managerHeaders,
      payload: { reason: 'test' },
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    const left = await withoutTenantScope(harness.db, (tx) =>
      tx
        .select()
        .from(schema.appointmentReminders)
        .where(
          and(
            eq(schema.appointmentReminders.appointmentId, id),
            isNull(schema.appointmentReminders.sentAt),
            isNull(schema.appointmentReminders.failedAt),
            lt(schema.appointmentReminders.sendAt, new Date(start.getTime())),
          ),
        ),
    );
    assert.equal(left.length, 0, 'unsent reminders are gone after cancellation');
  });
});
