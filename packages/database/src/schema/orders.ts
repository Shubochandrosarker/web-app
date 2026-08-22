import { relations } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { metadata, primaryKeyColumn, softDelete, timestamps } from './_shared.ts';
import { orderStatus, paymentStatus } from './enums.ts';
import { workspaces, users } from './identity.ts';
import { services } from './business.ts';
import { contacts, leads } from './crm.ts';

/**
 * Orders: the money side of the operations modules.
 *
 * Designed for the businesses this platform actually serves first — services
 * sold person-to-person, paid by cash, bank transfer or a mobile wallet, and
 * verified by a human. So payments are *records staff make*, attributed and
 * auditable, not gateway webhooks; the `provider` column and the API's
 * PaymentProvider abstraction are where a gateway plugs in later without
 * reshaping this schema.
 *
 * Item rows snapshot the service name and price at order time: a catalogue
 * rename or price change must never rewrite what a customer already agreed
 * to. Amounts are integers in minor units throughout.
 */

export const orders = pgTable(
  'orders',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Human-readable, unique per workspace, e.g. ORD-2026-000042. */
    orderNumber: varchar('order_number', { length: 30 }).notNull(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
    status: orderStatus('status').notNull().default('draft'),
    currency: varchar('currency', { length: 3 }).notNull(),
    subtotalAmount: integer('subtotal_amount').notNull().default(0),
    discountAmount: integer('discount_amount').notNull().default(0),
    totalAmount: integer('total_amount').notNull().default(0),
    notes: text('notes'),
    /** When the order left draft — the moment it became a commitment. */
    placedAt: timestamp('placed_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledReason: varchar('cancelled_reason', { length: 300 }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    metadata: metadata(),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    uniqueIndex('orders_workspace_number_key').on(table.workspaceId, table.orderNumber),
    index('orders_workspace_status_idx').on(table.workspaceId, table.status),
    index('orders_contact_idx').on(table.contactId),
    index('orders_workspace_created_idx').on(table.workspaceId, table.createdAt),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /** Optional link back to the catalogue; the name below is the record. */
    serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
    /** Snapshot at order time — catalogue edits never rewrite an order. */
    name: varchar('name', { length: 200 }).notNull(),
    quantity: integer('quantity').notNull().default(1),
    unitAmount: integer('unit_amount').notNull(),
    totalAmount: integer('total_amount').notNull(),
    position: integer('position').notNull().default(0),
    ...timestamps,
  },
  (table) => [index('order_items_order_idx').on(table.orderId)],
);

export const payments = pgTable(
  'payments',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /** Which PaymentProvider recorded this. `manual` until a gateway exists. */
    provider: varchar('provider', { length: 40 }).notNull().default('manual'),
    /** cash, bank_transfer, bkash, nagad, card, other — validated at the API. */
    method: varchar('method', { length: 40 }).notNull(),
    status: paymentStatus('status').notNull().default('pending'),
    amount: integer('amount').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    /** Wallet transaction id, bank reference — whatever proves the transfer. */
    reference: varchar('reference', { length: 200 }),
    notes: text('notes'),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    verifiedByUserId: uuid('verified_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('payments_order_idx').on(table.orderId),
    index('payments_workspace_status_idx').on(table.workspaceId, table.status),
  ],
);

export const ordersRelations = relations(orders, ({ one, many }) => ({
  contact: one(contacts, { fields: [orders.contactId], references: [contacts.id] }),
  lead: one(leads, { fields: [orders.leadId], references: [leads.id] }),
  items: many(orderItems),
  payments: many(payments),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  service: one(services, { fields: [orderItems.serviceId], references: [services.id] }),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  order: one(orders, { fields: [payments.orderId], references: [orders.id] }),
}));
