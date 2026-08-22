import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
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
import { primaryKeyColumn, timestamps } from './_shared.ts';
import { reviewSource } from './enums.ts';
import { workspaces } from './identity.ts';
import { contacts, leads } from './crm.ts';
import { contentEntries } from './content.ts';

/**
 * First-party analytics.
 *
 * Collected on our own domain, which is what makes it possible to join a page
 * view to a lead to revenue. A third-party tag can tell you sessions went up;
 * only first-party data can tell you which landing page produced the enquiry
 * that became a customer.
 *
 * No cookies are required for the session model below: a session is identified
 * by a rotating, salted hash, and nothing here stores a raw IP address.
 */

export const analyticsSessions = pgTable(
  'analytics_sessions',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Salted daily hash of coarse client signals. Not reversible to a person. */
    visitorHash: varchar('visitor_hash', { length: 64 }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    landingPath: text('landing_path').notNull(),
    exitPath: text('exit_path'),
    referrer: text('referrer'),
    /** Resolved channel, e.g. `organic_search`, `ai_assistant`, `direct`. */
    channel: varchar('channel', { length: 40 }).notNull().default('direct'),
    /** The specific source when known: `chatgpt`, `perplexity`, `google`. */
    sourceKey: varchar('source_key', { length: 64 }),
    utmSource: varchar('utm_source', { length: 255 }),
    utmMedium: varchar('utm_medium', { length: 255 }),
    utmCampaign: varchar('utm_campaign', { length: 255 }),
    utmTerm: varchar('utm_term', { length: 255 }),
    utmContent: varchar('utm_content', { length: 255 }),
    country: varchar('country', { length: 2 }),
    deviceType: varchar('device_type', { length: 16 }),
    /** Set once the visitor identifies themselves via a form. */
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    pageViewCount: integer('page_view_count').notNull().default(0),
    isBounce: boolean('is_bounce').notNull().default(true),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index('analytics_sessions_workspace_started_idx').on(table.workspaceId, table.startedAt),
    index('analytics_sessions_visitor_idx').on(table.workspaceId, table.visitorHash),
    index('analytics_sessions_channel_idx').on(table.workspaceId, table.channel, table.startedAt),
    index('analytics_sessions_contact_idx').on(table.contactId),
  ],
);

export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => analyticsSessions.id, { onDelete: 'cascade' }),
    /** `page_view`, `cta_click`, `whatsapp_click`, `form_submit`, `conversion`. */
    name: varchar('name', { length: 64 }).notNull(),
    path: text('path').notNull(),
    contentEntryId: uuid('content_entry_id').references(() => contentEntries.id, {
      onDelete: 'set null',
    }),
    /** Event-specific detail: which CTA, which form, which value. */
    properties: jsonb('properties')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Revenue in minor units, for conversion events that carry a value. */
    valueAmount: integer('value_amount'),
    valueCurrency: varchar('value_currency', { length: 3 }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index('analytics_events_workspace_name_occurred_idx').on(
      table.workspaceId,
      table.name,
      table.occurredAt,
    ),
    index('analytics_events_session_idx').on(table.sessionId, table.occurredAt),
    index('analytics_events_path_idx').on(table.workspaceId, table.path),
  ],
);

/**
 * Attribution touches, kept separately from sessions so a conversion can be
 * credited under several models (first, last, linear) without recomputing from
 * raw sessions each time.
 */
export const attributionTouches = pgTable(
  'attribution_touches',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    sessionId: uuid('session_id').references(() => analyticsSessions.id, { onDelete: 'set null' }),
    position: smallint('position').notNull(),
    isFirstTouch: boolean('is_first_touch').notNull().default(false),
    isLastTouch: boolean('is_last_touch').notNull().default(false),
    channel: varchar('channel', { length: 40 }).notNull(),
    sourceKey: varchar('source_key', { length: 64 }),
    landingPath: text('landing_path'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index('attribution_touches_contact_idx').on(table.contactId, table.position),
    index('attribution_touches_lead_idx').on(table.leadId),
  ],
);

/**
 * Pre-aggregated daily rollups. The dashboard reads these; it never scans raw
 * events. Recomputed nightly and after a backfill, so they are derived data
 * that can always be rebuilt.
 */
export const analyticsDaily = pgTable(
  'analytics_daily',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    /** Rollup dimension: `channel`, `landing_path`, `campaign`, or `total`. */
    dimension: varchar('dimension', { length: 32 }).notNull(),
    dimensionValue: varchar('dimension_value', { length: 512 }).notNull().default(''),
    sessions: integer('sessions').notNull().default(0),
    pageViews: integer('page_views').notNull().default(0),
    leadsCreated: integer('leads_created').notNull().default(0),
    conversions: integer('conversions').notNull().default(0),
    revenueAmount: integer('revenue_amount').notNull().default(0),
    revenueCurrency: varchar('revenue_currency', { length: 3 }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('analytics_daily_key').on(
      table.workspaceId,
      table.date,
      table.dimension,
      table.dimensionValue,
    ),
    index('analytics_daily_workspace_date_idx').on(table.workspaceId, table.date),
  ],
);

export const reviews = pgTable(
  'reviews',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    source: reviewSource('source').notNull().default('internal'),
    /** The platform's own id, so a re-sync updates rather than duplicates. */
    externalId: varchar('external_id', { length: 255 }),
    authorName: varchar('author_name', { length: 200 }).notNull(),
    rating: smallint('rating').notNull(),
    title: varchar('title', { length: 300 }),
    body: text('body'),
    /**
     * Only approved reviews are rendered, and only rendered reviews may feed an
     * AggregateRating — showing a rating the page does not display is exactly
     * the mismatch that gets structured data ignored.
     */
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    response: text('response'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('reviews_source_external_key')
      .on(table.workspaceId, table.source, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
    index('reviews_workspace_approved_idx').on(table.workspaceId, table.approvedAt),
  ],
);

export const analyticsSessionsRelations = relations(analyticsSessions, ({ one, many }) => ({
  contact: one(contacts, { fields: [analyticsSessions.contactId], references: [contacts.id] }),
  events: many(analyticsEvents),
}));

export const analyticsEventsRelations = relations(analyticsEvents, ({ one }) => ({
  session: one(analyticsSessions, {
    fields: [analyticsEvents.sessionId],
    references: [analyticsSessions.id],
  }),
}));

/**
 * Google Search Console, one row per day × dimension value.
 *
 * The same shape as `analytics_daily` on purpose: `dimension` is `query`,
 * `page`, `device` or `country`, and re-ingesting a day overwrites it, so a
 * retried job produces the same numbers rather than doubled ones. GSC data
 * arrives ~2 days late; the ingest job walks a trailing window.
 */
export const searchConsoleDaily = pgTable(
  'search_console_daily',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    dimension: varchar('dimension', { length: 16 }).notNull(),
    dimensionValue: varchar('dimension_value', { length: 1024 }).notNull().default(''),
    clicks: integer('clicks').notNull().default(0),
    impressions: integer('impressions').notNull().default(0),
    /** Average position × 100, stored as an integer to avoid float drift. */
    positionTimes100: integer('position_times_100').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('search_console_daily_key').on(
      table.workspaceId,
      table.date,
      table.dimension,
      table.dimensionValue,
    ),
    index('search_console_daily_workspace_date_idx').on(table.workspaceId, table.date),
  ],
);
