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
import { metadata, primaryKeyColumn, softDelete, timestamps } from './_shared.ts';
import { contentType, mediaVisibility, publishStatus } from './enums.ts';
import { users, workspaces } from './identity.ts';

/**
 * Content: the internal CMS.
 *
 * A page is a row plus a `document` of sections (see @bos/sections). Storing
 * the layout as validated JSON rather than as HTML is what lets the same entry
 * render as a web page, feed a sitemap, and answer "does this page have an FAQ
 * section?" without parsing markup.
 */

export const contentEntries = pgTable(
  'content_entries',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: contentType('type').notNull(),
    slug: varchar('slug', { length: 140 }).notNull(),
    /** Full site path, materialised so route lookup is one indexed equality. */
    path: text('path').notNull(),
    locale: varchar('locale', { length: 10 }).notNull(),
    /**
     * Groups translations of the same page. All locales of one page share a
     * `translation_group_id`, which is how hreflang alternates are resolved
     * without a self-join table.
     */
    translationGroupId: uuid('translation_group_id').notNull().defaultRandom(),
    title: varchar('title', { length: 300 }).notNull(),
    excerpt: text('excerpt'),
    status: publishStatus('status').notNull().default('draft'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /** Section document, validated against the section registry before write. */
    document: jsonb('document')
      .notNull()
      .default(sql`'{"sections":[]}'::jsonb`),
    /** Type-specific structured fields, e.g. a service's linked `serviceId`. */
    fields: jsonb('fields')
      .notNull()
      .default(sql`'{}'::jsonb`),
    parentId: uuid('parent_id'),
    position: integer('position').notNull().default(0),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    metadata: metadata(),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    // One published path per locale. A duplicate path is a routing ambiguity,
    // so the database refuses it rather than letting the app pick a winner.
    uniqueIndex('content_entries_workspace_locale_path_key').on(
      table.workspaceId,
      table.locale,
      table.path,
    ),
    uniqueIndex('content_entries_workspace_type_locale_slug_key').on(
      table.workspaceId,
      table.type,
      table.locale,
      table.slug,
    ),
    index('content_entries_workspace_type_status_idx').on(
      table.workspaceId,
      table.type,
      table.status,
    ),
    index('content_entries_translation_group_idx').on(table.translationGroupId),
    index('content_entries_published_idx').on(table.workspaceId, table.publishedAt),
  ],
);

/**
 * Revision history. Every publish snapshots the document, so an editor can
 * restore, and so "when did this page's answer change?" is answerable when a
 * ranking moves.
 */
export const contentRevisions = pgTable(
  'content_revisions',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contentEntryId: uuid('content_entry_id')
      .notNull()
      .references(() => contentEntries.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    title: varchar('title', { length: 300 }).notNull(),
    document: jsonb('document').notNull(),
    fields: jsonb('fields')
      .notNull()
      .default(sql`'{}'::jsonb`),
    seo: jsonb('seo')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex('content_revisions_entry_revision_key').on(table.contentEntryId, table.revision),
    index('content_revisions_entry_idx').on(table.contentEntryId),
  ],
);

/**
 * Media. Public assets live in the public R2 bucket and are served from the
 * CDN; anything private is a *document*, not media, and belongs in the
 * documents table with signed access. The `visibility` column exists to make
 * that boundary explicit rather than implied by which bucket someone chose.
 */
export const media = pgTable(
  'media',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Object key within the bucket. Never a full URL — the CDN host can move. */
    objectKey: text('object_key').notNull(),
    visibility: mediaVisibility('visibility').notNull().default('public'),
    filename: varchar('filename', { length: 300 }).notNull(),
    mimeType: varchar('mime_type', { length: 140 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    width: integer('width'),
    height: integer('height'),
    /** Blurhash or dominant colour, so images reserve space and avoid CLS. */
    placeholder: varchar('placeholder', { length: 120 }),
    /** Default alt text; a usage may override it. See @bos/sections. */
    altText: varchar('alt_text', { length: 300 }),
    caption: text('caption'),
    checksumSha256: varchar('checksum_sha256', { length: 64 }),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    uniqueIndex('media_workspace_object_key_key').on(table.workspaceId, table.objectKey),
    index('media_workspace_idx').on(table.workspaceId),
    index('media_checksum_idx').on(table.workspaceId, table.checksumSha256),
  ],
);

export const navigationMenus = pgTable(
  'navigation_menus',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 140 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    locale: varchar('locale', { length: 10 }).notNull(),
    /** Nested `{ label, href, children[] }`. Depth is capped by the editor. */
    items: jsonb('items')
      .notNull()
      .default(sql`'[]'::jsonb`),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('navigation_menus_workspace_slug_locale_key').on(
      table.workspaceId,
      table.slug,
      table.locale,
    ),
  ],
);

/**
 * Redirects. Owned by the platform rather than the web server so an editor
 * changing a slug can create one without a deploy — the most common cause of
 * self-inflicted 404s after a site migration.
 */
export const redirects = pgTable(
  'redirects',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    fromPath: text('from_path').notNull(),
    toPath: text('to_path').notNull(),
    statusCode: smallint('status_code').notNull().default(301),
    /** Set when a slug change generated this automatically. */
    contentEntryId: uuid('content_entry_id').references(() => contentEntries.id, {
      onDelete: 'set null',
    }),
    hitCount: integer('hit_count').notNull().default(0),
    lastHitAt: timestamp('last_hit_at', { withTimezone: true }),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('redirects_workspace_from_key').on(table.workspaceId, table.fromPath),
    index('redirects_workspace_enabled_idx').on(table.workspaceId, table.enabled),
  ],
);

export const contentEntriesRelations = relations(contentEntries, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [contentEntries.workspaceId], references: [workspaces.id] }),
  author: one(users, { fields: [contentEntries.authorId], references: [users.id] }),
  revisions: many(contentRevisions),
}));

export const contentRevisionsRelations = relations(contentRevisions, ({ one }) => ({
  entry: one(contentEntries, {
    fields: [contentRevisions.contentEntryId],
    references: [contentEntries.id],
  }),
}));
