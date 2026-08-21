import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { primaryKeyColumn, softDelete, timestamps } from './_shared.ts';
import { messageChannel, messageStatus } from './enums.ts';
import { workspaces } from './identity.ts';
import { contacts, leads } from './crm.ts';

/**
 * Messaging.
 *
 * One table for outbound messages across every channel. Email, SMS and
 * WhatsApp differ in transport, not in what you need to know afterwards: who
 * it went to, what it said, and what happened. Splitting them would mean
 * writing "messages to this contact, in order" three times.
 */

export const messageTemplates = pgTable(
  'message_templates',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 140 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    channel: messageChannel('channel').notNull(),
    locale: varchar('locale', { length: 10 }).notNull().default('en'),
    subject: varchar('subject', { length: 300 }),
    /** Body with `{{placeholders}}`; rendered against a whitelisted context. */
    body: text('body').notNull(),
    bodyHtml: text('body_html'),
    /** Provider-side template id, for channels that pre-approve content. */
    providerTemplateId: varchar('provider_template_id', { length: 140 }),
    /** Variables the template expects, so a missing one fails at save time. */
    variables: jsonb('variables')
      .notNull()
      .default(sql`'[]'::jsonb`),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    uniqueIndex('message_templates_workspace_slug_locale_key').on(
      table.workspaceId,
      table.slug,
      table.locale,
    ),
  ],
);

export const messageSequences = pgTable(
  'message_sequences',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 140 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    /** Ordered `{ templateId, delaySeconds, stopOnReply }` steps. */
    steps: jsonb('steps')
      .notNull()
      .default(sql`'[]'::jsonb`),
    enabled: boolean('enabled').notNull().default(false),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('message_sequences_workspace_slug_key').on(table.workspaceId, table.slug),
  ],
);

export const campaigns = pgTable(
  'campaigns',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 140 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    channel: messageChannel('channel').notNull().default('email'),
    templateId: uuid('template_id').references(() => messageTemplates.id, { onDelete: 'set null' }),
    /** Stored segment definition, re-evaluated at send time. */
    segment: jsonb('segment')
      .notNull()
      .default(sql`'{}'::jsonb`),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** Denormalised counters so the list view is one query, not N. */
    recipientCount: integer('recipient_count').notNull().default(0),
    sentCount: integer('sent_count').notNull().default(0),
    ...timestamps,
  },
  (table) => [uniqueIndex('campaigns_workspace_slug_key').on(table.workspaceId, table.slug)],
);

export const messages = pgTable(
  'messages',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    /**
     * The enquiry this message belongs to, when there is one.
     *
     * Denormalised alongside `contact_id` because the question staff actually
     * ask is "what has been sent about *this* request", and a contact with two
     * enquiries cannot answer it.
     */
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    channel: messageChannel('channel').notNull(),
    status: messageStatus('status').notNull().default('queued'),
    templateId: uuid('template_id').references(() => messageTemplates.id, { onDelete: 'set null' }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    automationRunId: uuid('automation_run_id'),
    toAddress: varchar('to_address', { length: 320 }).notNull(),
    fromAddress: varchar('from_address', { length: 320 }).notNull(),
    subject: varchar('subject', { length: 300 }),
    /** Rendered body, kept so support can see exactly what was sent. */
    body: text('body'),
    /** Provider's own id, for reconciling webhooks back to this row. */
    providerMessageId: varchar('provider_message_id', { length: 255 }),
    provider: varchar('provider', { length: 40 }),
    /**
     * Deduplication key. A retried automation step must not send twice, so the
     * send path is an upsert on this rather than an insert.
     */
    idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  },
  (table) => [
    uniqueIndex('messages_workspace_idempotency_key').on(table.workspaceId, table.idempotencyKey),
    index('messages_contact_created_idx').on(table.contactId, table.createdAt),
    index('messages_lead_created_idx').on(table.leadId, table.createdAt),
    index('messages_workspace_status_idx').on(table.workspaceId, table.status),
    index('messages_provider_message_idx').on(table.providerMessageId),
    index('messages_campaign_idx').on(table.campaignId),
  ],
);

/**
 * Delivery events from the provider: delivered, opened, clicked, bounced.
 * Separate rows rather than columns on `messages` because a message can be
 * opened many times, and "opened twice" is information.
 */
export const messageEvents = pgTable(
  'message_events',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 40 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** Clicked URL, bounce code, user agent — whatever the provider sends. */
    detail: jsonb('detail')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Providers retry webhooks; this makes ingestion idempotent. */
    providerEventId: varchar('provider_event_id', { length: 255 }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex('message_events_provider_event_key')
      .on(table.workspaceId, table.providerEventId)
      .where(sql`${table.providerEventId} IS NOT NULL`),
    index('message_events_message_idx').on(table.messageId, table.occurredAt),
  ],
);

/**
 * Suppression list. Checked before every send, across channels. An unsubscribe
 * or a hard bounce must survive a contact being deleted and re-imported —
 * which is why this is keyed on the address, not on `contact_id`.
 */
export const suppressions = pgTable(
  'suppressions',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channel: messageChannel('channel').notNull(),
    address: varchar('address', { length: 320 }).notNull(),
    /** `unsubscribed`, `hard_bounce`, `complaint`, `manual`. */
    reason: varchar('reason', { length: 40 }).notNull(),
    detail: text('detail'),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex('suppressions_workspace_channel_address_key').on(
      table.workspaceId,
      table.channel,
      table.address,
    ),
  ],
);

export const messagesRelations = relations(messages, ({ one, many }) => ({
  contact: one(contacts, { fields: [messages.contactId], references: [contacts.id] }),
  template: one(messageTemplates, {
    fields: [messages.templateId],
    references: [messageTemplates.id],
  }),
  campaign: one(campaigns, { fields: [messages.campaignId], references: [campaigns.id] }),
  events: many(messageEvents),
}));

export const messageEventsRelations = relations(messageEvents, ({ one }) => ({
  message: one(messages, { fields: [messageEvents.messageId], references: [messages.id] }),
}));
