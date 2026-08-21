import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace } from '@bos/database';
import { ApiError } from '../lib/errors.ts';
import { requirePermission } from '../lib/permissions.ts';
import { requestContext, requireUserId, requireWorkspace } from '../lib/context.ts';
import type { AppContext } from '../app.ts';

/**
 * Communications as staff see and drive them.
 *
 * The `messages` table already records every automated send with idempotency
 * and status; these routes put it in front of people — the history on a lead,
 * the channel screens with their failures — and add the one send a person
 * triggers by hand: a WhatsApp template to the enquirer.
 *
 * Free-text WhatsApp is deliberately absent. Outside the 24-hour service
 * window Meta silently drops non-template messages, which for an
 * acknowledgement is the worst failure mode there is; a template picker
 * cannot be misused into it.
 */

export function registerCommunicationRoutes(app: FastifyInstance, context: AppContext): void {
  const { db, whatsapp: whatsappProvider, config } = context;

  /* --------------------------------------------------------------- history */

  app.get(
    '/v1/crm/leads/:id/messages',
    { config: { bosAccess: requirePermission('leads.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);

      const rows = await withWorkspace(db, workspace.workspaceId, (tx) =>
        tx
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.leadId, id))
          .orderBy(desc(schema.messages.createdAt))
          .limit(100),
      );

      return { items: rows.map(serialiseMessage) };
    },
  );

  app.get(
    '/v1/crm/messages',
    { config: { bosAccess: requirePermission('leads.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const query = z
        .object({
          channel: z.enum(['email', 'whatsapp', 'sms']).optional(),
          status: z.enum(schema.messageStatus.enumValues).optional(),
          direction: z.enum(['outbound', 'inbound']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);

      const rows = await withWorkspace(db, workspace.workspaceId, (tx) =>
        tx
          .select()
          .from(schema.messages)
          .where(
            and(
              query.channel ? eq(schema.messages.channel, query.channel) : undefined,
              query.status ? eq(schema.messages.status, query.status) : undefined,
              query.direction ? eq(schema.messages.direction, query.direction) : undefined,
            ),
          )
          .orderBy(desc(schema.messages.createdAt))
          .limit(query.limit),
      );

      return { items: rows.map(serialiseMessage) };
    },
  );

  /* -------------------------------------------------------------- templates */

  app.get(
    '/v1/crm/message-templates',
    { config: { bosAccess: requirePermission('leads.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const query = z
        .object({ channel: z.enum(['email', 'whatsapp', 'sms']).optional() })
        .parse(request.query);

      const rows = await withWorkspace(db, workspace.workspaceId, (tx) =>
        tx
          .select({
            id: schema.messageTemplates.id,
            slug: schema.messageTemplates.slug,
            name: schema.messageTemplates.name,
            channel: schema.messageTemplates.channel,
            locale: schema.messageTemplates.locale,
            body: schema.messageTemplates.body,
            variables: schema.messageTemplates.variables,
            providerTemplateId: schema.messageTemplates.providerTemplateId,
          })
          .from(schema.messageTemplates)
          .where(
            and(
              isNull(schema.messageTemplates.deletedAt),
              query.channel ? eq(schema.messageTemplates.channel, query.channel) : undefined,
            ),
          )
          .orderBy(schema.messageTemplates.name),
      );

      return { items: rows };
    },
  );

  /* ------------------------------------------------------------ staff send */

  app.post(
    '/v1/crm/leads/:id/whatsapp',
    { config: { bosAccess: requirePermission('leads.write') } },
    async (request, reply) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const body = z
        .object({
          templateSlug: z.string().min(1).max(140),
          variables: z.array(z.string().max(500)).max(10).default([]),
        })
        .parse(request.body);
      const userId = requireUserId(request);

      const prepared = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [lead] = await tx
          .select({
            id: schema.leads.id,
            title: schema.leads.title,
            contactId: schema.leads.contactId,
          })
          .from(schema.leads)
          .where(and(eq(schema.leads.id, id), isNull(schema.leads.deletedAt)))
          .limit(1);
        if (!lead) throw ApiError.hidden('Lead');

        const [contact] = await tx
          .select({
            id: schema.contacts.id,
            whatsapp: schema.contacts.whatsapp,
            phone: schema.contacts.phone,
          })
          .from(schema.contacts)
          .where(eq(schema.contacts.id, lead.contactId))
          .limit(1);

        const to = contact?.whatsapp ?? contact?.phone;
        if (!contact || !to) {
          throw ApiError.badRequest('This enquiry has no WhatsApp number to send to.');
        }

        const [template] = await tx
          .select()
          .from(schema.messageTemplates)
          .where(
            and(
              eq(schema.messageTemplates.slug, body.templateSlug),
              eq(schema.messageTemplates.channel, 'whatsapp'),
              isNull(schema.messageTemplates.deletedAt),
            ),
          )
          .limit(1);
        if (!template) throw ApiError.badRequest('That template does not exist.');

        return { lead, contact, to, template };
      });

      /*
       * A manual send is a deliberate action each time, so its idempotency
       * key is unique per click. The row exists before the provider is
       * called; a provider failure marks it failed rather than losing it.
       */
      const idempotencyKey = `manual-wa:${id}:${randomUUID()}`;
      const messageId = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [row] = await tx
          .insert(schema.messages)
          .values({
            workspaceId: workspace.workspaceId,
            contactId: prepared.contact.id,
            leadId: id,
            channel: 'whatsapp',
            direction: 'outbound',
            status: 'queued',
            templateId: prepared.template.id,
            toAddress: prepared.to,
            fromAddress: config.WHATSAPP_PHONE_NUMBER_ID ?? 'whatsapp',
            body: renderTemplate(prepared.template.body, body.variables),
            provider: whatsappProvider.name,
            idempotencyKey,
          })
          .returning({ id: schema.messages.id });
        return row!.id;
      });

      try {
        const sent = await whatsappProvider.send({
          to: prepared.to,
          template: prepared.template.providerTemplateId ?? prepared.template.slug,
          languageCode: prepared.template.locale === 'bn' ? 'bn' : 'en',
          variables: body.variables,
        });

        await withWorkspace(db, workspace.workspaceId, async (tx) => {
          await tx
            .update(schema.messages)
            .set({
              status: 'sent',
              sentAt: new Date(),
              providerMessageId: sent.providerMessageId,
              updatedAt: new Date(),
            })
            .where(eq(schema.messages.id, messageId));

          await tx.insert(schema.activities).values({
            workspaceId: workspace.workspaceId,
            contactId: prepared.contact.id,
            leadId: id,
            type: 'whatsapp_sent',
            summary: `WhatsApp "${prepared.template.name}" sent by staff`,
            actorUserId: userId,
            occurredAt: new Date(),
          });
        });
      } catch (error) {
        await withWorkspace(db, workspace.workspaceId, (tx) =>
          tx
            .update(schema.messages)
            .set({
              status: 'failed',
              failureReason: error instanceof Error ? error.message.slice(0, 2000) : 'send failed',
              updatedAt: new Date(),
            })
            .where(eq(schema.messages.id, messageId)),
        );
        throw new ApiError(
          502,
          'send_failed',
          'The message could not be sent. It is recorded as failed with the reason.',
        );
      }

      await context.auth.audit(
        workspace.workspaceId,
        userId,
        'message.whatsapp_sent',
        requestContext(request),
        { leadId: id, template: prepared.template.slug },
      );

      return reply.status(201).send({ id: messageId });
    },
  );
}

function serialiseMessage(row: typeof schema.messages.$inferSelect) {
  return {
    id: row.id,
    channel: row.channel,
    direction: row.direction,
    status: row.status,
    toAddress: row.toAddress,
    fromAddress: row.fromAddress,
    subject: row.subject,
    body: row.body,
    provider: row.provider,
    failureReason: row.failureReason,
    leadId: row.leadId,
    contactId: row.contactId,
    sentAt: row.sentAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `{{1}}`-style placeholders, matching how Meta templates number variables. */
function renderTemplate(body: string, variables: readonly string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (match, index: string) => {
    const value = variables[Number(index) - 1];
    return value ?? match;
  });
}
