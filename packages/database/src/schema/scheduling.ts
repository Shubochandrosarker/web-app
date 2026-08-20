import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { metadata, primaryKeyColumn, softDelete, timestamps } from './_shared.ts';
import { appointmentStatus } from './enums.ts';
import { users, workspaces } from './identity.ts';
import { locations, services, staffProfiles } from './business.ts';
import { contacts, leads } from './crm.ts';

/**
 * Scheduling.
 *
 * Availability is expressed as recurring rules plus explicit exceptions rather
 * than as pre-generated slots. Materialising a year of five-minute slots is
 * both enormous and immediately stale the moment someone changes their hours.
 * Slots are computed on read, from rules, exceptions and existing bookings.
 */

export const availabilityRules = pgTable(
  'availability_rules',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    staffProfileId: uuid('staff_profile_id').references(() => staffProfiles.id, {
      onDelete: 'cascade',
    }),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id').references(() => services.id, { onDelete: 'cascade' }),
    /** 0 = Sunday … 6 = Saturday, in the workspace's time zone. */
    weekday: smallint('weekday').notNull(),
    /** Minutes from midnight — timezone-safe and trivially comparable. */
    startMinute: integer('start_minute').notNull(),
    endMinute: integer('end_minute').notNull(),
    /** Booking granularity, e.g. 30. */
    slotMinutes: integer('slot_minutes').notNull().default(30),
    /** How many bookings may share one slot. >1 for group sessions. */
    capacity: integer('capacity').notNull().default(1),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('availability_rules_workspace_idx').on(table.workspaceId),
    index('availability_rules_staff_weekday_idx').on(table.staffProfileId, table.weekday),
  ],
);

/** Holidays, leave and one-off extra hours. Exceptions beat rules. */
export const availabilityExceptions = pgTable(
  'availability_exceptions',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    staffProfileId: uuid('staff_profile_id').references(() => staffProfiles.id, {
      onDelete: 'cascade',
    }),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    /** false = blocked out; true = extra availability outside the usual rules. */
    isAvailable: boolean('is_available').notNull().default(false),
    reason: varchar('reason', { length: 200 }),
    ...timestamps,
  },
  (table) => [
    index('availability_exceptions_range_idx').on(table.workspaceId, table.startsAt, table.endsAt),
  ],
);

export const appointments = pgTable(
  'appointments',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
    staffProfileId: uuid('staff_profile_id').references(() => staffProfiles.id, {
      onDelete: 'set null',
    }),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
    status: appointmentStatus('status').notNull().default('pending'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    /** Captured at booking: a later workspace tz change must not move bookings. */
    timeZone: varchar('time_zone', { length: 64 }).notNull(),
    /** `on_site`, `phone`, `video`, `whatsapp`. */
    channel: varchar('channel', { length: 32 }).notNull().default('on_site'),
    meetingUrl: text('meeting_url'),
    notes: text('notes'),
    /** Single-use token for the customer's reschedule/cancel page. */
    manageTokenHash: varchar('manage_token_hash', { length: 64 }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledReason: varchar('cancelled_reason', { length: 300 }),
    rescheduledFromId: uuid('rescheduled_from_id'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    metadata: metadata(),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    index('appointments_workspace_starts_idx').on(table.workspaceId, table.startsAt),
    index('appointments_staff_starts_idx').on(table.staffProfileId, table.startsAt),
    index('appointments_contact_idx').on(table.contactId),
    index('appointments_status_idx').on(table.workspaceId, table.status),
    uniqueIndex('appointments_manage_token_key')
      .on(table.manageTokenHash)
      .where(sql`${table.manageTokenHash} IS NOT NULL`),
  ],
);

/**
 * Scheduled reminders. Rows rather than in-memory timers, so a restart or a
 * deploy cannot silently drop a day of reminders.
 */
export const appointmentReminders = pgTable(
  'appointment_reminders',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointments.id, { onDelete: 'cascade' }),
    channel: varchar('channel', { length: 20 }).notNull(),
    sendAt: timestamp('send_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex('appointment_reminders_unique_key').on(
      table.appointmentId,
      table.channel,
      table.sendAt,
    ),
    // Partial index: the dispatcher only ever scans unsent reminders, so the
    // index stays small no matter how much history accumulates.
    index('appointment_reminders_due_idx')
      .on(table.sendAt)
      .where(sql`${table.sentAt} IS NULL AND ${table.failedAt} IS NULL`),
  ],
);

export const appointmentsRelations = relations(appointments, ({ one, many }) => ({
  contact: one(contacts, { fields: [appointments.contactId], references: [contacts.id] }),
  service: one(services, { fields: [appointments.serviceId], references: [services.id] }),
  staff: one(staffProfiles, {
    fields: [appointments.staffProfileId],
    references: [staffProfiles.id],
  }),
  location: one(locations, { fields: [appointments.locationId], references: [locations.id] }),
  reminders: many(appointmentReminders),
}));
