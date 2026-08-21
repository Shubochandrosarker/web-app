import { and, eq } from 'drizzle-orm';
import { schema, withWorkspace, type Database } from '@bos/database';
import type { ApiConfig } from '../lib/env.ts';
import type { EmailProvider, WhatsappProvider } from '../providers/notifications.ts';

/**
 * What happens when an event says a lead was created.
 *
 * The rule every handler here obeys: **record the send before returning, and
 * key it so a second delivery is a no-op.** The outbox guarantees at-least-once
 * delivery, which means every handler is called more than once sooner or
 * later — on a redeploy mid-dispatch, on a transient provider timeout that
 * actually succeeded, on a manual requeue. A handler that is not idempotent
 * turns that guarantee into duplicate messages to a customer.
 *
 * The `messages` table is where idempotency lives: one row per intended
 * message, inserted before the provider is called, with a unique key. If the
 * insert conflicts, this delivery already happened and there is nothing to do.
 */

export interface NotificationDependencies {
  readonly config: ApiConfig;
  readonly email: EmailProvider;
  readonly whatsapp: WhatsappProvider;
  readonly db: Database;
}

export interface LeadCreatedPayload {
  readonly leadId: string;
  readonly contactId: string;
  readonly submissionId: string;
  readonly formId: string | null;
  readonly serviceId: string | null;
  readonly fullName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly whatsapp: string | null;
  readonly locale: string;
  readonly landingPath: string | null;
}

export function createNotificationDispatcher(deps: NotificationDependencies) {
  const { config, email, whatsapp, db } = deps;

  /**
   * Reserve the right to send exactly one message.
   *
   * Returns the row id when this caller won the race and null when the message
   * already exists. The unique index on `(workspace_id, idempotency_key)` is
   * what decides, so two dispatchers racing on the same event produce one
   * message rather than two.
   */
  const reserveMessage = async (
    workspaceId: string,
    channel: 'email' | 'whatsapp',
    idempotencyKey: string,
    to: string,
    subject: string | null,
    body: string,
    contactId: string | null,
    leadId: string | null,
  ): Promise<string | null> =>
    withWorkspace(db, workspaceId, async (tx) => {
      /*
       * Suppression is checked here rather than at the provider, because the
       * obligation is not to send — not merely to have the provider refuse.
       * It is keyed on the address rather than the contact so an unsubscribe
       * survives the contact being deleted and re-imported.
       */
      const [suppressed] = await tx
        .select({ id: schema.suppressions.id })
        .from(schema.suppressions)
        .where(
          and(
            eq(schema.suppressions.workspaceId, workspaceId),
            eq(schema.suppressions.channel, channel),
            eq(schema.suppressions.address, to),
          ),
        )
        .limit(1);

      if (suppressed) return null;

      const [row] = await tx
        .insert(schema.messages)
        .values({
          workspaceId,
          channel,
          status: 'queued',
          toAddress: to,
          fromAddress:
            channel === 'email'
              ? config.EMAIL_FROM_ADDRESS
              : (config.WHATSAPP_PHONE_NUMBER_ID ?? 'whatsapp'),
          provider: channel === 'email' ? config.EMAIL_PROVIDER : config.WHATSAPP_PROVIDER,
          ...(subject ? { subject } : {}),
          body,
          idempotencyKey,
          ...(contactId ? { contactId } : {}),
          ...(leadId ? { leadId } : {}),
        })
        // A duplicate key means an earlier delivery of this event already
        // reserved this message. Returning null makes the retry a no-op.
        .onConflictDoNothing({
          target: [schema.messages.workspaceId, schema.messages.idempotencyKey],
        })
        .returning({ id: schema.messages.id });

      return row?.id ?? null;
    });

  const markSent = async (
    workspaceId: string,
    messageId: string,
    providerMessageId: string | null,
  ): Promise<void> => {
    await withWorkspace(db, workspaceId, (tx) =>
      tx
        .update(schema.messages)
        .set({
          status: 'sent',
          sentAt: new Date(),
          ...(providerMessageId ? { providerMessageId } : {}),
        })
        .where(eq(schema.messages.id, messageId)),
    );
  };

  const markFailed = async (
    workspaceId: string,
    messageId: string,
    reason: string,
  ): Promise<void> => {
    await withWorkspace(db, workspaceId, (tx) =>
      tx
        .update(schema.messages)
        .set({ status: 'failed', failureReason: reason.slice(0, 2000) })
        .where(eq(schema.messages.id, messageId)),
    );
  };

  /**
   * Handle `lead.created`.
   *
   * Three sends, each independently reserved: the visitor's confirmation, the
   * visitor's WhatsApp acknowledgement, and the staff notification. Reserving
   * them separately means a WhatsApp outage does not stop the staff email, and
   * a retry after a partial failure re-sends only the part that failed.
   */
  const handleLeadCreated = async (
    workspaceId: string,
    payload: LeadCreatedPayload,
  ): Promise<void> => {
    const workspace = await withWorkspace(db, workspaceId, async (tx) => {
      const [row] = await tx
        .select({
          name: schema.workspaces.name,
          siteUrl: schema.workspaces.siteUrl,
        })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);
      return row;
    });

    const businessName = workspace?.name ?? 'our team';
    const failures: string[] = [];

    /* -------------------------------------------- confirmation to the visitor */

    if (payload.email) {
      const subject = `We have your request — ${businessName}`;
      const text = [
        `Hello ${payload.fullName},`,
        '',
        `Thank you for contacting ${businessName}. We have received your request and a member of our team will be in touch.`,
        '',
        'If you need to add anything, reply to this message.',
        '',
        businessName,
      ].join('\n');

      const messageId = await reserveMessage(
        workspaceId,
        'email',
        `lead.confirmation:${payload.leadId}`,
        payload.email,
        subject,
        text,
        payload.contactId,
        payload.leadId,
      );

      if (messageId) {
        try {
          const result = await email.send({ to: payload.email, subject, text });
          await markSent(workspaceId, messageId, result.providerMessageId);
          await logActivity(db, workspaceId, payload, 'message.sent', 'Confirmation email sent');
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await markFailed(workspaceId, messageId, reason);
          failures.push(`confirmation email: ${reason}`);
        }
      }
    }

    /* ------------------------------------------ WhatsApp acknowledgement */

    const whatsappNumber = payload.whatsapp ?? payload.phone;
    if (whatsappNumber && config.WHATSAPP_PROVIDER !== 'log') {
      const messageId = await reserveMessage(
        workspaceId,
        'whatsapp',
        `lead.whatsapp:${payload.leadId}`,
        whatsappNumber,
        null,
        `template:lead_received(${payload.fullName})`,
        payload.contactId,
        payload.leadId,
      );

      if (messageId) {
        try {
          const result = await whatsapp.send({
            to: whatsappNumber,
            // A business-initiated message outside the 24-hour service window
            // must use an approved template, so the template name is part of
            // the contract rather than something assembled here.
            template: 'lead_received',
            languageCode: payload.locale.startsWith('bn') ? 'bn' : 'en',
            variables: [payload.fullName, businessName],
          });
          await markSent(workspaceId, messageId, result.providerMessageId);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await markFailed(workspaceId, messageId, reason);
          failures.push(`whatsapp: ${reason}`);
        }
      }
    }

    /* ------------------------------------------------ notify the staff */

    const notifyAddresses = payload.formId
      ? await withWorkspace(db, workspaceId, async (tx) => {
          const [form] = await tx
            .select({ notifyEmails: schema.forms.notifyEmails })
            .from(schema.forms)
            .where(eq(schema.forms.id, payload.formId!))
            .limit(1);
          return (form?.notifyEmails as string[] | undefined) ?? [];
        })
      : [];

    for (const address of notifyAddresses) {
      const subject = `New enquiry from ${payload.fullName}`;
      const leadUrl = config.DASHBOARD_URL
        ? `${config.DASHBOARD_URL.replace(/\/+$/, '')}/leads/${payload.leadId}`
        : `(dashboard URL not configured)`;

      const text = [
        `A new service request has arrived.`,
        '',
        `Name:    ${payload.fullName}`,
        `Phone:   ${payload.phone ?? '—'}`,
        `Email:   ${payload.email ?? '—'}`,
        `Page:    ${payload.landingPath ?? '—'}`,
        '',
        // The submitted values are deliberately not in this email. Notification
        // addresses are configuration, not an authorisation decision, and a
        // transcript number should not sit in an inbox nobody governs.
        `Open the lead: ${leadUrl}`,
      ].join('\n');

      const messageId = await reserveMessage(
        workspaceId,
        'email',
        `lead.staff:${payload.leadId}:${address}`,
        address,
        subject,
        text,
        payload.contactId,
        payload.leadId,
      );

      if (messageId) {
        try {
          const result = await email.send({
            to: address,
            subject,
            text,
            ...(payload.email ? { replyTo: payload.email } : {}),
          });
          await markSent(workspaceId, messageId, result.providerMessageId);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await markFailed(workspaceId, messageId, reason);
          failures.push(`staff notification to ${address}: ${reason}`);
        }
      }
    }

    // Throwing puts the event back in the outbox for a retry with backoff.
    // The reservations above mean the retry re-sends only what failed.
    if (failures.length > 0) throw new Error(failures.join('; '));
  };

  /**
   * Password reset and invitation emails.
   *
   * Not routed through the outbox: both are synchronous responses to something
   * a person is doing right now, and a reset link that arrives after a
   * dispatcher poll is a reset link the user has already given up on. The cost
   * is that a provider failure loses the email, which is recoverable — they
   * click "forgot password" again.
   */
  const sendAuthEmail = async (message: {
    kind: 'password_reset' | 'invitation';
    to: string;
    token: string;
  }): Promise<void> => {
    const dashboard = (config.DASHBOARD_URL ?? '').replace(/\/+$/, '');
    const path = message.kind === 'password_reset' ? 'reset-password' : 'accept-invitation';
    const link = `${dashboard}/${path}?token=${encodeURIComponent(message.token)}`;

    const subject =
      message.kind === 'password_reset'
        ? `Reset your ${config.AUTH_MFA_ISSUER} password`
        : `You have been invited to ${config.AUTH_MFA_ISSUER}`;

    const text =
      message.kind === 'password_reset'
        ? [
            'Someone asked to reset the password for this address.',
            '',
            `Reset it here (the link expires in one hour): ${link}`,
            '',
            'If this was not you, no action is needed — the password has not changed.',
          ].join('\n')
        : [
            'You have been invited to join a workspace.',
            '',
            `Accept the invitation here (the link expires in seven days): ${link}`,
          ].join('\n');

    await email.send({ to: message.to, subject, text });
  };

  return { handleLeadCreated, sendAuthEmail };
}

async function logActivity(
  db: Database,
  workspaceId: string,
  payload: LeadCreatedPayload,
  type: string,
  summary: string,
): Promise<void> {
  await withWorkspace(db, workspaceId, (tx) =>
    tx.insert(schema.activities).values({
      workspaceId,
      contactId: payload.contactId,
      leadId: payload.leadId,
      type,
      summary: summary.slice(0, 500),
      detail: {},
    }),
  ).catch(() => undefined);
}
