'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { sendLeadWhatsapp, type ActionResult } from '@/lib/actions';
import { RelativeTime } from '@/components/relative-time';

/**
 * The communications panel on a lead: everything sent and received about
 * this enquiry, and the one manual send — a WhatsApp template.
 *
 * Templates only, by design: outside the 24-hour service window Meta
 * silently drops free text, which for a customer-facing message is the worst
 * failure mode there is. The picker cannot be misused into it.
 */

export interface MessageRow {
  readonly id: string;
  readonly channel: string;
  readonly direction: string;
  readonly status: string;
  readonly toAddress: string;
  readonly fromAddress: string;
  readonly subject: string | null;
  readonly body: string | null;
  readonly failureReason: string | null;
  readonly leadId: string | null;
  readonly contactId: string | null;
  readonly sentAt: string | null;
  readonly createdAt: string;
}

export interface TemplateOption {
  readonly slug: string;
  readonly name: string;
  readonly body: string;
  readonly variables: readonly string[];
}

const STATUS_BADGE: Record<string, string> = {
  queued: 'scheduled',
  sent: 'open',
  delivered: 'won',
  read: 'won',
  received: 'open',
  failed: 'lost',
  bounced: 'lost',
};

export function LeadMessages({
  leadId,
  messages,
  templates,
  canSend,
}: {
  readonly leadId: string;
  readonly messages: readonly MessageRow[];
  readonly templates: readonly TemplateOption[];
  readonly canSend: boolean;
}) {
  const router = useRouter();
  const [templateSlug, setTemplateSlug] = useState('');
  const [variables, setVariables] = useState<string[]>([]);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const selected = templates.find((template) => template.slug === templateSlug);
  const variableCount = selected
    ? Math.max(
        selected.variables.length,
        ...[...selected.body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1])),
        0,
      )
    : 0;

  const send = (): void => {
    if (!templateSlug) return;
    startTransition(async () => {
      const outcome = await sendLeadWhatsapp(
        leadId,
        templateSlug,
        variables.slice(0, variableCount),
      );
      setResult(outcome);
      if (outcome.ok) {
        setTemplateSlug('');
        setVariables([]);
        router.refresh();
      }
    });
  };

  return (
    <section className="panel" aria-labelledby="lead-messages-heading">
      <h2 id="lead-messages-heading">Communications</h2>

      {result?.message ? (
        <p
          className={result.ok ? 'form-success' : 'form-error'}
          role={result.ok ? 'status' : 'alert'}
        >
          {result.message}
        </p>
      ) : null}

      {canSend && templates.length > 0 ? (
        <div className="send-whatsapp">
          <div className="field">
            <label htmlFor="wa-template">Send a WhatsApp template</label>
            <select
              id="wa-template"
              value={templateSlug}
              disabled={pending}
              onChange={(event) => {
                setTemplateSlug(event.currentTarget.value);
                setVariables([]);
                setResult(null);
              }}
            >
              <option value="">Choose a template…</option>
              {templates.map((template) => (
                <option key={template.slug} value={template.slug}>
                  {template.name}
                </option>
              ))}
            </select>
          </div>

          {selected ? (
            <>
              <p className="field-help">{selected.body}</p>
              {Array.from({ length: variableCount }, (_, index) => (
                <div className="field" key={index}>
                  <label htmlFor={`wa-var-${index}`}>{`Value for {{${index + 1}}}`}</label>
                  <input
                    id={`wa-var-${index}`}
                    value={variables[index] ?? ''}
                    maxLength={500}
                    disabled={pending}
                    onChange={(event) => {
                      const next = [...variables];
                      next[index] = event.currentTarget.value;
                      setVariables(next);
                    }}
                  />
                </div>
              ))}
              <button
                type="button"
                className="button button--primary"
                disabled={pending}
                onClick={send}
              >
                {pending ? 'Sending…' : 'Send WhatsApp'}
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {messages.length === 0 ? (
        <p className="muted">Nothing sent or received about this enquiry yet.</p>
      ) : (
        <ol className="message-list">
          {messages.map((message) => (
            <li
              key={message.id}
              className={
                message.direction === 'inbound' ? 'message-row message-row--inbound' : 'message-row'
              }
            >
              <div className="message-meta">
                <span>
                  {message.direction === 'inbound' ? 'From' : 'To'}{' '}
                  <strong>
                    {message.direction === 'inbound' ? message.fromAddress : message.toAddress}
                  </strong>{' '}
                  · {message.channel}
                </span>
                <span>
                  <span className={`badge badge--${STATUS_BADGE[message.status] ?? 'muted'}`}>
                    {message.status}
                  </span>{' '}
                  <RelativeTime iso={message.sentAt ?? message.createdAt} />
                </span>
              </div>
              {message.subject ? <p className="message-subject">{message.subject}</p> : null}
              {message.body ? <p className="message-body">{message.body}</p> : null}
              {message.failureReason ? (
                <p className="field-error">Failed: {message.failureReason}</p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
