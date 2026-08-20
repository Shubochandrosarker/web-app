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
import { primaryKeyColumn, timestamps } from './_shared.ts';
import { indexingProvider, indexingStatus } from './enums.ts';
import { workspaces } from './identity.ts';
import { contentEntries } from './content.ts';

/**
 * The SEO layer.
 *
 * Two things live here that are usually bolted on by a plugin, and are core
 * tables instead:
 *
 *  1. **Per-page metadata**, so a canonical or a noindex is a first-class,
 *     queryable fact — "which pages are noindexed?" should not require
 *     crawling your own site.
 *  2. **An entity graph.** Organization, Person, Service, Location and Article
 *     records with typed relations between them, from which JSON-LD is
 *     generated. Schema output is then a projection of structured data the
 *     business actually maintains, not hand-written blobs that drift from the
 *     page they describe.
 */

export const seoMetadata = pgTable(
  'seo_metadata',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contentEntryId: uuid('content_entry_id')
      .notNull()
      .references(() => contentEntries.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 200 }),
    description: varchar('description', { length: 400 }),
    canonicalUrl: text('canonical_url'),
    noindex: boolean('noindex').notNull().default(false),
    nofollow: boolean('nofollow').notNull().default(false),
    ogImageMediaId: uuid('og_image_media_id'),
    /** Extra JSON-LD nodes merged into the page graph. Reviewed, not free-form. */
    schemaOverrides: jsonb('schema_overrides')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Latest audit scores, refreshed by the SEO audit job. */
    scores: jsonb('scores')
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastAuditedAt: timestamp('last_audited_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex('seo_metadata_entry_key').on(table.contentEntryId)],
);

export const SEO_ENTITY_KINDS = [
  'organization',
  'local_business',
  'brand',
  'person',
  'place',
  'service',
  'article',
  'faq',
  'offer',
  'review',
  'event',
  'product',
  'video',
  'image',
] as const;

/**
 * A node in the business's knowledge graph. `kind` mirrors a schema.org type;
 * `stable_id` is the `@id` fragment used in JSON-LD so the same entity keeps
 * its identity across every page it appears on.
 */
export const seoEntities = pgTable(
  'seo_entities',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 40 }).notNull(),
    stableId: varchar('stable_id', { length: 140 }).notNull(),
    name: varchar('name', { length: 300 }).notNull(),
    description: text('description'),
    /** The record this entity describes, e.g. a service or location row. */
    sourceTable: varchar('source_table', { length: 64 }),
    sourceId: uuid('source_id'),
    /** Additional schema.org properties for this node. */
    properties: jsonb('properties')
      .notNull()
      .default(sql`'{}'::jsonb`),
    sameAs: jsonb('same_as')
      .notNull()
      .default(sql`'[]'::jsonb`),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('seo_entities_workspace_stable_id_key').on(table.workspaceId, table.stableId),
    index('seo_entities_workspace_kind_idx').on(table.workspaceId, table.kind),
    index('seo_entities_source_idx').on(table.sourceTable, table.sourceId),
  ],
);

/**
 * Typed edges between entities — `offers`, `locatedAt`, `employee`,
 * `servesArea`, `sameAs`, `about`, `mentions`. The predicate is a schema.org
 * property name so the graph serialises directly.
 */
export const seoEntityRelations = pgTable(
  'seo_entity_relations',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => seoEntities.id, { onDelete: 'cascade' }),
    predicate: varchar('predicate', { length: 80 }).notNull(),
    objectId: uuid('object_id')
      .notNull()
      .references(() => seoEntities.id, { onDelete: 'cascade' }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex('seo_entity_relations_triple_key').on(
      table.subjectId,
      table.predicate,
      table.objectId,
    ),
    index('seo_entity_relations_object_idx').on(table.objectId),
  ],
);

/**
 * Which entities a page is *about*. This is what keeps rule 1 of JSON-LD
 * generation enforceable: a node is only emitted on a page that declares it.
 */
export const contentEntities = pgTable(
  'content_entities',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contentEntryId: uuid('content_entry_id')
      .notNull()
      .references(() => contentEntries.id, { onDelete: 'cascade' }),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => seoEntities.id, { onDelete: 'cascade' }),
    /** `primary` drives the page's main schema type; `mentions` is secondary. */
    role: varchar('role', { length: 20 }).notNull().default('mentions'),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex('content_entities_entry_entity_key').on(table.contentEntryId, table.entityId),
    index('content_entities_entity_idx').on(table.entityId),
  ],
);

/**
 * Every submission to a search engine, with its outcome.
 *
 * Recorded because submission and indexing are different things. Without this
 * table, "not indexed" and "never submitted" look identical from the
 * dashboard, and they call for opposite responses.
 */
export const indexingEvents = pgTable(
  'indexing_events',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: indexingProvider('provider').notNull(),
    url: text('url').notNull(),
    status: indexingStatus('status').notNull(),
    httpStatus: smallint('http_status'),
    reason: text('reason'),
    /** Groups URLs submitted in one request. */
    batchId: uuid('batch_id'),
    contentEntryId: uuid('content_entry_id').references(() => contentEntries.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index('indexing_events_workspace_created_idx').on(table.workspaceId, table.createdAt),
    index('indexing_events_url_idx').on(table.workspaceId, table.url),
    index('indexing_events_batch_idx').on(table.batchId),
  ],
);

/**
 * Search Console performance, stored per page/query/day so trends survive
 * Search Console's own 16-month retention window.
 */
export const searchPerformanceDaily = pgTable(
  'search_performance_daily',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    date: timestamp('date', { withTimezone: true }).notNull(),
    page: text('page').notNull(),
    query: text('query'),
    country: varchar('country', { length: 3 }),
    device: varchar('device', { length: 16 }),
    clicks: integer('clicks').notNull().default(0),
    impressions: integer('impressions').notNull().default(0),
    /** Stored ×100 as an integer to keep sums exact. */
    positionCentis: integer('position_centis'),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex('search_performance_daily_key').on(
      table.workspaceId,
      table.date,
      table.page,
      table.query,
      table.country,
      table.device,
    ),
    index('search_performance_daily_workspace_date_idx').on(table.workspaceId, table.date),
  ],
);

export const seoMetadataRelations = relations(seoMetadata, ({ one }) => ({
  entry: one(contentEntries, {
    fields: [seoMetadata.contentEntryId],
    references: [contentEntries.id],
  }),
}));

export const seoEntitiesRelations = relations(seoEntities, ({ many }) => ({
  outgoing: many(seoEntityRelations),
  pages: many(contentEntities),
}));
