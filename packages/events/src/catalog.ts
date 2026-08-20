import { z } from 'zod';
import { uuid } from '@bos/validation';

/**
 * The canonical domain event catalog.
 *
 * This is the seam between modules. CRM does not call the email module; it
 * emits `lead.created` and the automation engine decides what happens. Adding
 * a new reaction never means editing the code that produced the event.
 *
 * Rules:
 *  - Event names are `<entity>.<past-tense-verb>` and never change once shipped.
 *  - Payloads carry ids plus the few fields a condition might branch on. They
 *    are not a snapshot of the whole record — consumers re-read what they need.
 *  - Adding an optional field is a compatible change. Removing or retyping one
 *    is not: introduce `<name>.v2` instead.
 */

export const EVENT_NAMES = [
  // CRM
  'lead.created',
  'lead.updated',
  'lead.stage_changed',
  'lead.assigned',
  'lead.converted',
  'lead.lost',
  'contact.created',
  'contact.merged',
  'task.created',
  'task.completed',
  'task.overdue',

  // Marketing / capture
  'form.submitted',
  'document.uploaded',
  'document.verified',

  // Scheduling
  'appointment.created',
  'appointment.rescheduled',
  'appointment.cancelled',
  'appointment.reminder_due',
  'appointment.completed',
  'appointment.no_show',

  // Messaging
  'email.sent',
  'email.delivered',
  'email.opened',
  'email.clicked',
  'email.bounced',
  'email.unsubscribed',
  'whatsapp.sent',
  'whatsapp.replied',

  // Commerce
  'payment.completed',
  'payment.failed',
  'payment.refunded',

  // Content & SEO
  'content.published',
  'content.unpublished',
  'content.updated',
  'indexing.submitted',
  'indexing.failed',

  // Reputation
  'review.received',

  // Integration surface
  'webhook.received',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

/**
 * Envelope shared by every event. `workspaceId` is mandatory: nothing crosses
 * the bus without a tenant, which is what makes the automation engine safe to
 * run for many businesses on one deployment.
 */
export const eventEnvelopeSchema = z.object({
  id: uuid,
  name: z.enum(EVENT_NAMES),
  workspaceId: uuid,
  businessId: uuid.optional(),
  occurredAt: z.iso.datetime({ offset: true }),
  /** Set when a user action caused the event; absent for system-generated ones. */
  actorUserId: uuid.optional(),
  /** Groups every event produced by one logical request or automation run. */
  correlationId: uuid,
  /** Guards against duplicate delivery — consumers must be idempotent on this. */
  idempotencyKey: z.string().max(255),
  payload: z.record(z.string(), z.unknown()),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/** Payload shapes for the events an automation is most likely to branch on. */
export const eventPayloadSchemas = {
  'lead.created': z.object({
    leadId: uuid,
    contactId: uuid,
    source: z.string().max(64),
    serviceSlug: z.string().max(140).optional(),
    landingPath: z.string().max(2048).optional(),
    value: z.number().int().optional(),
  }),
  'lead.stage_changed': z.object({
    leadId: uuid,
    fromStageId: uuid.optional(),
    toStageId: uuid,
    pipelineId: uuid,
  }),
  'form.submitted': z.object({
    submissionId: uuid,
    formId: uuid,
    formSlug: z.string().max(140),
    contactId: uuid.optional(),
  }),
  'appointment.created': z.object({
    appointmentId: uuid,
    contactId: uuid,
    serviceId: uuid.optional(),
    staffUserId: uuid.optional(),
    startsAt: z.iso.datetime({ offset: true }),
  }),
  'content.published': z.object({
    contentEntryId: uuid,
    contentType: z.string().max(64),
    path: z.string().max(2048),
    locale: z.string().max(10),
  }),
  'document.uploaded': z.object({
    documentId: uuid,
    contactId: uuid.optional(),
    leadId: uuid.optional(),
    /** Never the object key — private document keys stay out of the event bus. */
    kind: z.string().max(64),
    sizeBytes: z.number().int().nonnegative(),
  }),
} satisfies Partial<Record<EventName, z.ZodType>>;

export type KnownEventPayload<N extends keyof typeof eventPayloadSchemas> = z.infer<
  (typeof eventPayloadSchemas)[N]
>;

export function isEventName(value: string): value is EventName {
  return (EVENT_NAMES as readonly string[]).includes(value);
}
