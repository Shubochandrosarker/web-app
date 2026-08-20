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
import { primaryKeyColumn, softDelete, timestamps } from './_shared.ts';
import { automationRunStatus, automationStepStatus, outboxStatus } from './enums.ts';
import { users, workspaces } from './identity.ts';
import { contacts } from './crm.ts';

/**
 * The automation engine's storage.
 *
 * Two ideas make this durable rather than best-effort:
 *
 *  1. **Versioned definitions.** A run pins the version it started on, so
 *     editing an automation never changes what an in-flight sequence does to a
 *     customer halfway through.
 *  2. **A transactional outbox.** Domain events are written in the same
 *     transaction as the change that caused them, then dispatched separately.
 *     A lead is therefore never created without its `lead.created` event, and
 *     an event never fires for a lead that failed to save.
 */

export const automations = pgTable(
  'automations',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 140 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description'),
    enabled: boolean('enabled').notNull().default(false),
    /** Points at the version new runs start on. */
    currentVersion: integer('current_version').notNull().default(1),
    /** Denormalised from the current version so trigger lookup is one index scan. */
    triggerKind: varchar('trigger_kind', { length: 20 }).notNull(),
    triggerEvent: varchar('trigger_event', { length: 80 }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    uniqueIndex('automations_workspace_slug_key').on(table.workspaceId, table.slug),
    index('automations_trigger_idx').on(table.workspaceId, table.triggerEvent, table.enabled),
  ],
);

export const automationVersions = pgTable(
  'automation_versions',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    automationId: uuid('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** The full definition, validated against @bos/automation before write. */
    definition: jsonb('definition').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex('automation_versions_automation_version_key').on(table.automationId, table.version),
  ],
);

export const automationRuns = pgTable(
  'automation_runs',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    automationId: uuid('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    automationVersionId: uuid('automation_version_id')
      .notNull()
      .references(() => automationVersions.id, { onDelete: 'restrict' }),
    status: automationRunStatus('status').notNull().default('running'),
    /** What the run is about — a lead, an appointment, a contact. */
    entityType: varchar('entity_type', { length: 40 }),
    entityId: uuid('entity_id'),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    /** Accumulated state: the triggering event plus anything steps have added. */
    context: jsonb('context')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Set while the run sleeps or waits for an event. */
    resumeAt: timestamp('resume_at', { withTimezone: true }),
    waitingForEvent: varchar('waiting_for_event', { length: 80 }),
    currentStepId: uuid('current_step_id'),
    /** Enforces the definition's re-entry policy. */
    dedupeKey: varchar('dedupe_key', { length: 255 }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('automation_runs_dedupe_key')
      .on(table.automationId, table.dedupeKey)
      .where(sql`${table.dedupeKey} IS NOT NULL`),
    // The scheduler's hot path: runs that are due to resume. Partial, so it
    // stays tiny regardless of how many completed runs pile up.
    index('automation_runs_resume_idx')
      .on(table.resumeAt)
      .where(sql`${table.status} = 'waiting'`),
    index('automation_runs_waiting_event_idx')
      .on(table.workspaceId, table.waitingForEvent)
      .where(sql`${table.status} = 'waiting'`),
    index('automation_runs_entity_idx').on(table.entityType, table.entityId),
  ],
);

export const automationRunSteps = pgTable(
  'automation_run_steps',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => automationRuns.id, { onDelete: 'cascade' }),
    /** Step id from the definition — stable across retries. */
    stepId: uuid('step_id').notNull(),
    sequence: integer('sequence').notNull(),
    type: varchar('type', { length: 20 }).notNull(),
    action: varchar('action', { length: 40 }),
    status: automationStepStatus('status').notNull().default('pending'),
    attempt: smallint('attempt').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** What the step produced, merged into the run context. */
    output: jsonb('output')
      .notNull()
      .default(sql`'{}'::jsonb`),
    failureReason: text('failure_reason'),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex('automation_run_steps_run_sequence_key').on(table.runId, table.sequence),
    index('automation_run_steps_run_idx').on(table.runId),
  ],
);

/**
 * The transactional outbox. Producers insert here inside the business
 * transaction; a dispatcher polls, publishes to the queue, and marks the row.
 */
export const eventOutbox = pgTable(
  'event_outbox',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 80 }).notNull(),
    payload: jsonb('payload').notNull(),
    correlationId: uuid('correlation_id').notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    status: outboxStatus('status').notNull().default('pending'),
    attempts: smallint('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    lastError: text('last_error'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex('event_outbox_idempotency_key').on(table.workspaceId, table.idempotencyKey),
    index('event_outbox_pending_idx')
      .on(table.availableAt)
      .where(sql`${table.status} = 'pending'`),
    index('event_outbox_workspace_name_idx').on(table.workspaceId, table.name, table.occurredAt),
  ],
);

/**
 * Inbound webhooks, stored before processing.
 *
 * Recording the raw request first means a signature mismatch or a parse
 * failure is diagnosable afterwards, instead of vanishing into a log line.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    /** `resend`, `stripe`, `whatsapp`, or a workspace's own automation slug. */
    source: varchar('source', { length: 64 }).notNull(),
    externalId: varchar('external_id', { length: 255 }),
    signatureValid: boolean('signature_valid').notNull().default(false),
    headers: jsonb('headers')
      .notNull()
      .default(sql`'{}'::jsonb`),
    body: jsonb('body')
      .notNull()
      .default(sql`'{}'::jsonb`),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex('webhook_deliveries_source_external_key')
      .on(table.source, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
    index('webhook_deliveries_created_idx').on(table.createdAt),
  ],
);

export const automationsRelations = relations(automations, ({ many }) => ({
  versions: many(automationVersions),
  runs: many(automationRuns),
}));

export const automationRunsRelations = relations(automationRuns, ({ one, many }) => ({
  automation: one(automations, {
    fields: [automationRuns.automationId],
    references: [automations.id],
  }),
  version: one(automationVersions, {
    fields: [automationRuns.automationVersionId],
    references: [automationVersions.id],
  }),
  steps: many(automationRunSteps),
}));
