import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace } from '@bos/database';
import { ApiError } from '../lib/errors.ts';
import { requirePermission } from '../lib/permissions.ts';
import { hasPermission, requestContext, requireUserId, requireWorkspace } from '../lib/context.ts';
import {
  buildPage,
  cursorCondition,
  decodeCursor,
  orderFor,
  withCursor,
} from '../lib/pagination.ts';
import { appendOutboxEvent } from '../lib/outbox.ts';
import { listPipelines } from '../services/leads.ts';
import type { AppContext } from '../app.ts';

/**
 * The CRM the staff actually work from.
 *
 * Scope is the daily job and nothing beyond it: see the enquiries, read one,
 * move it along the pipeline, assign it, leave a note, add a task. Everything
 * a NuESheba member of staff does between a form submission and a completed
 * service, and nothing that only a reporting dashboard would want.
 */

const leadListQuery = z.object({
  status: z.enum(['open', 'won', 'lost', 'archived']).optional(),
  stageId: z.uuid().optional(),
  assignedToUserId: z.uuid().optional(),
  /** `me` is resolved server-side so the client never needs its own user id. */
  assigned: z.enum(['me', 'unassigned']).optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(512).optional(),
});

export function registerCrmRoutes(app: FastifyInstance, context: AppContext): void {
  const { db, auth } = context;

  /* ------------------------------------------------------------- pipelines */

  app.get(
    '/v1/crm/pipelines',
    { config: { bosAccess: requirePermission('leads.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      return { pipelines: await listPipelines(db, workspace.workspaceId) };
    },
  );

  /* ----------------------------------------------------------------- leads */

  app.get(
    '/v1/crm/leads',
    { config: { bosAccess: requirePermission('leads.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const query = leadListQuery.parse(request.query);
      const userId = requireUserId(request);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const conditions = [isNull(schema.leads.deletedAt)];
        if (query.status) conditions.push(eq(schema.leads.status, query.status));
        if (query.stageId) conditions.push(eq(schema.leads.stageId, query.stageId));
        if (query.assignedToUserId) {
          conditions.push(eq(schema.leads.assignedToUserId, query.assignedToUserId));
        }
        if (query.assigned === 'me') conditions.push(eq(schema.leads.assignedToUserId, userId));
        if (query.assigned === 'unassigned') conditions.push(isNull(schema.leads.assignedToUserId));
        if (query.search) {
          // Searches the person, not the enquiry text: staff look somebody up
          // by the name or number they have in front of them.
          conditions.push(
            sql`(${schema.contacts.fullName} ilike ${`%${query.search}%`}
              or ${schema.contacts.phone} ilike ${`%${query.search}%`}
              or ${schema.contacts.email} ilike ${`%${query.search}%`})`,
          );
        }

        const cursorClause = query.cursor
          ? cursorCondition(
              schema.leads.createdAt,
              schema.leads.id,
              decodeCursor(query.cursor),
              'desc',
            )
          : undefined;

        const rows = await tx
          .select({
            id: schema.leads.id,
            title: schema.leads.title,
            status: schema.leads.status,
            stageId: schema.leads.stageId,
            source: schema.leads.source,
            assignedToUserId: schema.leads.assignedToUserId,
            followUpAt: schema.leads.followUpAt,
            createdAt: schema.leads.createdAt,
            stageChangedAt: schema.leads.stageChangedAt,
            landingPath: schema.leads.landingPath,
            contactId: schema.contacts.id,
            contactName: schema.contacts.fullName,
            contactPhone: schema.contacts.phone,
            contactEmail: schema.contacts.email,
            serviceName: schema.services.name,
          })
          .from(schema.leads)
          .innerJoin(schema.contacts, eq(schema.contacts.id, schema.leads.contactId))
          .leftJoin(schema.services, eq(schema.services.id, schema.leads.serviceId))
          .where(withCursor(conditions, cursorClause))
          .orderBy(...orderFor(schema.leads.createdAt, schema.leads.id, 'desc'))
          .limit(query.limit + 1);

        const page = buildPage(rows, query.limit, (row) => ({
          value: row.createdAt.toISOString(),
          id: row.id,
        }));

        return {
          items: page.items.map((row) => ({
            ...row,
            createdAt: row.createdAt.toISOString(),
            stageChangedAt: row.stageChangedAt.toISOString(),
            followUpAt: row.followUpAt?.toISOString() ?? null,
          })),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
      });
    },
  );

  /**
   * One lead, with everything the detail screen shows.
   *
   * The submitted form values are included **only** for a caller who also
   * holds `forms.submissions.read`. A transcript number and a registration
   * number are in that payload, and "may work leads" is not the same decision
   * as "may read what people typed into the form".
   */
  app.get(
    '/v1/crm/leads/:id',
    { config: { bosAccess: requirePermission('leads.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const mayReadSubmissions = hasPermission(request, 'forms.submissions.read');
      const mayReadDocuments = hasPermission(request, 'documents.read');

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [row] = await tx
          .select({
            lead: schema.leads,
            contact: schema.contacts,
            serviceName: schema.services.name,
            stageName: schema.pipelineStages.name,
          })
          .from(schema.leads)
          .innerJoin(schema.contacts, eq(schema.contacts.id, schema.leads.contactId))
          .leftJoin(schema.services, eq(schema.services.id, schema.leads.serviceId))
          .leftJoin(schema.pipelineStages, eq(schema.pipelineStages.id, schema.leads.stageId))
          .where(and(eq(schema.leads.id, id), isNull(schema.leads.deletedAt)))
          .limit(1);

        if (!row) throw ApiError.hidden('Lead');

        const [activities, notes, tasks, submission, documents] = await Promise.all([
          tx
            .select({
              id: schema.activities.id,
              type: schema.activities.type,
              summary: schema.activities.summary,
              occurredAt: schema.activities.occurredAt,
              actorUserId: schema.activities.actorUserId,
            })
            .from(schema.activities)
            .where(eq(schema.activities.leadId, id))
            .orderBy(desc(schema.activities.occurredAt))
            .limit(100),

          tx
            .select({
              id: schema.notes.id,
              body: schema.notes.body,
              authorId: schema.notes.authorId,
              createdAt: schema.notes.createdAt,
            })
            .from(schema.notes)
            .where(
              and(
                eq(schema.notes.entityType, 'lead'),
                eq(schema.notes.entityId, id),
                isNull(schema.notes.deletedAt),
              ),
            )
            .orderBy(desc(schema.notes.createdAt))
            .limit(100),

          tx
            .select({
              id: schema.tasks.id,
              title: schema.tasks.title,
              status: schema.tasks.status,
              dueAt: schema.tasks.dueAt,
              assignedToUserId: schema.tasks.assignedToUserId,
            })
            .from(schema.tasks)
            .where(
              and(
                eq(schema.tasks.entityType, 'lead'),
                eq(schema.tasks.entityId, id),
                isNull(schema.tasks.deletedAt),
              ),
            )
            .orderBy(asc(schema.tasks.dueAt))
            .limit(50),

          mayReadSubmissions
            ? tx
                .select({
                  id: schema.formSubmissions.id,
                  payload: schema.formSubmissions.payload,
                  createdAt: schema.formSubmissions.createdAt,
                })
                .from(schema.formSubmissions)
                .where(eq(schema.formSubmissions.leadId, id))
                .limit(1)
            : Promise.resolve([]),

          mayReadDocuments
            ? tx
                .select({
                  id: schema.documents.id,
                  kind: schema.documents.kind,
                  // `objectKey` is deliberately absent. Nothing outside the
                  // download endpoint ever needs it, and a key in a JSON
                  // response is a key in a browser's history.
                  originalFilename: schema.documents.originalFilename,
                  mimeType: schema.documents.mimeType,
                  sizeBytes: schema.documents.sizeBytes,
                  status: schema.documents.status,
                  createdAt: schema.documents.createdAt,
                })
                .from(schema.documents)
                .where(and(eq(schema.documents.leadId, id), isNull(schema.documents.deletedAt)))
                .limit(20)
            : Promise.resolve([]),
        ]);

        return {
          lead: {
            ...row.lead,
            createdAt: row.lead.createdAt.toISOString(),
            updatedAt: row.lead.updatedAt.toISOString(),
            stageChangedAt: row.lead.stageChangedAt.toISOString(),
            followUpAt: row.lead.followUpAt?.toISOString() ?? null,
            closedAt: row.lead.closedAt?.toISOString() ?? null,
          },
          contact: {
            id: row.contact.id,
            fullName: row.contact.fullName,
            email: row.contact.email,
            phone: row.contact.phone,
            whatsapp: row.contact.whatsapp,
            locale: row.contact.locale,
            createdAt: row.contact.createdAt.toISOString(),
          },
          serviceName: row.serviceName,
          stageName: row.stageName,
          activities: activities.map((entry) => ({
            ...entry,
            occurredAt: entry.occurredAt.toISOString(),
          })),
          notes: notes.map((note) => ({ ...note, createdAt: note.createdAt.toISOString() })),
          tasks: tasks.map((task) => ({ ...task, dueAt: task.dueAt?.toISOString() ?? null })),
          submission: submission[0]
            ? { ...submission[0], createdAt: submission[0].createdAt.toISOString() }
            : null,
          documents: documents.map((doc) => ({ ...doc, createdAt: doc.createdAt.toISOString() })),
        };
      });
    },
  );

  /* ------------------------------------------------------- update a lead */

  const leadUpdate = z.object({
    stageId: z.uuid().nullable().optional(),
    status: z.enum(['open', 'won', 'lost', 'archived']).optional(),
    assignedToUserId: z.uuid().nullable().optional(),
    followUpAt: z.iso.datetime({ offset: true }).nullable().optional(),
    lostReason: z.string().max(300).nullable().optional(),
    title: z.string().max(300).optional(),
    valueAmount: z.number().int().nonnegative().nullable().optional(),
    valueCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable()
      .optional(),
  });

  app.patch(
    '/v1/crm/leads/:id',
    { config: { bosAccess: requirePermission('leads.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const input = leadUpdate.parse(request.body);
      const userId = requireUserId(request);

      // Reassignment is a separate decision from working a lead, so it needs
      // its own permission even though it arrives on the same endpoint.
      if (input.assignedToUserId !== undefined && !hasPermission(request, 'leads.assign')) {
        throw ApiError.forbidden();
      }

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [existing] = await tx
          .select()
          .from(schema.leads)
          .where(and(eq(schema.leads.id, id), isNull(schema.leads.deletedAt)))
          .limit(1);

        if (!existing) throw ApiError.hidden('Lead');

        // A stage from another pipeline — or another tenant — would silently
        // put the lead somewhere the board cannot show it.
        if (input.stageId) {
          const [stage] = await tx
            .select({ id: schema.pipelineStages.id })
            .from(schema.pipelineStages)
            .where(eq(schema.pipelineStages.id, input.stageId))
            .limit(1);
          if (!stage) throw ApiError.badRequest('That stage does not exist in this workspace.');
        }

        if (input.assignedToUserId) {
          const [member] = await tx
            .select({ id: schema.workspaceMembers.id })
            .from(schema.workspaceMembers)
            .where(
              and(
                eq(schema.workspaceMembers.workspaceId, workspace.workspaceId),
                eq(schema.workspaceMembers.userId, input.assignedToUserId),
              ),
            )
            .limit(1);
          if (!member) throw ApiError.badRequest('That person is not a member of this workspace.');
        }

        const stageChanged = input.stageId !== undefined && input.stageId !== existing.stageId;
        const statusChanged = input.status !== undefined && input.status !== existing.status;
        const closing = input.status === 'won' || input.status === 'lost';

        await tx
          .update(schema.leads)
          .set({
            ...(input.stageId !== undefined ? { stageId: input.stageId } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.assignedToUserId !== undefined
              ? { assignedToUserId: input.assignedToUserId }
              : {}),
            ...(input.followUpAt !== undefined
              ? { followUpAt: input.followUpAt ? new Date(input.followUpAt) : null }
              : {}),
            ...(input.lostReason !== undefined ? { lostReason: input.lostReason } : {}),
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.valueAmount !== undefined ? { valueAmount: input.valueAmount } : {}),
            ...(input.valueCurrency !== undefined ? { valueCurrency: input.valueCurrency } : {}),
            ...(stageChanged ? { stageChangedAt: new Date() } : {}),
            ...(closing ? { closedAt: new Date() } : {}),
            updatedAt: new Date(),
          })
          .where(eq(schema.leads.id, id));

        // The timeline is the record of what happened, so a stage move writes
        // an activity rather than only mutating a column — otherwise "who
        // moved this and when" is unanswerable.
        if (stageChanged || statusChanged) {
          await tx.insert(schema.activities).values({
            workspaceId: workspace.workspaceId,
            contactId: existing.contactId,
            leadId: id,
            type: stageChanged ? 'lead.stage_changed' : 'lead.status_changed',
            summary: stageChanged ? 'Stage changed' : `Marked ${input.status}`,
            detail: {
              from: stageChanged ? existing.stageId : existing.status,
              to: stageChanged ? input.stageId : input.status,
            },
            actorUserId: userId,
          });

          await appendOutboxEvent(tx, workspace.workspaceId, {
            name: stageChanged ? 'lead.stage_changed' : 'lead.status_changed',
            correlationId: randomUUID(),
            // The moment is part of the key: two genuine stage moves are two
            // events, while a retry of one is not.
            idempotencyKey: `lead.moved:${id}:${Date.now()}`,
            actorUserId: userId,
            payload: { leadId: id, stageId: input.stageId ?? null, status: input.status ?? null },
          });
        }

        if (input.assignedToUserId !== undefined) {
          await tx.insert(schema.activities).values({
            workspaceId: workspace.workspaceId,
            contactId: existing.contactId,
            leadId: id,
            type: 'lead.assigned',
            summary: input.assignedToUserId ? 'Assigned' : 'Unassigned',
            detail: { assignedToUserId: input.assignedToUserId },
            actorUserId: userId,
          });
        }

        return { id, updated: true };
      });
    },
  );

  /* ----------------------------------------------------------------- notes */

  app.post(
    '/v1/crm/leads/:id/notes',
    { config: { bosAccess: requirePermission('leads.write') } },
    async (request, reply) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const body = z.object({ body: z.string().min(1).max(10_000) }).parse(request.body);
      const userId = requireUserId(request);

      const noteId = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [lead] = await tx
          .select({ contactId: schema.leads.contactId })
          .from(schema.leads)
          .where(and(eq(schema.leads.id, id), isNull(schema.leads.deletedAt)))
          .limit(1);

        if (!lead) throw ApiError.hidden('Lead');

        const [note] = await tx
          .insert(schema.notes)
          .values({
            workspaceId: workspace.workspaceId,
            entityType: 'lead',
            entityId: id,
            // Stored as plain text and rendered as plain text. A note is not
            // published content and has no reason to accept markup.
            body: body.body,
            authorId: userId,
          })
          .returning({ id: schema.notes.id });

        await tx.insert(schema.activities).values({
          workspaceId: workspace.workspaceId,
          contactId: lead.contactId,
          leadId: id,
          type: 'note.added',
          summary: body.body.slice(0, 120),
          detail: { noteId: note!.id },
          actorUserId: userId,
        });

        return note!.id;
      });

      return reply.status(201).send({ id: noteId });
    },
  );

  /* ----------------------------------------------------------------- tasks */

  app.post(
    '/v1/crm/leads/:id/tasks',
    { config: { bosAccess: requirePermission('tasks.write') } },
    async (request, reply) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const body = z
        .object({
          title: z.string().min(1).max(300),
          dueAt: z.iso.datetime({ offset: true }).optional(),
          assignedToUserId: z.uuid().optional(),
        })
        .parse(request.body);
      const userId = requireUserId(request);

      const taskId = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [task] = await tx
          .insert(schema.tasks)
          .values({
            workspaceId: workspace.workspaceId,
            title: body.title,
            entityType: 'lead',
            entityId: id,
            ...(body.dueAt ? { dueAt: new Date(body.dueAt) } : {}),
            assignedToUserId: body.assignedToUserId ?? userId,
            createdBy: userId,
          })
          .returning({ id: schema.tasks.id });
        return task!.id;
      });

      return reply.status(201).send({ id: taskId });
    },
  );

  app.patch(
    '/v1/crm/tasks/:id',
    { config: { bosAccess: requirePermission('tasks.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const body = z
        .object({ status: z.enum(['open', 'in_progress', 'done', 'cancelled']) })
        .parse(request.body);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const updated = await tx
          .update(schema.tasks)
          .set({
            status: body.status,
            completedAt: body.status === 'done' ? new Date() : null,
            updatedAt: new Date(),
          })
          .where(and(eq(schema.tasks.id, id), isNull(schema.tasks.deletedAt)))
          .returning({ id: schema.tasks.id });

        if (updated.length === 0) throw ApiError.hidden('Task');
        return { id, status: body.status };
      });
    },
  );

  /* -------------------------------------------------------------- contacts */

  app.get(
    '/v1/crm/contacts/:id',
    { config: { bosAccess: requirePermission('contacts.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [contact] = await tx
          .select()
          .from(schema.contacts)
          .where(and(eq(schema.contacts.id, id), isNull(schema.contacts.deletedAt)))
          .limit(1);

        if (!contact) throw ApiError.hidden('Contact');

        const [leads, activities] = await Promise.all([
          tx
            .select({
              id: schema.leads.id,
              title: schema.leads.title,
              status: schema.leads.status,
              createdAt: schema.leads.createdAt,
            })
            .from(schema.leads)
            .where(and(eq(schema.leads.contactId, id), isNull(schema.leads.deletedAt)))
            .orderBy(desc(schema.leads.createdAt))
            .limit(50),

          tx
            .select({
              id: schema.activities.id,
              type: schema.activities.type,
              summary: schema.activities.summary,
              occurredAt: schema.activities.occurredAt,
            })
            .from(schema.activities)
            .where(eq(schema.activities.contactId, id))
            .orderBy(desc(schema.activities.occurredAt))
            .limit(100),
        ]);

        return {
          contact: {
            id: contact.id,
            fullName: contact.fullName,
            email: contact.email,
            phone: contact.phone,
            whatsapp: contact.whatsapp,
            locale: contact.locale,
            marketingConsentAt: contact.marketingConsentAt?.toISOString() ?? null,
            createdAt: contact.createdAt.toISOString(),
            lastActivityAt: contact.lastActivityAt?.toISOString() ?? null,
          },
          leads: leads.map((lead) => ({ ...lead, createdAt: lead.createdAt.toISOString() })),
          activities: activities.map((entry) => ({
            ...entry,
            occurredAt: entry.occurredAt.toISOString(),
          })),
        };
      });
    },
  );

  /* --------------------------------------------------------------- members */

  /** Who a lead can be assigned to. Names and ids only — no email addresses. */
  app.get(
    '/v1/crm/assignees',
    { config: { bosAccess: requirePermission('leads.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);

      const rows = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const members = await tx
          .select({ userId: schema.workspaceMembers.userId, role: schema.workspaceMembers.role })
          .from(schema.workspaceMembers)
          .where(eq(schema.workspaceMembers.workspaceId, workspace.workspaceId))
          .limit(200);
        return members;
      });

      if (rows.length === 0) return { assignees: [] };

      // `users` is not tenant-scoped — a person can belong to several
      // workspaces — so the name lookup runs outside the tenant transaction,
      // restricted to the ids the membership query already authorised.
      const names = await context.db
        .select({ id: schema.users.id, fullName: schema.users.fullName })
        .from(schema.users)
        .where(
          inArray(
            schema.users.id,
            rows.map((row) => row.userId),
          ),
        );

      const byId = new Map(names.map((row) => [row.id, row.fullName]));

      return {
        assignees: rows.map((row) => ({
          userId: row.userId,
          role: row.role,
          fullName: byId.get(row.userId) ?? 'Unknown',
        })),
      };
    },
  );

  /* ----------------------------------------------------------------- audit */

  app.get(
    '/v1/crm/audit',
    { config: { bosAccess: requirePermission('audit.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(200).default(100) })
        .parse(request.query);

      const rows = await withWorkspace(db, workspace.workspaceId, async (tx) =>
        tx
          .select()
          .from(schema.auditLog)
          .where(eq(schema.auditLog.workspaceId, workspace.workspaceId))
          .orderBy(desc(schema.auditLog.createdAt))
          .limit(query.limit),
      );

      await auth.audit(
        workspace.workspaceId,
        requireUserId(request),
        'audit.read',
        requestContext(request),
        {},
      );

      return {
        items: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      };
    },
  );
}
