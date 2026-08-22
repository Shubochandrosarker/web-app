import { and, asc, desc, eq, gte, isNull, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace, type Database } from '@bos/database';
import { ApiError } from '../lib/errors.ts';
import { requirePermission } from '../lib/permissions.ts';
import { requireUserId, requireWorkspace } from '../lib/context.ts';
import type { AppContext } from '../app.ts';

const status = z.enum(schema.appointmentStatus.enumValues);
const channel = z.enum(['on_site', 'phone', 'video', 'whatsapp']);
const appointmentInput = z.object({
  contactId: z.uuid(),
  leadId: z.uuid().nullable().optional(),
  serviceId: z.uuid().nullable().optional(),
  staffProfileId: z.uuid().nullable().optional(),
  locationId: z.uuid().nullable().optional(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  timeZone: z.string().min(1).max(64),
  channel: channel.optional(),
  meetingUrl: z.url().nullable().optional(),
  notes: z.string().max(10000).nullable().optional(),
  status: status.optional(),
});
const appointmentPatch = appointmentInput.partial().extend({
  cancelledReason: z.string().max(300).nullable().optional(),
});
const appointmentQuery = z.object({
  status: status.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

function present(row: {
  readonly appointment: typeof schema.appointments.$inferSelect;
  readonly contactName: string | null;
  readonly contactEmail: string | null;
  readonly serviceName: string | null;
  readonly locationName: string | null;
}) {
  return {
    id: row.appointment.id,
    contactId: row.appointment.contactId,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    leadId: row.appointment.leadId,
    serviceId: row.appointment.serviceId,
    serviceName: row.serviceName,
    staffProfileId: row.appointment.staffProfileId,
    locationId: row.appointment.locationId,
    locationName: row.locationName,
    status: row.appointment.status,
    startsAt: row.appointment.startsAt.toISOString(),
    endsAt: row.appointment.endsAt.toISOString(),
    timeZone: row.appointment.timeZone,
    channel: row.appointment.channel,
    meetingUrl: row.appointment.meetingUrl,
    notes: row.appointment.notes,
    cancelledAt: row.appointment.cancelledAt?.toISOString() ?? null,
    cancelledReason: row.appointment.cancelledReason,
    createdAt: row.appointment.createdAt.toISOString(),
    updatedAt: row.appointment.updatedAt.toISOString(),
  };
}

function assertTimeOrder(startsAt: string, endsAt: string): void {
  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw ApiError.badRequest('The appointment must end after it starts.');
  }
}

async function scopedAppointment(tx: Database, id: string) {
  const [row] = await tx
    .select({
      appointment: schema.appointments,
      contactName: schema.contacts.fullName,
      contactEmail: schema.contacts.email,
      serviceName: schema.services.name,
      locationName: schema.locations.displayName,
    })
    .from(schema.appointments)
    .innerJoin(schema.contacts, eq(schema.contacts.id, schema.appointments.contactId))
    .leftJoin(schema.services, eq(schema.services.id, schema.appointments.serviceId))
    .leftJoin(schema.locations, eq(schema.locations.id, schema.appointments.locationId))
    .where(and(eq(schema.appointments.id, id), isNull(schema.appointments.deletedAt)))
    .limit(1);
  return row;
}

async function assertAppointmentReferences(
  tx: Database,
  input: {
    contactId?: string | null | undefined;
    leadId?: string | null | undefined;
    serviceId?: string | null | undefined;
    staffProfileId?: string | null | undefined;
    locationId?: string | null | undefined;
  },
): Promise<void> {
  const [contact, lead, service, staff, location] = await Promise.all([
    input.contactId
      ? tx
          .select({ id: schema.contacts.id })
          .from(schema.contacts)
          .where(and(eq(schema.contacts.id, input.contactId), isNull(schema.contacts.deletedAt)))
          .limit(1)
      : Promise.resolve([]),
    input.leadId
      ? tx
          .select({ id: schema.leads.id })
          .from(schema.leads)
          .where(and(eq(schema.leads.id, input.leadId), isNull(schema.leads.deletedAt)))
          .limit(1)
      : Promise.resolve([]),
    input.serviceId
      ? tx
          .select({ id: schema.services.id })
          .from(schema.services)
          .where(and(eq(schema.services.id, input.serviceId), isNull(schema.services.deletedAt)))
          .limit(1)
      : Promise.resolve([]),
    input.staffProfileId
      ? tx
          .select({ id: schema.staffProfiles.id })
          .from(schema.staffProfiles)
          .where(
            and(
              eq(schema.staffProfiles.id, input.staffProfileId),
              isNull(schema.staffProfiles.deletedAt),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
    input.locationId
      ? tx
          .select({ id: schema.locations.id })
          .from(schema.locations)
          .where(and(eq(schema.locations.id, input.locationId), isNull(schema.locations.deletedAt)))
          .limit(1)
      : Promise.resolve([]),
  ]);

  const invalid =
    (input.contactId && contact.length === 0) ||
    (input.leadId && lead.length === 0) ||
    (input.serviceId && service.length === 0) ||
    (input.staffProfileId && staff.length === 0) ||
    (input.locationId && location.length === 0);
  if (invalid) throw ApiError.badRequest('Every linked record must belong to this workspace.');
}

export function registerAppointmentRoutes(app: FastifyInstance, context: AppContext): void {
  const { db } = context;

  app.get(
    '/v1/appointments',
    { config: { bosAccess: requirePermission('appointments.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const query = appointmentQuery.parse(request.query);
      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const conditions = [isNull(schema.appointments.deletedAt)];
        if (query.status) conditions.push(eq(schema.appointments.status, query.status));
        if (query.from) conditions.push(gte(schema.appointments.startsAt, new Date(query.from)));
        if (query.to) conditions.push(lte(schema.appointments.startsAt, new Date(query.to)));
        const rows = await tx
          .select({
            appointment: schema.appointments,
            contactName: schema.contacts.fullName,
            contactEmail: schema.contacts.email,
            serviceName: schema.services.name,
            locationName: schema.locations.displayName,
          })
          .from(schema.appointments)
          .innerJoin(schema.contacts, eq(schema.contacts.id, schema.appointments.contactId))
          .leftJoin(schema.services, eq(schema.services.id, schema.appointments.serviceId))
          .leftJoin(schema.locations, eq(schema.locations.id, schema.appointments.locationId))
          .where(and(...conditions))
          .orderBy(asc(schema.appointments.startsAt), desc(schema.appointments.createdAt))
          .limit(query.limit);
        return { items: rows.map(present) };
      });
    },
  );

  app.get(
    '/v1/appointments/:id',
    { config: { bosAccess: requirePermission('appointments.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const row = await scopedAppointment(tx, id);
        if (!row) throw ApiError.hidden('Appointment');
        return { appointment: present(row) };
      });
    },
  );

  app.post(
    '/v1/appointments',
    { config: { bosAccess: requirePermission('appointments.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const userId = requireUserId(request);
      const input = appointmentInput.parse(request.body);
      assertTimeOrder(input.startsAt, input.endsAt);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        await assertAppointmentReferences(tx, input);

        const [row] = await tx
          .insert(schema.appointments)
          .values({
            workspaceId: workspace.workspaceId,
            contactId: input.contactId,
            leadId: input.leadId ?? null,
            serviceId: input.serviceId ?? null,
            staffProfileId: input.staffProfileId ?? null,
            locationId: input.locationId ?? null,
            status: input.status ?? 'pending',
            startsAt: new Date(input.startsAt),
            endsAt: new Date(input.endsAt),
            timeZone: input.timeZone,
            channel: input.channel ?? 'on_site',
            meetingUrl: input.meetingUrl ?? null,
            notes: input.notes ?? null,
            createdByUserId: userId,
          })
          .returning({ id: schema.appointments.id });
        const appointment = await scopedAppointment(tx, row!.id);
        return { appointment: present(appointment!) };
      });
    },
  );

  app.patch(
    '/v1/appointments/:id',
    { config: { bosAccess: requirePermission('appointments.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const input = appointmentPatch.parse(request.body);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const current = await scopedAppointment(tx, id);
        if (!current) throw ApiError.hidden('Appointment');
        await assertAppointmentReferences(tx, {
          contactId: input.contactId,
          leadId: input.leadId,
          serviceId: input.serviceId,
          staffProfileId: input.staffProfileId,
          locationId: input.locationId,
        });
        const startsAt = input.startsAt ?? current.appointment.startsAt.toISOString();
        const endsAt = input.endsAt ?? current.appointment.endsAt.toISOString();
        assertTimeOrder(startsAt, endsAt);
        const now = new Date();
        const nextStatus = input.status ?? current.appointment.status;
        const [row] = await tx
          .update(schema.appointments)
          .set({
            ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
            ...(input.leadId !== undefined ? { leadId: input.leadId } : {}),
            ...(input.serviceId !== undefined ? { serviceId: input.serviceId } : {}),
            ...(input.staffProfileId !== undefined ? { staffProfileId: input.staffProfileId } : {}),
            ...(input.locationId !== undefined ? { locationId: input.locationId } : {}),
            ...(input.startsAt !== undefined ? { startsAt: new Date(input.startsAt) } : {}),
            ...(input.endsAt !== undefined ? { endsAt: new Date(input.endsAt) } : {}),
            ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
            ...(input.channel !== undefined ? { channel: input.channel } : {}),
            ...(input.meetingUrl !== undefined ? { meetingUrl: input.meetingUrl } : {}),
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.cancelledReason !== undefined
              ? { cancelledReason: input.cancelledReason }
              : {}),
            ...(nextStatus === 'cancelled'
              ? { cancelledAt: current.appointment.cancelledAt ?? now }
              : {}),
            ...(nextStatus !== 'cancelled' ? { cancelledAt: null, cancelledReason: null } : {}),
            updatedAt: now,
          })
          .where(eq(schema.appointments.id, id))
          .returning();
        const appointment = await scopedAppointment(tx, row!.id);
        return { appointment: present(appointment!) };
      });
    },
  );

  app.post(
    '/v1/appointments/:id/cancel',
    { config: { bosAccess: requirePermission('appointments.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const { reason } = z
        .object({ reason: z.string().max(300).nullable().optional() })
        .parse(request.body);
      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [row] = await tx
          .update(schema.appointments)
          .set({
            status: 'cancelled',
            cancelledAt: new Date(),
            cancelledReason: reason ?? null,
            updatedAt: new Date(),
          })
          .where(and(eq(schema.appointments.id, id), isNull(schema.appointments.deletedAt)))
          .returning({ id: schema.appointments.id });
        if (!row) throw ApiError.hidden('Appointment');
        const appointment = await scopedAppointment(tx, row.id);
        return { appointment: present(appointment!), message: 'Appointment cancelled.' };
      });
    },
  );
}
