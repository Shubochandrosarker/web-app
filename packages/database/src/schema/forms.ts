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
import { documentStatus } from './enums.ts';
import { users, workspaces } from './identity.ts';
import { contacts, leads } from './crm.ts';

/**
 * Forms and document intake.
 *
 * The documents table is the most security-sensitive in the platform. It holds
 * pointers to certificates, transcripts and ID scans — never the files
 * themselves, and never a public URL. Access is always: authorise the request,
 * mint a short-lived signed URL, write an audit row. There is no code path
 * that returns a permanent link to a private object.
 */

export const forms = pgTable(
  'forms',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 140 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    /** Field definitions; validated into a zod schema at request time. */
    fields: jsonb('fields')
      .notNull()
      .default(sql`'[]'::jsonb`),
    submitLabel: varchar('submit_label', { length: 100 }).notNull().default('Submit'),
    successMessage: text('success_message'),
    /** Where a submission goes: create a lead, a booking, or just a record. */
    outcome: varchar('outcome', { length: 40 }).notNull().default('lead'),
    /** Pipeline/stage/service applied to leads this form creates. */
    outcomeConfig: jsonb('outcome_config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    notifyEmails: jsonb('notify_emails')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Honeypot field name plus minimum fill time, in seconds. */
    spamConfig: jsonb('spam_config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    requiresConsent: boolean('requires_consent').notNull().default(true),
    consentText: text('consent_text'),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps,
    ...softDelete,
  },
  (table) => [uniqueIndex('forms_workspace_slug_key').on(table.workspaceId, table.slug)],
);

export const formSubmissions = pgTable(
  'form_submissions',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    formId: uuid('form_id')
      .notNull()
      .references(() => forms.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    /** The submitted values, exactly as validated. Never re-shaped on write. */
    payload: jsonb('payload').notNull(),
    attribution: jsonb('attribution')
      .notNull()
      .default(sql`'{}'::jsonb`),
    landingPath: text('landing_path'),
    /**
     * Truncated to a /24 (or /48) before storage. Enough for rate limiting and
     * spam analysis, short of retaining a precise identifier indefinitely.
     */
    ipPrefix: varchar('ip_prefix', { length: 45 }),
    userAgent: text('user_agent'),
    spamScore: integer('spam_score').notNull().default(0),
    isSpam: boolean('is_spam').notNull().default(false),
    consentGivenAt: timestamp('consent_given_at', { withTimezone: true }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index('form_submissions_form_created_idx').on(table.formId, table.createdAt),
    index('form_submissions_workspace_created_idx').on(table.workspaceId, table.createdAt),
    index('form_submissions_contact_idx').on(table.contactId),
  ],
);

/**
 * A private uploaded file.
 *
 * Notice what is *not* here: no URL, no public bucket, no `is_public` flag.
 * The object lives in the private bucket, keyed by `object_key`, and the only
 * way to read it is through an authorised request that mints a signed URL with
 * a short expiry.
 */
export const documents = pgTable(
  'documents',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    /** What this is, e.g. `transcript`, `national_id`, `passport_photo`. */
    kind: varchar('kind', { length: 64 }).notNull(),
    /** Key in the private bucket. Never rendered into a page or an event. */
    objectKey: text('object_key').notNull(),
    /** The name the uploader gave it, sanitised. Shown in the dashboard. */
    originalFilename: varchar('original_filename', { length: 300 }).notNull(),
    /** Sniffed server-side; the client-declared type is not trusted. */
    mimeType: varchar('mime_type', { length: 140 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    checksumSha256: varchar('checksum_sha256', { length: 64 }).notNull(),
    /*
     * The DB-level default stays 'uploaded' even though new rows begin life
     * as 'pending_upload': Postgres refuses to *use* a new enum value in the
     * transaction that adds it, so a migration could not both add the value
     * and make it the default. Every insert sets status explicitly.
     */
    status: documentStatus('status').notNull().default('uploaded'),
    /**
     * SHA-256 of the one-shot claim token issued with the upload URL.
     *
     * Possession of the token — not knowledge of the document id — is what
     * lets a later form submission attach this document. Ids appear in
     * network logs and error messages; the token appears exactly once, in
     * the upload-authorisation response to whoever asked for it.
     */
    claimTokenHash: varchar('claim_token_hash', { length: 64 }),
    /** When server-side verification (size, signature, checksum) passed. */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    scannedAt: timestamp('scanned_at', { withTimezone: true }),
    scanResult: jsonb('scan_result')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /**
     * Retention. Set at upload from the workspace's policy; a nightly job
     * deletes the object and marks the row. Sensitive documents having no
     * expiry is a decision, and it should be an explicit one.
     */
    retainUntil: timestamp('retain_until', { withTimezone: true }),
    deletedFromStorageAt: timestamp('deleted_from_storage_at', { withTimezone: true }),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    uniqueIndex('documents_workspace_object_key_key').on(table.workspaceId, table.objectKey),
    index('documents_contact_idx').on(table.contactId),
    index('documents_lead_idx').on(table.leadId),
    index('documents_workspace_status_idx').on(table.workspaceId, table.status),
    index('documents_retain_until_idx').on(table.retainUntil),
  ],
);

/**
 * Every issuance of a signed URL and every download.
 *
 * Append-only, and written before the URL is returned rather than after — if
 * the audit write fails, the caller does not get a link.
 */
export const documentAccessLog = pgTable(
  'document_access_log',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** `url_issued`, `downloaded`, `deleted`, `denied`. */
    action: varchar('action', { length: 40 }).notNull(),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    /** Expiry of the URL that was issued, so a leaked link can be bounded. */
    urlExpiresAt: timestamp('url_expires_at', { withTimezone: true }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index('document_access_log_document_idx').on(table.documentId, table.createdAt),
    index('document_access_log_user_idx').on(table.userId, table.createdAt),
  ],
);

export const formsRelations = relations(forms, ({ many }) => ({
  submissions: many(formSubmissions),
}));

export const formSubmissionsRelations = relations(formSubmissions, ({ one }) => ({
  form: one(forms, { fields: [formSubmissions.formId], references: [forms.id] }),
  contact: one(contacts, { fields: [formSubmissions.contactId], references: [contacts.id] }),
  lead: one(leads, { fields: [formSubmissions.leadId], references: [leads.id] }),
}));

export const documentsRelations = relations(documents, ({ one, many }) => ({
  contact: one(contacts, { fields: [documents.contactId], references: [contacts.id] }),
  accessLog: many(documentAccessLog),
}));
