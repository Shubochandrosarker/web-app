import { notFound, redirect } from 'next/navigation';
import { apiFetch, ApiRequestError, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { OrderForm } from '@/components/order-form';
import {
  OrderStatusActions,
  RecordPaymentForm,
  RefundPaymentButton,
} from '@/components/order-actions';
import type { OrderPayload } from '@/lib/actions';

export const metadata = { title: 'Order' };
export const dynamic = 'force-dynamic';

interface OrderDetail {
  readonly id: string;
  readonly orderNumber: string;
  readonly contactId: string;
  readonly contactName: string | null;
  readonly leadId: string | null;
  readonly status: string;
  readonly currency: string;
  readonly subtotalAmount: number;
  readonly discountAmount: number;
  readonly totalAmount: number;
  readonly notes: string | null;
  readonly placedAt: string | null;
  readonly cancelledReason: string | null;
  readonly items: readonly {
    readonly id: string;
    readonly serviceId: string | null;
    readonly name: string;
    readonly quantity: number;
    readonly unitAmount: number;
    readonly totalAmount: number;
  }[];
  readonly payments: readonly {
    readonly id: string;
    readonly method: string;
    readonly status: string;
    readonly amount: number;
    readonly currency: string;
    readonly reference: string | null;
    readonly verifiedAt: string | null;
    readonly createdAt: string;
  }[];
  readonly paidAmount: number;
  readonly balanceAmount: number;
}

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const { id } = await params;

  let order: OrderDetail;
  try {
    ({ order } = await apiFetch<{ order: OrderDetail }>(`/v1/orders/${id}`));
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) notFound();
    throw error;
  }

  const canWrite = can(session, 'orders.write');
  const locked = order.status !== 'draft' && order.status !== 'pending';
  const initial: OrderPayload = {
    contactId: order.contactId,
    leadId: order.leadId,
    currency: order.currency,
    discountAmount: order.discountAmount,
    notes: order.notes,
    items: order.items.map((item) => ({
      serviceId: item.serviceId,
      name: item.name,
      quantity: item.quantity,
      unitAmount: item.unitAmount,
    })),
  };

  return (
    <DashboardShell session={session} current="/orders">
      <div className="page-header">
        <div>
          <h1>{order.orderNumber}</h1>
          <p className="muted">
            {order.contactName ?? 'Unknown contact'} ·{' '}
            <span className={`badge badge--${order.status}`}>{order.status.replace('_', ' ')}</span>
            {order.cancelledReason ? ` · ${order.cancelledReason}` : ''}
          </p>
        </div>
        <a className="button" href="/orders">
          Back to orders
        </a>
      </div>

      <section className="panel">
        <h2>Money</h2>
        <p>
          Total <strong>{order.totalAmount}</strong> {order.currency} · Paid{' '}
          <strong>{order.paidAmount}</strong> · Balance <strong>{order.balanceAmount}</strong>
        </p>
        <OrderStatusActions orderId={order.id} status={order.status} canWrite={canWrite} />
      </section>

      <OrderForm orderId={order.id} initial={initial} canWrite={canWrite} locked={locked} />

      <section className="panel">
        <h2>Payments</h2>
        {order.payments.length === 0 ? (
          <p className="muted">No payments recorded.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <caption className="visually-hidden">Payments</caption>
              <thead>
                <tr>
                  <th scope="col">Method</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Status</th>
                  <th scope="col">Reference</th>
                  <th scope="col">Recorded</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {order.payments.map((payment) => (
                  <tr key={payment.id}>
                    <th scope="row">{payment.method.replace('_', ' ')}</th>
                    <td>
                      {payment.amount} {payment.currency}
                    </td>
                    <td>
                      <span className={`badge badge--${payment.status}`}>{payment.status}</span>
                    </td>
                    <td>{payment.reference ?? '—'}</td>
                    <td>{new Date(payment.createdAt).toLocaleString()}</td>
                    <td>
                      {payment.status === 'verified' ? (
                        <RefundPaymentButton
                          orderId={order.id}
                          paymentId={payment.id}
                          canWrite={canWrite}
                        />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {order.status !== 'draft' && order.status !== 'cancelled' && order.status !== 'refunded' ? (
        <RecordPaymentForm
          orderId={order.id}
          currency={order.currency}
          balanceAmount={order.balanceAmount}
          canWrite={canWrite}
        />
      ) : null}
    </DashboardShell>
  );
}
