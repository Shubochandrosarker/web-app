import { redirect } from 'next/navigation';
import { can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { OrderForm } from '@/components/order-form';
import type { OrderPayload } from '@/lib/actions';

export const metadata = { title: 'New order' };
export const dynamic = 'force-dynamic';

export default async function NewOrderPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const initial: OrderPayload = {
    contactId: '',
    leadId: null,
    currency: '',
    discountAmount: 0,
    notes: null,
    items: [{ serviceId: null, name: '', quantity: 1, unitAmount: 0 }],
  };

  return (
    <DashboardShell session={session} current="/orders">
      <div className="page-header">
        <div>
          <h1>New order</h1>
          <p className="muted">
            Line amounts snapshot at creation — later catalogue edits never rewrite an order.
          </p>
        </div>
      </div>
      <OrderForm
        orderId={null}
        initial={initial}
        canWrite={can(session, 'orders.write')}
        locked={false}
      />
    </DashboardShell>
  );
}
