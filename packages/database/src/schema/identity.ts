import { relations, sql } from 'drizzle-orm';
import {
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
import { userStatus, workspaceRole, workspaceStatus, businessTypeEnum } from './enums.ts';

/**
 * Identity and tenancy.
 *
 * `workspaces` is the tenant boundary. Everything else in the platform hangs
 * off it, and row-level security is written against `workspace_id` alone —
 * which is why that column is repeated on child tables instead of being
 * reached through joins.
 */

export const users = pgTable(
  'users',
  {
    id: primaryKeyColumn(),
    email: varchar('email', { length: 320 }).notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    /** Argon2id. Null for users who only ever sign in through a provider. */
    passwordHash: varchar('password_hash', { length: 255 }),
    fullName: varchar('full_name', { length: 200 }),
    avatarUrl: text('avatar_url'),
    locale: varchar('locale', { length: 10 }).notNull().default('en'),
    timeZone: varchar('time_zone', { length: 64 }).notNull().default('UTC'),
    mfaSecret: varchar('mfa_secret', { length: 255 }),
    mfaEnabledAt: timestamp('mfa_enabled_at', { withTimezone: true }),
    /**
     * SHA-256 of each unused recovery code.
     *
     * In the database rather than in Redis because these are the credential of
     * last resort: a cache flush must not be able to lock every MFA user out
     * of their own account. Emptied when MFA is disabled or codes are
     * regenerated.
     */
    mfaRecoveryCodeHashes: jsonb('mfa_recovery_code_hashes')
      .notNull()
      .default(sql`'[]'::jsonb`),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    /** Cleared on every successful login; gates throttling and lockout. */
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    status: userStatus('status').notNull().default('invited'),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    // Case-insensitive uniqueness: Email addresses are not case-sensitive in
    // practice, and two accounts differing only in case is an account-takeover
    // vector, not a feature.
    uniqueIndex('users_email_lower_key').on(sql`lower(${table.email})`),
    index('users_status_idx').on(table.status),
  ],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: primaryKeyColumn(),
    slug: varchar('slug', { length: 140 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    businessType: businessTypeEnum('business_type').notNull(),
    status: workspaceStatus('status').notNull().default('active'),
    /** Canonical site origin, no trailing slash. */
    siteUrl: text('site_url').notNull(),
    defaultLocale: varchar('default_locale', { length: 10 }).notNull().default('en'),
    supportedLocales: jsonb('supported_locales')
      .notNull()
      .default(sql`'["en"]'::jsonb`),
    timeZone: varchar('time_zone', { length: 64 }).notNull().default('UTC'),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    /**
     * Resolved module list, written by the config loader. Stored rather than
     * recomputed so the API can authorise a request without loading and
     * resolving the whole tenant config on every call.
     */
    enabledModules: jsonb('enabled_modules')
      .notNull()
      .default(sql`'[]'::jsonb`),
    featureFlags: jsonb('feature_flags')
      .notNull()
      .default(sql`'{}'::jsonb`),
    metadata: metadata(),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    uniqueIndex('workspaces_slug_key').on(table.slug),
    index('workspaces_status_idx').on(table.status),
  ],
);

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: workspaceRole('role').notNull().default('staff'),
    /**
     * Grants beyond the role, e.g. `["documents.download"]`. Additive only —
     * a permission list can never widen past what the role forbids outright.
     */
    extraPermissions: jsonb('extra_permissions')
      .notNull()
      .default(sql`'[]'::jsonb`),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('workspace_members_workspace_user_key').on(table.workspaceId, table.userId),
    index('workspace_members_user_idx').on(table.userId),
  ],
);

export const workspaceInvitations = pgTable(
  'workspace_invitations',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 320 }).notNull(),
    role: workspaceRole('role').notNull().default('staff'),
    /** SHA-256 of the invite token. The token itself is never stored. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    uniqueIndex('workspace_invitations_token_key').on(table.tokenHash),
    index('workspace_invitations_workspace_idx').on(table.workspaceId, table.email),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: primaryKeyColumn(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the refresh token. Rotated on every refresh. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    /** Set when this session's token is rotated, for reuse detection. */
    replacedBySessionId: uuid('replaced_by_session_id'),
    userAgent: text('user_agent'),
    ipAddress: varchar('ip_address', { length: 45 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamps.createdAt,
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('sessions_token_key').on(table.tokenHash),
    index('sessions_user_idx').on(table.userId),
    index('sessions_expires_idx').on(table.expiresAt),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    /** Displayed in the UI so a key can be identified without revealing it. */
    prefix: varchar('prefix', { length: 12 }).notNull(),
    keyHash: varchar('key_hash', { length: 64 }).notNull(),
    scopes: jsonb('scopes')
      .notNull()
      .default(sql`'[]'::jsonb`),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('api_keys_hash_key').on(table.keyHash),
    index('api_keys_workspace_idx').on(table.workspaceId),
  ],
);

/**
 * Append-only audit trail. Written for authentication events, permission
 * changes and every access to a private document — the three things you need
 * to be able to answer questions about after the fact.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** e.g. `document.downloaded`, `member.role_changed`, `auth.login_failed`. */
    action: varchar('action', { length: 120 }).notNull(),
    entityType: varchar('entity_type', { length: 64 }),
    entityId: uuid('entity_id'),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    /** Before/after for changes; request context for reads. */
    detail: jsonb('detail')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index('audit_log_workspace_created_idx').on(table.workspaceId, table.createdAt),
    index('audit_log_entity_idx').on(table.entityType, table.entityId),
    index('audit_log_actor_idx').on(table.actorUserId),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(workspaceMembers),
  sessions: many(sessions),
}));

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  members: many(workspaceMembers),
  invitations: many(workspaceInvitations),
  apiKeys: many(apiKeys),
}));

export const workspaceMembersRelations = relations(workspaceMembers, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceMembers.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, { fields: [workspaceMembers.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));
