import { and, eq, gt, inArray, isNull, lt } from 'drizzle-orm';
import { schema, withoutTenantScope, type Database } from '@bos/database';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../lib/errors.ts';
import { appendOutboxEvent } from '../lib/outbox.ts';

/**
 * The scheduling engine.
 *
 * The schema stores availability as recurring rules plus explicit exceptions;
 * this module is the part that makes those rows *mean* something: bookings
 * are checked against staff conflicts, blackouts, configured hours and
 * capacity before they save, and slots are computed on read rather than
 * materialised.
 *
 * Deliberate defaults:
 *  - A workspace with **no rules at all** is unconstrained — configuring
 *    availability is opt-in, and an empty table must not brick booking.
 *  - A staff double-booking is refused even with `force`: two places at once
 *    is not an override, it is a mistake.
 *  - `force` (managers correcting reality) bypasses hours and capacity —
 *    walk-ins happen and the calendar must be able to record the truth.
 *
 * No external calendar is hardcoded anywhere: rules, exceptions and bookings
 * are first-party rows, and a provider sync would be an adapter over them.
 */

const ACTIVE_STATUSES = ['pending', 'confirmed'] as const;

interface BookingWindow {
  readonly staffProfileId?: string | null | undefined;
  readonly serviceId?: string | null | undefined;
  readonly locationId?: string | null | undefined;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly timeZone: string;
  readonly excludeAppointmentId?: string | undefined;
  readonly force?: boolean | undefined;
}

const WEEKDAYS: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Weekday (0=Sunday) and minutes-from-midnight of an instant, in a zone. */
export function zonedParts(instant: Date, timeZone: string): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const weekday = WEEKDAYS[get('weekday')];
  if (weekday === undefined) throw ApiError.badRequest(`Unusable time zone "${timeZone}".`);
  return { weekday, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** The UTC instant of local midnight + `minutes` on `date` in a zone. */
export function zonedInstant(date: string, minutes: number, timeZone: string): Date {
  // First guess assumes the zone offset at UTC midnight, then correct once —
  // enough for real zones including DST transitions at 30/45-minute offsets.
  const guess = new Date(`${date}T00:00:00Z`);
  const correct = (candidate: Date): Date => {
    const local = zonedParts(candidate, timeZone);
    const localDate = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(candidate);
    let drift = local.minutes - minutes;
    if (localDate < date) drift -= 1440;
    if (localDate > date) drift += 1440;
    return new Date(candidate.getTime() - drift * 60_000);
  };
  return correct(correct(new Date(guess.getTime() + minutes * 60_000)));
}

function scopeMatches(
  rule: { staffProfileId: string | null; serviceId: string | null; locationId: string | null },
  window: BookingWindow,
): boolean {
  // A null on the rule means "applies to any"; a set value must match.
  if (rule.staffProfileId && rule.staffProfileId !== (window.staffProfileId ?? null)) return false;
  if (rule.serviceId && rule.serviceId !== (window.serviceId ?? null)) return false;
  if (rule.locationId && rule.locationId !== (window.locationId ?? null)) return false;
  return true;
}

/**
 * Refuse a booking that cannot happen. Runs inside the booking transaction so
 * a concurrent booking pair is serialised by the row locks of the insert that
 * follows — small-business booking volumes, not ticketing.
 */
export async function assertBookable(tx: Database, window: BookingWindow): Promise<void> {
  /* 1 — a person cannot be in two appointments at once, force or no force. */
  if (window.staffProfileId) {
    const overlap = await tx
      .select({ id: schema.appointments.id })
      .from(schema.appointments)
      .where(
        and(
          eq(schema.appointments.staffProfileId, window.staffProfileId),
          inArray(schema.appointments.status, [...ACTIVE_STATUSES]),
          isNull(schema.appointments.deletedAt),
          lt(schema.appointments.startsAt, window.endsAt),
          gt(schema.appointments.endsAt, window.startsAt),
        ),
      )
      .limit(2);
    const conflicting = overlap.filter((row) => row.id !== window.excludeAppointmentId);
    if (conflicting.length > 0) {
      throw ApiError.conflict('That staff member already has an appointment in this window.');
    }
  }

  /* 2 — blackouts beat everything except an explicit force. */
  const exceptions = await tx
    .select()
    .from(schema.availabilityExceptions)
    .where(
      and(
        lt(schema.availabilityExceptions.startsAt, window.endsAt),
        gt(schema.availabilityExceptions.endsAt, window.startsAt),
      ),
    );
  const scoped = exceptions.filter(
    (exception) =>
      (!exception.staffProfileId || exception.staffProfileId === (window.staffProfileId ?? null)) &&
      (!exception.locationId || exception.locationId === (window.locationId ?? null)),
  );
  const blocked = scoped.some((exception) => !exception.isAvailable);
  if (blocked && !window.force) {
    throw ApiError.conflict(
      'This window is blocked out (holiday or leave). Use force to override.',
    );
  }
  if (window.force) return;

  /* 3 — configured hours and capacity, only once any rules exist. */
  const rules = await tx.select().from(schema.availabilityRules);
  if (rules.length === 0) return;

  const start = zonedParts(window.startsAt, window.timeZone);
  const end = zonedParts(window.endsAt, window.timeZone);
  const sameDay = window.endsAt.getTime() - window.startsAt.getTime() < 24 * 3600_000;
  const endMinutes = end.minutes === 0 && sameDay ? 1440 : end.minutes;

  const extraOpen = scoped.some((exception) => exception.isAvailable);
  const matching = rules.filter(
    (rule) =>
      scopeMatches(rule, window) &&
      rule.weekday === start.weekday &&
      rule.startMinute <= start.minutes &&
      rule.endMinute >= endMinutes &&
      start.weekday === end.weekday &&
      (!rule.effectiveFrom || rule.effectiveFrom <= window.startsAt) &&
      (!rule.effectiveTo || rule.effectiveTo >= window.endsAt),
  );

  if (matching.length === 0 && !extraOpen) {
    throw ApiError.conflict(
      'This time is outside the configured availability. Adjust the rules under ' +
        'Appointments → Availability, or use force for a deliberate exception.',
    );
  }

  if (matching.length > 0) {
    const capacity = Math.max(...matching.map((rule) => rule.capacity));
    const conditions = [
      inArray(schema.appointments.status, [...ACTIVE_STATUSES]),
      isNull(schema.appointments.deletedAt),
      lt(schema.appointments.startsAt, window.endsAt),
      gt(schema.appointments.endsAt, window.startsAt),
    ];
    const overlapping = await tx
      .select({ id: schema.appointments.id })
      .from(schema.appointments)
      .where(and(...conditions))
      .limit(capacity + 2);
    const others = overlapping.filter((row) => row.id !== window.excludeAppointmentId);
    if (others.length >= capacity) {
      throw ApiError.conflict(
        `This window is fully booked (capacity ${capacity}). Pick another slot or use force.`,
      );
    }
  }
}

export interface Slot {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly capacity: number;
  readonly booked: number;
  readonly available: number;
}

/** Compute one day's bookable slots from rules − blackouts − bookings. */
export async function computeSlots(
  tx: Database,
  input: {
    readonly date: string;
    readonly timeZone: string;
    readonly serviceId?: string | undefined;
    readonly staffProfileId?: string | undefined;
    readonly locationId?: string | undefined;
  },
): Promise<Slot[]> {
  const dayStart = zonedInstant(input.date, 0, input.timeZone);
  const dayEnd = zonedInstant(input.date, 1440, input.timeZone);
  const weekday = zonedParts(new Date(dayStart.getTime() + 12 * 3600_000), input.timeZone).weekday;

  const window: BookingWindow = {
    staffProfileId: input.staffProfileId ?? null,
    serviceId: input.serviceId ?? null,
    locationId: input.locationId ?? null,
    startsAt: dayStart,
    endsAt: dayEnd,
    timeZone: input.timeZone,
  };

  const rules = (await tx.select().from(schema.availabilityRules)).filter(
    (rule) =>
      scopeMatches(rule, window) &&
      rule.weekday === weekday &&
      (!rule.effectiveFrom || rule.effectiveFrom <= dayEnd) &&
      (!rule.effectiveTo || rule.effectiveTo >= dayStart),
  );
  if (rules.length === 0) return [];

  const exceptions = (
    await tx
      .select()
      .from(schema.availabilityExceptions)
      .where(
        and(
          lt(schema.availabilityExceptions.startsAt, dayEnd),
          gt(schema.availabilityExceptions.endsAt, dayStart),
        ),
      )
  ).filter(
    (exception) =>
      (!exception.staffProfileId || exception.staffProfileId === (input.staffProfileId ?? null)) &&
      (!exception.locationId || exception.locationId === (input.locationId ?? null)),
  );
  const blackouts = exceptions.filter((exception) => !exception.isAvailable);

  const bookings = await tx
    .select({
      id: schema.appointments.id,
      startsAt: schema.appointments.startsAt,
      endsAt: schema.appointments.endsAt,
    })
    .from(schema.appointments)
    .where(
      and(
        inArray(schema.appointments.status, [...ACTIVE_STATUSES]),
        isNull(schema.appointments.deletedAt),
        lt(schema.appointments.startsAt, dayEnd),
        gt(schema.appointments.endsAt, dayStart),
      ),
    );

  const slots: Slot[] = [];
  for (const rule of rules) {
    for (
      let minute = rule.startMinute;
      minute + rule.slotMinutes <= rule.endMinute;
      minute += rule.slotMinutes
    ) {
      const startsAt = zonedInstant(input.date, minute, input.timeZone);
      const endsAt = zonedInstant(input.date, minute + rule.slotMinutes, input.timeZone);
      const blackedOut = blackouts.some(
        (blackout) => blackout.startsAt < endsAt && blackout.endsAt > startsAt,
      );
      if (blackedOut) continue;
      const booked = bookings.filter(
        (booking) => booking.startsAt < endsAt && booking.endsAt > startsAt,
      ).length;
      slots.push({
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        capacity: rule.capacity,
        booked,
        available: Math.max(0, rule.capacity - booked),
      });
    }
  }
  return slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** Reminder offsets before the start, in minutes. 24 hours and 2 hours out. */
const REMINDER_OFFSETS_MINUTES = [24 * 60, 2 * 60] as const;

/**
 * (Re)schedule reminder rows for an appointment. Rows, not timers: a deploy
 * cannot drop them. Delivery happens when the dispatcher turns a due row
 * into an `appointment.reminder_due` event.
 */
export async function scheduleReminders(
  tx: Database,
  workspaceId: string,
  appointment: { readonly id: string; readonly startsAt: Date },
): Promise<void> {
  await cancelReminders(tx, appointment.id);
  const now = Date.now();
  const rows = REMINDER_OFFSETS_MINUTES.map((offset) => ({
    workspaceId,
    appointmentId: appointment.id,
    channel: 'email',
    sendAt: new Date(appointment.startsAt.getTime() - offset * 60_000),
  })).filter((row) => row.sendAt.getTime() > now);
  if (rows.length > 0) {
    await tx.insert(schema.appointmentReminders).values(rows).onConflictDoNothing();
  }
}

/** Drop reminders that have not been sent — used on reschedule and cancel. */
export async function cancelReminders(tx: Database, appointmentId: string): Promise<void> {
  await tx
    .delete(schema.appointmentReminders)
    .where(
      and(
        eq(schema.appointmentReminders.appointmentId, appointmentId),
        isNull(schema.appointmentReminders.sentAt),
        isNull(schema.appointmentReminders.failedAt),
      ),
    );
}

/**
 * Turn due reminder rows into outbox events. Cross-tenant by design (one
 * sweep serves every workspace), so it runs without tenant scope and stamps
 * each event with the reminder's own workspace.
 */
export async function dispatchDueReminders(db: Database, limit = 50): Promise<number> {
  return withoutTenantScope(db, async (tx) => {
    const due = await tx
      .select({
        id: schema.appointmentReminders.id,
        workspaceId: schema.appointmentReminders.workspaceId,
        appointmentId: schema.appointmentReminders.appointmentId,
        channel: schema.appointmentReminders.channel,
        sendAt: schema.appointmentReminders.sendAt,
        startsAt: schema.appointments.startsAt,
        status: schema.appointments.status,
      })
      .from(schema.appointmentReminders)
      .innerJoin(
        schema.appointments,
        eq(schema.appointments.id, schema.appointmentReminders.appointmentId),
      )
      .where(
        and(
          isNull(schema.appointmentReminders.sentAt),
          isNull(schema.appointmentReminders.failedAt),
          lt(schema.appointmentReminders.sendAt, new Date()),
        ),
      )
      .limit(limit);

    let dispatched = 0;
    for (const reminder of due) {
      const active = reminder.status === 'pending' || reminder.status === 'confirmed';
      await tx
        .update(schema.appointmentReminders)
        .set(
          active
            ? { sentAt: new Date() }
            : { failedAt: new Date(), failureReason: `appointment ${reminder.status}` },
        )
        .where(eq(schema.appointmentReminders.id, reminder.id));
      if (!active) continue;

      await appendOutboxEvent(tx, reminder.workspaceId, {
        name: 'appointment.reminder_due',
        correlationId: randomUUID(),
        idempotencyKey: `appointment.reminder:${reminder.id}`,
        payload: {
          appointmentId: reminder.appointmentId,
          channel: reminder.channel,
          startsAt: reminder.startsAt.toISOString(),
        },
      });
      dispatched += 1;
    }
    return dispatched;
  });
}
