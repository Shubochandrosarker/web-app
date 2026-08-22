import { redirect } from 'next/navigation';
import { apiFetch, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';

export const metadata = { title: 'Orders' };
export const dynamic = 'force-dynamic';

interface OrderSummary {
  readonly id: string;
  readonly orderNumber: string;
  readonly contactName: string | null;
  readonly status: string;
  readonly currency: string;
  readonly totalAmount: number;
  readonly createdAt: string;
}

const STATUSES = [
  'draft',
  'pending',
  'confirmed',
  'in_progress',
  'completed',
  'cancelled',
  'refunded',
] as const;

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; search?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const params = await searchParams;
  const query = new URLSearchParams({ limit: '100' });
  if (params.status) query.set('status', params.status);
  if (params.search) query.set('search', params.search);
  const { items } = await apiFetch<{ items: OrderSummary[] }>(`/v1/orders?${query.toString()}`);

  return (
    <DashboardShell session={session} current="/orders">
      <div className="page-header">
        <div>
          <h1>Orders</h1>
          <p className="muted">What was agreed, for how much, and what has been paid.</p>
        </div>
        {can(session, 'orders.write') ? (
          <a className="button button--primary" href="/orders/new">
            New order
          </a>
        ) : null}
        <form className="toolbar" method="get">
          <label className="visually-hidden" htmlFor="order-search">
            Search orders
          </label>
          <input
            id="order-search"
            name="search"
            type="search"
            placeholder="Order number or contact"
            defaultValue={params.search ?? ''}
          />
          <select name="status" defaultValue={params.status ?? ''} aria-label="Filter by status">
            <option value="">Any status</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status.replace('_', ' ')}
              </option>
            ))}
          </select>
          <button type="submit" className="button">
            Filter
          </button>
        </form>
      </div>

      {items.length === 0 ? (
        <div className="panel">
          <h2>No orders yet</h2>
          <p className="muted">
            Orders record agreed work and its payments. Create the first one from a contact.
          </p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">Orders</caption>
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Contact</th>
                <th scope="col">Status</th>
                <th scope="col">Total</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {items.map((order) => (
                <tr key={order.id}>
                  <th scope="row">
                    <a href={`/orders/${order.id}`}>{order.orderNumber}</a>
                  </th>
                  <td>{order.contactName ?? '—'}</td>
                  <td>
                    <span className={`badge badge--${order.status}`}>
                      {order.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td>
                    {order.totalAmount} {order.currency}
                  </td>
                  <td>{new Date(order.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DashboardShell>
  );
}
