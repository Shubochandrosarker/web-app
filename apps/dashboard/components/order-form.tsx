'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { saveOrder, type OrderItemPayload, type OrderPayload } from '@/lib/actions';

/**
 * Create/edit form for an order. Amounts are integers in minor units — the
 * form says so instead of pretending to be a currency input, because a wrong
 * assumption about decimal places is a real financial error.
 */
export function OrderForm({
  orderId,
  initial,
  canWrite,
  locked,
}: {
  readonly orderId: string | null;
  readonly initial: OrderPayload;
  readonly canWrite: boolean;
  /** True once the order has left draft/pending: items become read-only. */
  readonly locked: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState<OrderPayload>(initial);
  const [message, setMessage] = useState('');
  const [pending, startTransition] = useTransition();
  const disabled = !canWrite || pending || locked;

  const update = <K extends keyof OrderPayload>(key: K, next: OrderPayload[K]): void =>
    setValue((current) => ({ ...current, [key]: next }));

  const updateItem = (index: number, patch: Partial<OrderItemPayload>): void =>
    setValue((current) => ({
      ...current,
      items: current.items.map((item, at) => (at === index ? { ...item, ...patch } : item)),
    }));

  const addItem = (): void =>
    setValue((current) => ({
      ...current,
      items: [...current.items, { serviceId: null, name: '', quantity: 1, unitAmount: 0 }],
    }));

  const removeItem = (index: number): void =>
    setValue((current) => ({
      ...current,
      items: current.items.filter((_, at) => at !== index),
    }));

  const subtotal = value.items.reduce((sum, item) => sum + item.quantity * item.unitAmount, 0);
  const total = Math.max(0, subtotal - value.discountAmount);

  const save = (): void =>
    startTransition(async () => {
      // Once the order is locked only the notes remain editable.
      const result = await saveOrder(orderId, value, { notesOnly: locked && orderId !== null });
      setMessage(result.message ?? (result.ok ? 'Saved.' : 'Unable to save.'));
      if (result.ok && !orderId && result.id) router.push(`/orders/${result.id}`);
      if (result.ok && orderId) router.refresh();
    });

  return (
    <section className="panel">
      {orderId === null ? (
        <div className="form-grid">
          <div className="field field--wide">
            <label htmlFor="order-contact">Contact ID</label>
            <input
              id="order-contact"
              value={value.contactId}
              disabled={disabled}
              onChange={(event) => update('contactId', event.currentTarget.value)}
              placeholder="UUID from Contacts"
              required
            />
            <small className="muted">The customer this order belongs to.</small>
          </div>
          <div className="field">
            <label htmlFor="order-lead">Lead ID (optional)</label>
            <input
              id="order-lead"
              value={value.leadId ?? ''}
              disabled={disabled}
              onChange={(event) => update('leadId', event.currentTarget.value || null)}
            />
          </div>
          <div className="field">
            <label htmlFor="order-currency">Currency (ISO 4217)</label>
            <input
              id="order-currency"
              value={value.currency}
              disabled={disabled}
              onChange={(event) => update('currency', event.currentTarget.value.toUpperCase())}
              maxLength={3}
              placeholder="e.g. BDT"
              required
            />
          </div>
        </div>
      ) : null}

      <h2>Lines</h2>
      <p className="muted">
        Amounts are whole numbers in the currency's minor unit. Leave the service ID empty for a
        custom line; a named service fills the line name automatically.
      </p>
      <div className="table-scroll">
        <table className="data-table">
          <caption className="visually-hidden">Order lines</caption>
          <thead>
            <tr>
              <th scope="col">Service ID</th>
              <th scope="col">Name</th>
              <th scope="col">Qty</th>
              <th scope="col">Unit amount</th>
              <th scope="col">Line total</th>
              <th scope="col">
                <span className="visually-hidden">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {value.items.map((item, index) => (
              <tr key={index}>
                <td>
                  <label className="visually-hidden" htmlFor={`item-service-${index}`}>
                    Service ID for line {index + 1}
                  </label>
                  <input
                    id={`item-service-${index}`}
                    value={item.serviceId ?? ''}
                    disabled={disabled}
                    onChange={(event) =>
                      updateItem(index, { serviceId: event.currentTarget.value || null })
                    }
                  />
                </td>
                <td>
                  <label className="visually-hidden" htmlFor={`item-name-${index}`}>
                    Name for line {index + 1}
                  </label>
                  <input
                    id={`item-name-${index}`}
                    value={item.name}
                    disabled={disabled}
                    onChange={(event) => updateItem(index, { name: event.currentTarget.value })}
                  />
                </td>
                <td>
                  <label className="visually-hidden" htmlFor={`item-qty-${index}`}>
                    Quantity for line {index + 1}
                  </label>
                  <input
                    id={`item-qty-${index}`}
                    type="number"
                    min={1}
                    max={1000}
                    value={item.quantity}
                    disabled={disabled}
                    onChange={(event) =>
                      updateItem(index, { quantity: Number(event.currentTarget.value) || 1 })
                    }
                  />
                </td>
                <td>
                  <label className="visually-hidden" htmlFor={`item-unit-${index}`}>
                    Unit amount for line {index + 1}
                  </label>
                  <input
                    id={`item-unit-${index}`}
                    type="number"
                    min={0}
                    value={item.unitAmount}
                    disabled={disabled}
                    onChange={(event) =>
                      updateItem(index, { unitAmount: Number(event.currentTarget.value) || 0 })
                    }
                  />
                </td>
                <td>{item.quantity * item.unitAmount}</td>
                <td>
                  <button
                    type="button"
                    className="button"
                    disabled={disabled || value.items.length === 1}
                    onClick={() => removeItem(index)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="button" disabled={disabled} onClick={addItem}>
        Add line
      </button>

      <div className="form-grid">
        <div className="field">
          <label htmlFor="order-discount">Discount (minor units)</label>
          <input
            id="order-discount"
            type="number"
            min={0}
            value={value.discountAmount}
            disabled={disabled}
            onChange={(event) => update('discountAmount', Number(event.currentTarget.value) || 0)}
          />
        </div>
        <div className="field field--wide">
          <label htmlFor="order-notes">Notes</label>
          <textarea
            id="order-notes"
            rows={3}
            value={value.notes ?? ''}
            disabled={!canWrite || pending}
            onChange={(event) => update('notes', event.currentTarget.value || null)}
          />
        </div>
      </div>

      <p>
        Subtotal <strong>{subtotal}</strong> · Total <strong>{total}</strong> {value.currency}
      </p>
      {locked ? (
        <p className="muted">
          Lines and amounts are locked once an order is confirmed; the notes still save. Cancel and
          recreate the order for a different scope, or record an adjustment in the notes.
        </p>
      ) : null}
      {canWrite ? (
        <button type="button" className="button button--primary" onClick={save} disabled={pending}>
          {pending
            ? 'Saving…'
            : orderId
              ? locked
                ? 'Save notes'
                : 'Save changes'
              : 'Create order'}
        </button>
      ) : null}
      <p className="muted" role="status">
        {message}
      </p>
    </section>
  );
}
