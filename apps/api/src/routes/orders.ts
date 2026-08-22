import { randomUUID } from 'node:crypto';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace, type Database } from '@bos/database';
import { ApiError } from '../lib/errors.ts';
import { appendOutboxEvent } from '../lib/outbox.ts';
import { requirePermission } from '../lib/permissions.ts';
import { requireUserId, requireWorkspace } from '../lib/context.ts';
import { resolvePaymentProvider } from '../services/payment-provider.ts';
import type { AppContext } from '../app.ts';

/**
 * Orders: what was agreed, for how much, and what has actually been paid.
 *
 * Item rows snapshot service names and prices at order time; catalogue edits
 * never rewrite an order. Payments are records staff make (the `manual`
 * provider) — attributed, verifiable, refundable — with the PaymentProvider
 * abstraction as the seam where a gateway plugs in later. Payment does not
 * drive fulfilment: a fully-paid order still moves through its statuses by a
 * person's decision, because "paid" and "done" are different facts.
 */

const orderStatusEnum = z.enum(schema.orderStatus.enumValues);

const itemInput = z
  .object({
    serviceId: z.uuid().nullable().optional(),
    /** Required when no service is referenced; defaults to the service name. */
    name: z.string().min(1).max(200).optional(),
    quantity: z.number().int().min(1).max(1000).default(1),
    unitAmount: z.number().int().min(0).max(1_000_000_000),
  })
  .refine((item) => item.serviceId || item.name, {
    message: 'Each line needs a service or a name.',
  });

const orderInput = z.object({
  contactId: z.uuid(),
  leadId: z.uuid().nullable().optional(),
  currency: z.string().length(3).toUpperCase(),
  discountAmount: z.number().int().min(0).max(1_000_000_000).default(0),
  notes: z.string().max(10000).nullable().optional(),
  items: z.array(itemInput).min(1).max(100),
});

const orderPatch = z.object({
  notes: z.string().max(10000).nullable().optional(),
  discountAmount: z.number().int().min(0).max(1_000_000_000).optional(),
  items: z.array(itemInput).min(1).max(100).optional(),
});

const orderQuery = z.object({
  status: orderStatusEnum.optional(),
  contactId: z.uuid().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * The lifecycle, written out. Cancelling is allowed from every pre-terminal
 * state; a refund only makes sense after completion. Nothing skips backwards.
 */
const TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  draft: ['pending', 'confirmed', 'cancelled'],
  pending: ['confirmed', 'cancelled'],
  confirmed: ['in_progress', 'completed', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: ['refunded'],
  cancelled: [],
  refunded: [],
};

const PAYMENT_RECORDABLE = new Set(['pending', 'confirmed', 'in_progress', 'completed']);

interface ResolvedItem {
  readonly serviceId: string | null;
  readonly name: string;
  readonly quantity: number;
  readonly unitAmount: number;
  readonly totalAmount: number;
}

/**
 * Prove references and snapshot names/totals. Sequential lookups on purpose —
 * one transaction client cannot run queries concurrently.
 */
async function resolveItems(
  tx: Database,
  items: readonly z.infer<typeof itemInput>[],
): Promise<ResolvedItem[]> {
  const resolved: ResolvedItem[] = [];
  for (const item of items) {
    let name = item.name ?? null;
    if (item.serviceId) {
      const [service] = await tx
        .select({ id: schema.services.id, name: schema.services.name })
        .from(schema.services)
        .where(and(eq(schema.services.id, item.serviceId), isNull(schema.services.deletedAt)))
        .limit(1);
      if (!service) {
        throw ApiError.badRequest('Every linked record must belong to this workspace.');
      }
      name = name ?? service.name;
    }
    resolved.push({
      serviceId: item.serviceId ?? null,
      name: name!,
      quantity: item.quantity,
      unitAmount: item.unitAmount,
      totalAmount: item.quantity * item.unitAmount,
    });
  }
  return resolved;
}

function totals(items: readonly ResolvedItem[], discountAmount: number) {
  const subtotalAmount = items.reduce((sum, item) => sum + item.totalAmount, 0);
  if (discountAmount > subtotalAmount) {
    throw ApiError.badRequest('The discount cannot exceed the order subtotal.');
  }
  return { subtotalAmount, discountAmount, totalAmount: subtotalAmount - discountAmount };
}

async function assertOrderReferences(
  tx: Database,
  input: { contactId?: string | undefined; leadId?: string | null | undefined },
): Promise<void> {
  if (input.contactId) {
    const [contact] = await tx
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.id, input.contactId), isNull(schema.contacts.deletedAt)))
      .limit(1);
    if (!contact) throw ApiError.badRequest('Every linked record must belong to this workspace.');
  }
  if (input.leadId) {
    const [lead] = await tx
      .select({ id: schema.leads.id })
      .from(schema.leads)
      .where(and(eq(schema.leads.id, input.leadId), isNull(schema.leads.deletedAt)))
      .limit(1);
    if (!lead) throw ApiError.badRequest('Every linked record must belong to this workspace.');
  }
}

/** ORD-2026-000042: readable on a phone screen, unique per workspace. */
async function nextOrderNumber(tx: Database, attempt: number): Promise<string> {
  const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(schema.orders);
  const sequence = (row?.count ?? 0) + 1 + attempt;
  return `ORD-${new Date().getFullYear()}-${String(sequence).padStart(6, '0')}`;
}

function presentItem(row: typeof schema.orderItems.$inferSelect) {
  return {
    id: row.id,
    serviceId: row.serviceId,
    name: row.name,
    quantity: row.quantity,
    unitAmount: row.unitAmount,
    totalAmount: row.totalAmount,
    position: row.position,
  };
}

function presentPayment(row: typeof schema.payments.$inferSelect) {
  return {
    id: row.id,
    provider: row.provider,
    method: row.method,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    reference: row.reference,
    notes: row.notes,
    recordedByUserId: row.recordedByUserId,
    verifiedByUserId: row.verifiedByUserId,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    refundedAt: row.refundedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function presentOrder(
  row: typeof schema.orders.$inferSelect,
  extra: {
    contactName?: string | null;
    items?: readonly (typeof schema.orderItems.$inferSelect)[];
    payments?: readonly (typeof schema.payments.$inferSelect)[];
  } = {},
) {
  const verified = (extra.payments ?? []).filter((payment) => payment.status === 'verified');
  const paidAmount = verified.reduce((sum, payment) => sum + payment.amount, 0);
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    contactId: row.contactId,
    contactName: extra.contactName ?? null,
    leadId: row.leadId,
    status: row.status,
    currency: row.currency,
    subtotalAmount: row.subtotalAmount,
    discountAmount: row.discountAmount,
    totalAmount: row.totalAmount,
    notes: row.notes,
    placedAt: row.placedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelledReason: row.cancelledReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(extra.items ? { items: extra.items.map(presentItem) } : {}),
    ...(extra.payments
      ? {
          payments: extra.payments.map(presentPayment),
          paidAmount,
          balanceAmount: row.totalAmount - paidAmount,
        }
      : {}),
  };
}

async function scopedOrder(tx: Database, id: string) {
  const [row] = await tx
    .select({ order: schema.orders, contactName: schema.contacts.fullName })
    .from(schema.orders)
    .innerJoin(schema.contacts, eq(schema.contacts.id, schema.orders.contactId))
    .where(and(eq(schema.orders.id, id), isNull(schema.orders.deletedAt)))
    .limit(1);
  return row;
}

export function registerOrderRoutes(app: FastifyInstance, context: AppContext): void {
  const { db } = context;

  app.get(
    '/v1/orders',
    { config: { bosAccess: requirePermission('orders.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const query = orderQuery.parse(request.query);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const conditions = [isNull(schema.orders.deletedAt)];
        if (query.status) conditions.push(eq(schema.orders.status, query.status));
        if (query.contactId) conditions.push(eq(schema.orders.contactId, query.contactId));
        if (query.search) {
          conditions.push(
            or(
              ilike(schema.orders.orderNumber, `%${query.search}%`),
              ilike(schema.contacts.fullName, `%${query.search}%`),
            )!,
          );
        }

        const rows = await tx
          .select({ order: schema.orders, contactName: schema.contacts.fullName })
          .from(schema.orders)
          .innerJoin(schema.contacts, eq(schema.contacts.id, schema.orders.contactId))
          .where(and(...conditions))
          .orderBy(desc(schema.orders.createdAt))
          .limit(query.limit);

        return {
          items: rows.map((row) => presentOrder(row.order, { contactName: row.contactName })),
        };
      });
    },
  );

  app.get(
    '/v1/orders/:id',
    { config: { bosAccess: requirePermission('orders.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const params = z.object({ id: z.uuid() }).parse(request.params);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const row = await scopedOrder(tx, params.id);
        if (!row) throw ApiError.hidden('Order');

        const items = await tx
          .select()
          .from(schema.orderItems)
          .where(eq(schema.orderItems.orderId, params.id))
          .orderBy(schema.orderItems.position);
        const payments = await tx
          .select()
          .from(schema.payments)
          .where(eq(schema.payments.orderId, params.id))
          .orderBy(desc(schema.payments.createdAt));

        return {
          order: presentOrder(row.order, { contactName: row.contactName, items, payments }),
        };
      });
    },
  );

  app.post(
    '/v1/orders',
    { config: { bosAccess: requirePermission('orders.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const userId = requireUserId(request);
      const input = orderInput.parse(request.body);

      // The order number derives from a count, so two simultaneous creates can
      // collide on the unique index; retrying with a bumped sequence is cheaper
      // and simpler than a counter table at this scale.
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await withWorkspace(db, workspace.workspaceId, async (tx) => {
            await assertOrderReferences(tx, input);
            const items = await resolveItems(tx, input.items);
            const amounts = totals(items, input.discountAmount);
            const orderNumber = await nextOrderNumber(tx, attempt);

            const [order] = await tx
              .insert(schema.orders)
              .values({
                workspaceId: workspace.workspaceId,
                orderNumber,
                contactId: input.contactId,
                leadId: input.leadId ?? null,
                currency: input.currency,
                notes: input.notes ?? null,
                createdByUserId: userId,
                ...amounts,
              })
              .returning();

            await tx.insert(schema.orderItems).values(
              items.map((item, position) => ({
                workspaceId: workspace.workspaceId,
                orderId: order!.id,
                serviceId: item.serviceId,
                name: item.name,
                quantity: item.quantity,
                unitAmount: item.unitAmount,
                totalAmount: item.totalAmount,
                position,
              })),
            );

            await appendOutboxEvent(tx, workspace.workspaceId, {
              name: 'order.created',
              correlationId: randomUUID(),
              idempotencyKey: `order.created:${order!.id}`,
              actorUserId: userId,
              payload: {
                orderId: order!.id,
                orderNumber,
                contactId: input.contactId,
                totalAmount: amounts.totalAmount,
                currency: input.currency,
              },
            });

            const itemRows = await tx
              .select()
              .from(schema.orderItems)
              .where(eq(schema.orderItems.orderId, order!.id))
              .orderBy(schema.orderItems.position);
            return { order: presentOrder(order!, { items: itemRows, payments: [] }) };
          });
        } catch (error) {
          const unique =
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error as { code?: string }).code === '23505';
          if (!unique || attempt >= 3) throw error;
        }
      }
    },
  );

  app.patch(
    '/v1/orders/:id',
    { config: { bosAccess: requirePermission('orders.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const params = z.object({ id: z.uuid() }).parse(request.params);
      const input = orderPatch.parse(request.body);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const row = await scopedOrder(tx, params.id);
        if (!row) throw ApiError.hidden('Order');
        const current = row.order;

        const editable = current.status === 'draft' || current.status === 'pending';
        if ((input.items !== undefined || input.discountAmount !== undefined) && !editable) {
          throw ApiError.badRequest(
            'Items and amounts can only change while the order is draft or pending. ' +
              'Cancel and recreate it, or record an adjustment in the notes.',
          );
        }

        let amounts: {
          subtotalAmount: number;
          discountAmount: number;
          totalAmount: number;
        } | null = null;
        if (input.items !== undefined) {
          const items = await resolveItems(tx, input.items);
          amounts = totals(items, input.discountAmount ?? current.discountAmount);
          await tx.delete(schema.orderItems).where(eq(schema.orderItems.orderId, params.id));
          await tx.insert(schema.orderItems).values(
            items.map((item, position) => ({
              workspaceId: workspace.workspaceId,
              orderId: params.id,
              serviceId: item.serviceId,
              name: item.name,
              quantity: item.quantity,
              unitAmount: item.unitAmount,
              totalAmount: item.totalAmount,
              position,
            })),
          );
        } else if (input.discountAmount !== undefined) {
          const itemRows = await tx
            .select()
            .from(schema.orderItems)
            .where(eq(schema.orderItems.orderId, params.id));
          amounts = totals(
            itemRows.map((item) => ({ ...item, serviceId: item.serviceId })),
            input.discountAmount,
          );
        }

        const [updated] = await tx
          .update(schema.orders)
          .set({
            ...(input.notes !== undefined ? { notes: input.notes } : {}),
            ...(amounts ?? {}),
            updatedAt: new Date(),
          })
          .where(eq(schema.orders.id, params.id))
          .returning();

        const itemRows = await tx
          .select()
          .from(schema.orderItems)
          .where(eq(schema.orderItems.orderId, params.id))
          .orderBy(schema.orderItems.position);
        const payments = await tx
          .select()
          .from(schema.payments)
          .where(eq(schema.payments.orderId, params.id));
        return {
          order: presentOrder(updated!, {
            contactName: row.contactName,
            items: itemRows,
            payments,
          }),
        };
      });
    },
  );

  app.post(
    '/v1/orders/:id/status',
    { config: { bosAccess: requirePermission('orders.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const userId = requireUserId(request);
      const params = z.object({ id: z.uuid() }).parse(request.params);
      const input = z
        .object({ status: orderStatusEnum, reason: z.string().max(300).nullable().optional() })
        .parse(request.body);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const row = await scopedOrder(tx, params.id);
        if (!row) throw ApiError.hidden('Order');
        const current = row.order;

        const allowed = TRANSITIONS[current.status] ?? [];
        if (!allowed.includes(input.status)) {
          throw ApiError.badRequest(
            `An order cannot move from ${current.status} to ${input.status}. ` +
              `Allowed next states: ${allowed.length > 0 ? allowed.join(', ') : 'none — this state is terminal'}.`,
          );
        }

        const now = new Date();
        const [updated] = await tx
          .update(schema.orders)
          .set({
            status: input.status,
            ...(current.status === 'draft' ? { placedAt: now } : {}),
            ...(input.status === 'completed' ? { completedAt: now } : {}),
            ...(input.status === 'cancelled'
              ? { cancelledAt: now, cancelledReason: input.reason ?? null }
              : {}),
            updatedAt: now,
          })
          .where(eq(schema.orders.id, params.id))
          .returning();

        await appendOutboxEvent(tx, workspace.workspaceId, {
          name: 'order.status_changed',
          correlationId: randomUUID(),
          idempotencyKey: `order.status:${params.id}:${input.status}`,
          actorUserId: userId,
          payload: {
            orderId: params.id,
            orderNumber: current.orderNumber,
            fromStatus: current.status,
            toStatus: input.status,
          },
        });
        if (input.status === 'completed' || input.status === 'cancelled') {
          await appendOutboxEvent(tx, workspace.workspaceId, {
            name: input.status === 'completed' ? 'order.completed' : 'order.cancelled',
            correlationId: randomUUID(),
            idempotencyKey: `order.${input.status}:${params.id}`,
            actorUserId: userId,
            payload: {
              orderId: params.id,
              orderNumber: current.orderNumber,
              contactId: current.contactId,
              totalAmount: current.totalAmount,
              currency: current.currency,
            },
          });
        }

        return { order: presentOrder(updated!, { contactName: row.contactName }) };
      });
    },
  );

  app.post(
    '/v1/orders/:id/payments',
    { config: { bosAccess: requirePermission('orders.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const userId = requireUserId(request);
      const params = z.object({ id: z.uuid() }).parse(request.params);
      const provider = resolvePaymentProvider();
      const input = z
        .object({
          method: z.string().min(1).max(40),
          amount: z.number().int().min(1).max(1_000_000_000),
          reference: z.string().max(200).nullable().optional(),
          notes: z.string().max(2000).nullable().optional(),
          /** Manual payments are an attestation; unverified ones wait. */
          verified: z.boolean().default(true),
        })
        .parse(request.body);

      if (!provider.methods.includes(input.method)) {
        throw ApiError.badRequest(
          `The ${provider.name} payment provider records: ${provider.methods.join(', ')}.`,
        );
      }

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const row = await scopedOrder(tx, params.id);
        if (!row) throw ApiError.hidden('Order');
        if (!PAYMENT_RECORDABLE.has(row.order.status)) {
          throw ApiError.badRequest(`Payments cannot be recorded on a ${row.order.status} order.`);
        }

        const verified = input.verified && provider.staffVerifiable;
        const now = new Date();
        const [payment] = await tx
          .insert(schema.payments)
          .values({
            workspaceId: workspace.workspaceId,
            orderId: params.id,
            provider: provider.name,
            method: input.method,
            status: verified ? 'verified' : 'pending',
            amount: input.amount,
            currency: row.order.currency,
            reference: input.reference ?? null,
            notes: input.notes ?? null,
            recordedByUserId: userId,
            ...(verified ? { verifiedByUserId: userId, verifiedAt: now } : {}),
          })
          .returning();

        if (verified) {
          await appendOutboxEvent(tx, workspace.workspaceId, {
            name: 'payment.completed',
            correlationId: randomUUID(),
            idempotencyKey: `payment.completed:${payment!.id}`,
            actorUserId: userId,
            payload: {
              paymentId: payment!.id,
              orderId: params.id,
              amount: input.amount,
              currency: row.order.currency,
              method: input.method,
            },
          });
        }

        return { payment: presentPayment(payment!) };
      });
    },
  );

  app.post(
    '/v1/orders/:id/payments/:paymentId/verify',
    { config: { bosAccess: requirePermission('orders.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const userId = requireUserId(request);
      const params = z.object({ id: z.uuid(), paymentId: z.uuid() }).parse(request.params);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [payment] = await tx
          .select()
          .from(schema.payments)
          .where(
            and(eq(schema.payments.id, params.paymentId), eq(schema.payments.orderId, params.id)),
          )
          .limit(1);
        if (!payment) throw ApiError.hidden('Payment');
        if (payment.status !== 'pending') {
          throw ApiError.badRequest(`Only a pending payment can be verified.`);
        }

        const now = new Date();
        const [updated] = await tx
          .update(schema.payments)
          .set({ status: 'verified', verifiedByUserId: userId, verifiedAt: now, updatedAt: now })
          .where(eq(schema.payments.id, params.paymentId))
          .returning();

        await appendOutboxEvent(tx, workspace.workspaceId, {
          name: 'payment.completed',
          correlationId: randomUUID(),
          idempotencyKey: `payment.completed:${params.paymentId}`,
          actorUserId: userId,
          payload: {
            paymentId: params.paymentId,
            orderId: params.id,
            amount: payment.amount,
            currency: payment.currency,
            method: payment.method,
          },
        });

        return { payment: presentPayment(updated!) };
      });
    },
  );

  app.post(
    '/v1/orders/:id/payments/:paymentId/refund',
    { config: { bosAccess: requirePermission('orders.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const userId = requireUserId(request);
      const params = z.object({ id: z.uuid(), paymentId: z.uuid() }).parse(request.params);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [payment] = await tx
          .select()
          .from(schema.payments)
          .where(
            and(eq(schema.payments.id, params.paymentId), eq(schema.payments.orderId, params.id)),
          )
          .limit(1);
        if (!payment) throw ApiError.hidden('Payment');
        if (payment.status !== 'verified') {
          throw ApiError.badRequest('Only a verified payment can be refunded.');
        }

        const now = new Date();
        const [updated] = await tx
          .update(schema.payments)
          .set({ status: 'refunded', refundedAt: now, updatedAt: now })
          .where(eq(schema.payments.id, params.paymentId))
          .returning();

        await appendOutboxEvent(tx, workspace.workspaceId, {
          name: 'payment.refunded',
          correlationId: randomUUID(),
          idempotencyKey: `payment.refunded:${params.paymentId}`,
          actorUserId: userId,
          payload: {
            paymentId: params.paymentId,
            orderId: params.id,
            amount: payment.amount,
            currency: payment.currency,
          },
        });

        return { payment: presentPayment(updated!) };
      });
    },
  );
}
