'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { recordOrderPayment, refundOrderPayment, setOrderStatus } from '@/lib/actions';

const NEXT_STATES: Readonly<Record<string, readonly string[]>> = {
  draft: ['pending', 'confirmed', 'cancelled'],
  pending: ['confirmed', 'cancelled'],
  confirmed: ['in_progress', 'completed', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: ['refunded'],
  cancelled: [],
  refunded: [],
};

const METHODS = ['cash', 'bank_transfer', 'bkash', 'nagad', 'card', 'other'] as const;

export function OrderStatusActions({
  orderId,
  status,
  canWrite,
}: {
  readonly orderId: string;
  readonly status: string;
  readonly canWrite: boolean;
}) {
  const router = useRouter();
  const [message, setMessage] = useState('');
  const [reason, setReason] = useState('');
  const [pending, startTransition] = useTransition();
  const nextStates = NEXT_STATES[status] ?? [];

  const move = (next: string): void =>
    startTransition(async () => {
      const result = await setOrderStatus(orderId, next, next === 'cancelled' ? reason : undefined);
      setMessage(result.message ?? '');
      if (result.ok) router.refresh();
    });

  if (!canWrite || nextStates.length === 0) {
    return nextStates.length === 0 ? (
      <p className="muted">This order is in a terminal state.</p>
    ) : null;
  }

  return (
    <div>
      <div className="toolbar">
        {nextStates.map((next) => (
          <button
            key={next}
            type="button"
            className={`button${next === 'completed' ? ' button--primary' : ''}`}
            disabled={pending}
            onClick={() => move(next)}
          >
            {next === 'cancelled' ? 'Cancel order' : `Mark ${next.replace('_', ' ')}`}
          </button>
        ))}
      </div>
      {nextStates.includes('cancelled') ? (
        <div className="field">
          <label htmlFor="cancel-reason">Cancellation reason (kept on the record)</label>
          <input
            id="cancel-reason"
            value={reason}
            disabled={pending}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
        </div>
      ) : null}
      <p className="muted" role="status">
        {message}
      </p>
    </div>
  );
}

export function RecordPaymentForm({
  orderId,
  currency,
  balanceAmount,
  canWrite,
}: {
  readonly orderId: string;
  readonly currency: string;
  readonly balanceAmount: number;
  readonly canWrite: boolean;
}) {
  const router = useRouter();
  const [method, setMethod] = useState<string>('cash');
  const [amount, setAmount] = useState<number>(balanceAmount > 0 ? balanceAmount : 0);
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [message, setMessage] = useState('');
  const [pending, startTransition] = useTransition();

  if (!canWrite) return null;

  const record = (): void =>
    startTransition(async () => {
      const result = await recordOrderPayment(orderId, {
        method,
        amount,
        reference: reference || null,
        notes: notes || null,
      });
      setMessage(result.message ?? '');
      if (result.ok) {
        setReference('');
        setNotes('');
        router.refresh();
      }
    });

  return (
    <div className="panel">
      <h3>Record a payment</h3>
      <p className="muted">
        A record of money already received and verified by you — cash counted, wallet SMS seen,
        transfer on the statement. Amounts are in minor units of {currency || 'the order currency'}.
      </p>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="payment-method">Method</label>
          <select
            id="payment-method"
            value={method}
            disabled={pending}
            onChange={(event) => setMethod(event.currentTarget.value)}
          >
            {METHODS.map((option) => (
              <option key={option} value={option}>
                {option.replace('_', ' ')}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="payment-amount">Amount (minor units)</label>
          <input
            id="payment-amount"
            type="number"
            min={1}
            value={amount}
            disabled={pending}
            onChange={(event) => setAmount(Number(event.currentTarget.value) || 0)}
          />
        </div>
        <div className="field">
          <label htmlFor="payment-reference">Reference</label>
          <input
            id="payment-reference"
            value={reference}
            disabled={pending}
            placeholder="Transaction ID, bank reference"
            onChange={(event) => setReference(event.currentTarget.value)}
          />
        </div>
        <div className="field field--wide">
          <label htmlFor="payment-notes">Notes</label>
          <input
            id="payment-notes"
            value={notes}
            disabled={pending}
            onChange={(event) => setNotes(event.currentTarget.value)}
          />
        </div>
      </div>
      <button
        type="button"
        className="button button--primary"
        disabled={pending || amount <= 0}
        onClick={record}
      >
        {pending ? 'Recording…' : 'Record payment'}
      </button>
      <p className="muted" role="status">
        {message}
      </p>
    </div>
  );
}

export function RefundPaymentButton({
  orderId,
  paymentId,
  canWrite,
}: {
  readonly orderId: string;
  readonly paymentId: string;
  readonly canWrite: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  if (!canWrite) return null;
  return (
    <button
      type="button"
      className="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await refundOrderPayment(orderId, paymentId);
          if (result.ok) router.refresh();
        })
      }
    >
      {pending ? 'Refunding…' : 'Mark refunded'}
    </button>
  );
}
