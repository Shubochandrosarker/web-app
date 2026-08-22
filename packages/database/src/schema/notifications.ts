import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { primaryKeyColumn, timestamps } from './_shared.ts';
import { users, workspaces } from './identity.ts';

/**
 * In-app notifications: things a person should notice without living in the
 * audit log — a rejected document, a review waiting for moderation, a failed
 * automation run.
 *
 * Rows are **per recipient**: the emitter fans out to the relevant members
 * at insert time, so "read" is a single honest column instead of a join
 * table, and deleting a member deletes their queue. Notifications carry a
 * link and a summary, never secrets or document contents.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** e.g. `document.rejected`, `review.received`, `automation.failed`. */
    kind: varchar('kind', { length: 60 }).notNull(),
    severity: varchar('severity', { length: 10 }).notNull().default('info'),
    title: varchar('title', { length: 300 }).notNull(),
    body: text('body'),
    /** Dashboard path the notification opens, e.g. `/reviews`. */
    href: varchar('href', { length: 600 }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    index('notifications_user_unread_idx').on(table.userId, table.readAt, table.createdAt),
    index('notifications_workspace_idx').on(table.workspaceId, table.createdAt),
  ],
);

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}));
