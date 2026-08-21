import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace, withoutTenantScope } from '@bos/database';
import { publicRoute } from '../lib/permissions.ts';
import type { AppContext } from '../app.ts';

/**
 * The Meta WhatsApp Cloud API webhook.
 *
 * Two requests, two very different trust stories:
 *
 *  - **GET** is the one-time subscription handshake. Meta sends
 *    `hub.verify_token`; matching it proves to Meta that this endpoint is
 *    ours. It authenticates the subscription, not messages.
 *  - **POST** is every delivery afterwards, verified by `X-Hub-Signature-256`
 *    — an HMAC of the **raw body** with the app secret. Verifying a
 *    re-serialisation of the parsed JSON would verify bytes Meta never
 *    signed, so this route keeps the raw bytes. Without the secret
 *    configured, deliveries are refused outright: an unverifiable webhook is
 *    an open write path into the CRM.
 *
 * What a verified delivery does:
 *
 *  - **statuses** (sent → delivered → read / failed) update the message row
 *    the provider id points at, and append a message event. A failure
 *    carries the provider's reason into `failure_reason`, which is what the
 *    communications screen shows.
 *  - **inbound messages** land in the workspace `WHATSAPP_INBOUND_WORKSPACE`
 *    names (Meta identifies the phone number, not the tenant): the contact
 *    is matched by number or created, the text is stored as an inbound
 *    message, and the contact's open lead — if exactly one — is linked so
 *    the reply shows up on the enquiry staff are working.
 */

const statusPayload = z.object({
  id: z.string().max(255),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  timestamp: z.string().optional(),
  errors: z
    .array(z.object({ code: z.number().optional(), title: z.string().optional() }))
    .optional(),
});

const inboundMessagePayload = z.object({
  from: z.string().min(5).max(20),
  id: z.string().max(255),
  timestamp: z.string().optional(),
  type: z.string(),
  text: z.object({ body: z.string().max(10_000) }).optional(),
});

const webhookBody = z.object({
  object: z.string(),
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              field: z.string(),
              value: z.object({
                messaging_product: z.string().optional(),
                metadata: z.object({ phone_number_id: z.string().optional() }).optional(),
                contacts: z
                  .array(
                    z.object({
                      wa_id: z.string().optional(),
                      profile: z.object({ name: z.string().optional() }).optional(),
                    }),
                  )
                  .optional(),
                statuses: z.array(statusPayload).optional(),
                messages: z.array(inboundMessagePayload).optional(),
              }),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

export function registerWhatsappWebhookRoutes(app: FastifyInstance, context: AppContext): void {
  const { config, resolveWorkspaceId } = context;

  /* ------------------------------------------------------------ handshake */

  app.get(
    '/v1/webhooks/whatsapp',
    {
      config: {
        bosAccess: publicRoute(
          "Meta's webhook subscription handshake; answers only with the challenge Meta sent.",
        ),
      },
    },
    async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      const mode = query['hub.mode'];
      const token = query['hub.verify_token'];
      const challenge = query['hub.challenge'];

      if (
        mode === 'subscribe' &&
        config.WHATSAPP_VERIFY_TOKEN &&
        token === config.WHATSAPP_VERIFY_TOKEN &&
        challenge
      ) {
        return reply.type('text/plain').send(challenge);
      }

      return reply.status(403).send({ error: { code: 'forbidden', message: 'Not verified.' } });
    },
  );

  /* ------------------------------------------------------------ deliveries */

  /*
   * The raw body is what Meta signed, so this route needs it verbatim. A
   * plain (encapsulated) plugin gets its own content-type parser without
   * changing how the rest of the API parses JSON.
   */
  void app.register(
    // Deliberately non-async: everything here is synchronous registration,
    // and Fastify accepts a callback-style plugin when `done` is invoked.
    (scope, _options, done) => {
      scope.removeContentTypeParser('application/json');
      scope.addContentTypeParser(
        'application/json',
        { parseAs: 'string', bodyLimit: 1_048_576 },
        (_request, payload, done) => {
          done(null, payload);
        },
      );

      scope.post(
        '/v1/webhooks/whatsapp',
        {
          config: {
            bosAccess: publicRoute(
              'Meta webhook deliveries, each verified against X-Hub-Signature-256 before anything is read.',
            ),
          },
        },
        async (request, reply) => {
          const rawBody = typeof request.body === 'string' ? request.body : '';

          if (!config.WHATSAPP_APP_SECRET) {
            request.log.warn({}, 'WhatsApp webhook received with no WHATSAPP_APP_SECRET set');
            return reply.status(503).send();
          }

          const header = request.headers['x-hub-signature-256'];
          const presented =
            typeof header === 'string' && header.startsWith('sha256=') ? header.slice(7) : '';
          const expected = createHmac('sha256', config.WHATSAPP_APP_SECRET)
            .update(rawBody)
            .digest('hex');

          const presentedBuffer = Buffer.from(presented, 'hex');
          const expectedBuffer = Buffer.from(expected, 'hex');
          if (
            presentedBuffer.length !== expectedBuffer.length ||
            !timingSafeEqual(presentedBuffer, expectedBuffer)
          ) {
            request.log.warn({}, 'WhatsApp webhook signature rejected');
            return reply.status(401).send();
          }

          let parsed: z.infer<typeof webhookBody>;
          try {
            parsed = webhookBody.parse(JSON.parse(rawBody));
          } catch {
            // Signed but malformed: acknowledge so Meta stops retrying a
            // payload that will never parse, and log it for a person.
            request.log.warn({}, 'WhatsApp webhook payload did not parse');
            return reply.status(200).send();
          }

          for (const entry of parsed.entry) {
            for (const change of entry.changes) {
              const value = change.value;

              for (const status of value.statuses ?? []) {
                await applyStatus(context, status, request.log);
              }

              if ((value.messages ?? []).length > 0) {
                await storeInbound(
                  context,
                  value.messages ?? [],
                  value.contacts ?? [],
                  request.log,
                  resolveWorkspaceId,
                );
              }
            }
          }

          return reply.status(200).send();
        },
      );
      done();
    },
  );
}

type Logger = {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
};

/** Map a provider status onto a message row, wherever its workspace is. */
async function applyStatus(
  context: AppContext,
  status: z.infer<typeof statusPayload>,
  log: Logger,
): Promise<void> {
  const { db } = context;

  // The provider id → workspace mapping lives on the message row itself; the
  // lookup must span workspaces because the webhook has no tenant context.
  const row = await withoutTenantScope(db, async (tx) => {
    const [message] = await tx
      .select({ id: schema.messages.id, workspaceId: schema.messages.workspaceId })
      .from(schema.messages)
      .where(eq(schema.messages.providerMessageId, status.id))
      .limit(1);
    return message;
  });

  if (!row) {
    log.info({ providerMessageId: status.id }, 'WhatsApp status for an unknown message');
    return;
  }

  const failureReason =
    status.status === 'failed'
      ? (status.errors ?? []).map((error) => error.title ?? String(error.code ?? '')).join('; ') ||
        'Delivery failed'
      : null;

  await withWorkspace(db, row.workspaceId, async (tx) => {
    await tx
      .update(schema.messages)
      .set({
        status: status.status,
        ...(failureReason ? { failureReason } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.messages.id, row.id));

    await tx
      .insert(schema.messageEvents)
      .values({
        workspaceId: row.workspaceId,
        messageId: row.id,
        type: status.status,
        providerEventId: `${status.id}:${status.status}`,
        detail: failureReason ? { failureReason } : {},
      })
      .onConflictDoNothing();
  });
}

async function storeInbound(
  context: AppContext,
  messages: readonly z.infer<typeof inboundMessagePayload>[],
  contacts: readonly {
    wa_id?: string | undefined;
    profile?: { name?: string | undefined } | undefined;
  }[],
  log: Logger,
  resolveWorkspaceId: (slug: string) => Promise<string>,
): Promise<void> {
  const { db, config } = context;

  const slug = config.WHATSAPP_INBOUND_WORKSPACE;
  if (!slug) {
    log.warn(
      { count: messages.length },
      'Inbound WhatsApp dropped: WHATSAPP_INBOUND_WORKSPACE is not set',
    );
    return;
  }

  const workspaceId = await resolveWorkspaceId(slug).catch(() => null);
  if (!workspaceId) {
    log.warn({ slug }, 'Inbound WhatsApp dropped: workspace not found');
    return;
  }

  for (const inbound of messages) {
    const phone = inbound.from.startsWith('+') ? inbound.from : `+${inbound.from}`;
    const profileName = contacts.find((contact) => contact.wa_id === inbound.from)?.profile?.name;
    const text =
      inbound.type === 'text' && inbound.text
        ? inbound.text.body
        : `[${inbound.type} message — view it in WhatsApp]`;

    await withWorkspace(db, workspaceId, async (tx) => {
      const [existingContact] = await tx
        .select({ id: schema.contacts.id })
        .from(schema.contacts)
        .where(and(isNull(schema.contacts.deletedAt), eq(schema.contacts.whatsapp, phone)))
        .limit(1);

      let contactId = existingContact?.id;
      if (!contactId) {
        const [byPhone] = await tx
          .select({ id: schema.contacts.id })
          .from(schema.contacts)
          .where(and(isNull(schema.contacts.deletedAt), eq(schema.contacts.phone, phone)))
          .limit(1);
        contactId = byPhone?.id;
      }
      if (!contactId) {
        const [created] = await tx
          .insert(schema.contacts)
          .values({
            workspaceId,
            fullName: profileName ?? `WhatsApp ${phone.slice(-4)}`,
            phone,
            whatsapp: phone,
            lastActivityAt: new Date(),
          })
          .returning({ id: schema.contacts.id });
        contactId = created!.id;
      }

      // If the person has exactly one open enquiry, the reply belongs to it;
      // with several, guessing would attach it to the wrong one.
      const openLeads = await tx
        .select({ id: schema.leads.id })
        .from(schema.leads)
        .where(
          and(
            eq(schema.leads.contactId, contactId),
            eq(schema.leads.status, 'open'),
            isNull(schema.leads.deletedAt),
          ),
        )
        .limit(2);
      const leadId = openLeads.length === 1 ? openLeads[0]!.id : null;

      await tx
        .insert(schema.messages)
        .values({
          workspaceId,
          contactId,
          leadId,
          channel: 'whatsapp',
          direction: 'inbound',
          status: 'received',
          toAddress: 'business',
          fromAddress: phone,
          body: text,
          provider: 'meta_cloud',
          providerMessageId: inbound.id,
          idempotencyKey: `wa-inbound:${inbound.id}`,
        })
        .onConflictDoNothing({
          target: [schema.messages.workspaceId, schema.messages.idempotencyKey],
        });

      await tx
        .update(schema.contacts)
        .set({ lastActivityAt: new Date() })
        .where(eq(schema.contacts.id, contactId));

      await tx.insert(schema.activities).values({
        workspaceId,
        contactId,
        leadId,
        type: 'whatsapp_received',
        summary: `WhatsApp from ${profileName ?? phone}: ${text.slice(0, 140)}`,
        occurredAt: new Date(),
      });
    });
  }
}
