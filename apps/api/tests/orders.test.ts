import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { schema, withoutTenantScope } from '@bos/database';
import {
  authHeaders,
  createHarness,
  createMember,
  createSecondaryWorkspace,
  login,
  type Harness,
} from './helpers.ts';

/**
 * The order lifecycle end to end: items snapshot the catalogue, totals are
 * computed server-side, statuses move only along the written-out transitions,
 * manual payments are attributed records with verify/refund — and every
 * reference is proven to belong to the workspace before it saves.
 */

let harness: Harness;
let managerHeaders: Record<string, string>;
let viewerHeaders: Record<string, string>;
let contactId: string;
let serviceId: string;

interface OrderBody {
  order: {
    id: string;
    orderNumber: string;
    status: string;
    subtotalAmount: number;
    discountAmount: number;
    totalAmount: number;
    items?: { name: string; totalAmount: number }[];
    payments?: { id: string; status: string }[];
    paidAmount?: number;
    balanceAmount?: number;
  };
}

before(async () => {
  harness = await createHarness();
  const manager = await createMember(harness, 'manager');
  const viewer = await createMember(harness, 'viewer');
  managerHeaders = authHeaders(harness, (await login(harness, manager.email)).accessToken);
  viewerHeaders = authHeaders(harness, (await login(harness, viewer.email)).accessToken);

  await withoutTenantScope(harness.db, async (tx) => {
    const [contact] = await tx
      .insert(schema.contacts)
      .values({
        workspaceId: harness.workspaceId,
        fullName: 'Order customer',
        email: `${randomUUID().slice(0, 8)}@example.test`,
      })
      .returning({ id: schema.contacts.id });
    contactId = contact!.id;
    const [service] = await tx
      .insert(schema.services)
      .values({
        workspaceId: harness.workspaceId,
        slug: `ordered-${randomUUID().slice(0, 8)}`,
        name: 'Transcript follow-up',
        status: 'published',
        priceAmount: 2500,
        priceCurrency: 'BDT',
      })
      .returning({ id: schema.services.id });
    serviceId = service!.id;
  });
});

after(async () => {
  await harness?.close();
});

async function createOrder(extra: Record<string, unknown> = {}): Promise<OrderBody['order']> {
  const created = await harness.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: managerHeaders,
    payload: {
      contactId,
      currency: 'BDT',
      items: [
        { serviceId, quantity: 2, unitAmount: 2500 },
        { name: 'Courier delivery', quantity: 1, unitAmount: 300 },
      ],
      ...extra,
    },
  });
  assert.equal(created.statusCode, 200, created.body);
  return (created.json() as OrderBody).order;
}

describe('orders', () => {
  it('enforces permissions', async () => {
    const denied = await harness.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: viewerHeaders,
      payload: { contactId, currency: 'BDT', items: [{ name: 'X', quantity: 1, unitAmount: 1 }] },
    });
    assert.equal(denied.statusCode, 403, denied.body);

    const listed = await harness.app.inject({
      method: 'GET',
      url: '/v1/orders',
      headers: viewerHeaders,
    });
    assert.equal(listed.statusCode, 200, 'viewers can read');
  });

  it('creates an order with snapshotted lines and server-side totals', async () => {
    const order = await createOrder({ discountAmount: 300 });
    assert.match(order.orderNumber, /^ORD-\d{4}-\d{6}$/);
    assert.equal(order.subtotalAmount, 5300);
    assert.equal(order.totalAmount, 5000);
    assert.equal(order.status, 'draft');
    assert.equal(order.items?.length, 2);
    assert.equal(order.items?.[0]?.name, 'Transcript follow-up', 'service name snapshotted');

    // Renaming the catalogue service must not rewrite the order line.
    const renamed = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/services/${serviceId}`,
      headers: managerHeaders,
      payload: { name: 'Renamed later' },
    });
    assert.equal(renamed.statusCode, 200, renamed.body);
    const detail = await harness.app.inject({
      method: 'GET',
      url: `/v1/orders/${order.id}`,
      headers: managerHeaders,
    });
    const body = detail.json() as OrderBody;
    assert.equal(body.order.items?.[0]?.name, 'Transcript follow-up');
  });

  it('refuses a discount larger than the subtotal', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: managerHeaders,
      payload: {
        contactId,
        currency: 'BDT',
        discountAmount: 10_000,
        items: [{ name: 'Small', quantity: 1, unitAmount: 100 }],
      },
    });
    assert.equal(created.statusCode, 400, created.body);
  });

  it('walks the lifecycle and blocks illegal jumps', async () => {
    const order = await createOrder();

    const illegal = await harness.app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/status`,
      headers: managerHeaders,
      payload: { status: 'completed' },
    });
    assert.equal(illegal.statusCode, 400, 'draft cannot jump to completed');

    for (const status of ['confirmed', 'in_progress', 'completed'] as const) {
      const moved = await harness.app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/status`,
        headers: managerHeaders,
        payload: { status },
      });
      assert.equal(moved.statusCode, 200, moved.body);
    }

    const refunded = await harness.app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/status`,
      headers: managerHeaders,
      payload: { status: 'refunded' },
    });
    assert.equal(refunded.statusCode, 200, refunded.body);

    const afterTerminal = await harness.app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/status`,
      headers: managerHeaders,
      payload: { status: 'confirmed' },
    });
    assert.equal(afterTerminal.statusCode, 400, 'refunded is terminal');
  });

  it('locks items after confirmation but keeps notes editable', async () => {
    const order = await createOrder();
    await harness.app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/status`,
      headers: managerHeaders,
      payload: { status: 'confirmed' },
    });

    const itemPatch = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/orders/${order.id}`,
      headers: managerHeaders,
      payload: { items: [{ name: 'Rewritten', quantity: 1, unitAmount: 1 }] },
    });
    assert.equal(itemPatch.statusCode, 400, itemPatch.body);

    const notesPatch = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/orders/${order.id}`,
      headers: managerHeaders,
      payload: { notes: 'Customer will collect on Thursday.' },
    });
    assert.equal(notesPatch.statusCode, 200, notesPatch.body);
  });

  it('records, sums and refunds manual payments', async () => {
    const order = await createOrder();
    await harness.app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/status`,
      headers: managerHeaders,
      payload: { status: 'confirmed' },
    });

    const rejectedMethod = await harness.app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/payments`,
      headers: managerHeaders,
      payload: { method: 'stripe_checkout', amount: 100 },
    });
    assert.equal(rejectedMethod.statusCode, 400, 'unknown method for the manual provider');

    const paid = await harness.app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/payments`,
      headers: managerHeaders,
      payload: { method: 'bkash', amount: 3000, reference: 'TX12345' },
    });
    assert.equal(paid.statusCode, 200, paid.body);

    const detail = await harness.app.inject({
      method: 'GET',
      url: `/v1/orders/${order.id}`,
      headers: managerHeaders,
    });
    const body = detail.json() as OrderBody;
    assert.equal(body.order.paidAmount, 3000);
    assert.equal(body.order.balanceAmount, body.order.totalAmount - 3000);

    const paymentId = body.order.payments?.[0]?.id;
    const refunded = await harness.app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/payments/${paymentId}/refund`,
      headers: managerHeaders,
      payload: {},
    });
    assert.equal(refunded.statusCode, 200, refunded.body);

    const again = await harness.app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/payments/${paymentId}/refund`,
      headers: managerHeaders,
      payload: {},
    });
    assert.equal(again.statusCode, 400, 'a refund is once');
  });

  it('refuses payments on a draft order', async () => {
    const order = await createOrder();
    const paid = await harness.app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/payments`,
      headers: managerHeaders,
      payload: { method: 'cash', amount: 100 },
    });
    assert.equal(paid.statusCode, 400, paid.body);
  });

  it('rejects references from another workspace', async () => {
    const other = await createSecondaryWorkspace(harness);
    try {
      const [foreignContact] = await withoutTenantScope(harness.db, (tx) =>
        tx
          .insert(schema.contacts)
          .values({ workspaceId: other.workspaceId, fullName: 'Foreign customer' })
          .returning({ id: schema.contacts.id }),
      );
      const [foreignService] = await withoutTenantScope(harness.db, (tx) =>
        tx
          .insert(schema.services)
          .values({
            workspaceId: other.workspaceId,
            slug: 'foreign-service',
            name: 'Foreign service',
          })
          .returning({ id: schema.services.id }),
      );

      const foreignContactOrder = await harness.app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: managerHeaders,
        payload: {
          contactId: foreignContact!.id,
          currency: 'BDT',
          items: [{ name: 'X', quantity: 1, unitAmount: 100 }],
        },
      });
      assert.equal(foreignContactOrder.statusCode, 400, foreignContactOrder.body);

      const foreignServiceOrder = await harness.app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: managerHeaders,
        payload: {
          contactId,
          currency: 'BDT',
          items: [{ serviceId: foreignService!.id, quantity: 1, unitAmount: 100 }],
        },
      });
      assert.equal(foreignServiceOrder.statusCode, 400, foreignServiceOrder.body);
    } finally {
      await other.drop();
    }
  });

  it('hides an order that does not exist in this workspace', async () => {
    const detail = await harness.app.inject({
      method: 'GET',
      url: `/v1/orders/${randomUUID()}`,
      headers: managerHeaders,
    });
    assert.equal(detail.statusCode, 404, detail.body);
  });
});
