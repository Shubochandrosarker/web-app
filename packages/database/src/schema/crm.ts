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
import { metadata, primaryKeyColumn, softDelete, timestamps } from './_shared.ts';
import { leadStatus, taskStatus } from './enums.ts';
import { users, workspaces } from './identity.ts';
import { services } from './business.ts';

/**
 * CRM.
 *
 * The distinction that matters: a **contact** is a person, a **lead** is one
 * enquiry from that person. Someone who asks about a transcript in March and a
 * certificate in July is one contact with two leads — collapsing those loses
 * the second enquiry, and duplicating the person loses the history.
 */

export const companies = pgTable(
  'companies',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 300 }).notNull(),
    website: text('website'),
    industry: varchar('industry', { length: 140 }),
    metadata: metadata(),
    ...timestamps,
    ...softDelete,
  },
  (table) => [index('companies_workspace_idx').on(table.workspaceId)],
);

export const contacts = pgTable(
  'contacts',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
    fullName: varchar('full_name', { length: 200 }),
    email: varchar('email', { length: 320 }),
    /** E.164, so a WhatsApp number and a form number dedupe against each other. */
    phone: varchar('phone', { length: 20 }),
    whatsapp: varchar('whatsapp', { length: 20 }),
    locale: varchar('locale', { length: 10 }),
    timeZone: varchar('time_zone', { length: 64 }),
    /** Free-form per-workspace fields, defined in the workspace's settings. */
    customFields: jsonb('custom_fields')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** First and last touch, as captured by @bos/validation's attribution shape. */
    attribution: jsonb('attribution')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Consent is recorded, not assumed. Null means never asked. */
    marketingConsentAt: timestamp('marketing_consent_at', { withTimezone: true }),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
    /** Survives a merge so the winning row keeps both histories. */
    mergedIntoId: uuid('merged_into_id'),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    metadata: metadata(),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    // Partial unique indexes: a workspace may hold many contacts with no email
    // at all, but never two with the same one.
    uniqueIndex('contacts_workspace_email_key')
      .on(table.workspaceId, table.email)
      .where(sql`${table.email} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    uniqueIndex('contacts_workspace_phone_key')
      .on(table.workspaceId, table.phone)
      .where(sql`${table.phone} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    index('contacts_workspace_idx').on(table.workspaceId),
    index('contacts_last_activity_idx').on(table.workspaceId, table.lastActivityAt),
  ],
);

export const pipelines = pgTable(
  'pipelines',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 140 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    ...timestamps,
  },
  (table) => [uniqueIndex('pipelines_workspace_slug_key').on(table.workspaceId, table.slug)],
);

/**
 * Stages are rows, not an enum — a client renaming "Contacted" to "Documents
 * requested" must never require a migration.
 */
export const pipelineStages = pgTable(
  'pipeline_stages',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 140 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    position: integer('position').notNull().default(0),
    /** Marks the stage that means "won" for conversion reporting. */
    isWon: boolean('is_won').notNull().default(false),
    isLost: boolean('is_lost').notNull().default(false),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('pipeline_stages_pipeline_slug_key').on(table.pipelineId, table.slug),
    index('pipeline_stages_pipeline_position_idx').on(table.pipelineId, table.position),
  ],
);

export const leads = pgTable(
  'leads',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    pipelineId: uuid('pipeline_id').references(() => pipelines.id, { onDelete: 'set null' }),
    stageId: uuid('stage_id').references(() => pipelineStages.id, { onDelete: 'set null' }),
    serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
    status: leadStatus('status').notNull().default('open'),
    title: varchar('title', { length: 300 }),
    /** Where it came from: `website_form`, `whatsapp`, `phone`, `referral`. */
    source: varchar('source', { length: 64 }).notNull().default('website_form'),
    /** Estimated value in minor units. */
    valueAmount: integer('value_amount'),
    valueCurrency: varchar('value_currency', { length: 3 }),
    assignedToUserId: uuid('assigned_to_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /**
     * Attribution is copied onto the lead at creation, not read through the
     * contact. A returning visitor's contact-level last-touch will change; what
     * drove *this* enquiry must not.
     */
    attribution: jsonb('attribution')
      .notNull()
      .default(sql`'{}'::jsonb`),
    landingPath: text('landing_path'),
    followUpAt: timestamp('follow_up_at', { withTimezone: true }),
    stageChangedAt: timestamp('stage_changed_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    lostReason: varchar('lost_reason', { length: 300 }),
    customFields: jsonb('custom_fields')
      .notNull()
      .default(sql`'{}'::jsonb`),
    metadata: metadata(),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    index('leads_workspace_status_idx').on(table.workspaceId, table.status),
    index('leads_workspace_stage_idx').on(table.workspaceId, table.stageId),
    index('leads_contact_idx').on(table.contactId),
    index('leads_assigned_idx').on(table.assignedToUserId, table.status),
    index('leads_follow_up_idx').on(table.workspaceId, table.followUpAt),
    index('leads_created_idx').on(table.workspaceId, table.createdAt),
  ],
);

export const tags = pgTable(
  'tags',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 140 }).notNull(),
    name: varchar('name', { length: 140 }).notNull(),
    color: varchar('color', { length: 7 }),
    ...timestamps,
  },
  (table) => [uniqueIndex('tags_workspace_slug_key').on(table.workspaceId, table.slug)],
);

/** Polymorphic tagging. `entity_type` is checked in application code. */
export const taggables = pgTable(
  'taggables',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    entityType: varchar('entity_type', { length: 40 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex('taggables_tag_entity_key').on(table.tagId, table.entityType, table.entityId),
    index('taggables_entity_idx').on(table.entityType, table.entityId),
  ],
);

export const notes = pgTable(
  'notes',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    entityType: varchar('entity_type', { length: 40 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    body: text('body').notNull(),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
    ...softDelete,
  },
  (table) => [index('notes_entity_idx').on(table.workspaceId, table.entityType, table.entityId)],
);

export const tasks = pgTable(
  'tasks',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 300 }).notNull(),
    description: text('description'),
    status: taskStatus('status').notNull().default('open'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    assignedToUserId: uuid('assigned_to_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    entityType: varchar('entity_type', { length: 40 }),
    entityId: uuid('entity_id'),
    /** Set when an automation created this, for attribution and dedupe. */
    createdByAutomationId: uuid('created_by_automation_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    index('tasks_workspace_status_idx').on(table.workspaceId, table.status),
    index('tasks_assigned_due_idx').on(table.assignedToUserId, table.dueAt),
    index('tasks_entity_idx').on(table.entityType, table.entityId),
  ],
);

/**
 * The activity timeline. Every meaningful interaction — a form submission, an
 * email open, a stage change, a call logged by hand — lands here so one query
 * renders a contact's whole history in order.
 */
export const activities = pgTable(
  'activities',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
    /** Mirrors the event catalog name where one exists. */
    type: varchar('type', { length: 64 }).notNull(),
    summary: varchar('summary', { length: 500 }).notNull(),
    detail: jsonb('detail')
      .notNull()
      .default(sql`'{}'::jsonb`),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index('activities_contact_occurred_idx').on(table.contactId, table.occurredAt),
    index('activities_lead_occurred_idx').on(table.leadId, table.occurredAt),
    index('activities_workspace_type_idx').on(table.workspaceId, table.type),
  ],
);

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [contacts.workspaceId], references: [workspaces.id] }),
  company: one(companies, { fields: [contacts.companyId], references: [companies.id] }),
  leads: many(leads),
  activities: many(activities),
}));

export const leadsRelations = relations(leads, ({ one, many }) => ({
  contact: one(contacts, { fields: [leads.contactId], references: [contacts.id] }),
  stage: one(pipelineStages, { fields: [leads.stageId], references: [pipelineStages.id] }),
  service: one(services, { fields: [leads.serviceId], references: [services.id] }),
  assignedTo: one(users, { fields: [leads.assignedToUserId], references: [users.id] }),
  activities: many(activities),
}));

export const pipelinesRelations = relations(pipelines, ({ many }) => ({
  stages: many(pipelineStages),
}));
