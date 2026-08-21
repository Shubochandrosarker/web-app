import { apiFetch } from '@/lib/api';
import { RelativeTime } from '@/components/relative-time';
import type { MessageRow } from '@/components/lead-messages';

/**
 * One channel's traffic, server-rendered.
 *
 * The failure filter is the point of the screen: a failed acknowledgement is
 * a customer who thinks they were ignored, and the reason the provider gave
 * is right here rather than in a log.
 */

const STATUS_BADGE: Record<string, string> = {
  queued: 'scheduled',
  sent: 'open',
  delivered: 'won',
  read: 'won',
  received: 'open',
  failed: 'lost',
  bounced: 'lost',
};

export async function ChannelMessages({
  channel,
  title,
  description,
  status,
  direction,
}: {
  readonly channel: 'email' | 'whatsapp';
  readonly title: string;
  readonly description: string;
  readonly status?: string | undefined;
  readonly direction?: string | undefined;
}) {
  const query = new URLSearchParams({ channel, limit: '100' });
  if (status) query.set('status', status);
  if (direction) query.set('direction', direction);

  const { items } = await apiFetch<{ items: MessageRow[] }>(
    `/v1/crm/messages?${query.toString()}`,
  ).catch(() => ({ items: [] as MessageRow[] }));

  const failedCount = items.filter(
    (message) => message.status === 'failed' || message.status === 'bounced',
  ).length;

  const base = channel === 'email' ? '/email' : '/whatsapp';

  return (
    <>
      <div className="page-header">
        <div>
          <h1>{title}</h1>
          <p className="muted">{description}</p>
        </div>
      </div>

      <nav className="view-switch" aria-label={`${title} views`}>
        <a href={base} className={!status && !direction ? 'active' : ''}>
          All
        </a>
        <a href={`${base}?status=failed`} className={status === 'failed' ? 'active' : ''}>
          Failed{failedCount > 0 ? ` (${failedCount})` : ''}
        </a>
        {channel === 'whatsapp' ? (
          <a href={`${base}?direction=inbound`} className={direction === 'inbound' ? 'active' : ''}>
            Inbound
          </a>
        ) : null}
      </nav>

      {items.length === 0 ? (
        <div className="panel">
          <h2>Nothing here</h2>
          <p className="muted">
            {status === 'failed'
              ? 'No failures — every message went through.'
              : 'Messages appear as the platform sends and receives them.'}
          </p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">{title} messages</caption>
            <thead>
              <tr>
                <th scope="col">Direction</th>
                <th scope="col">Who</th>
                <th scope="col">{channel === 'email' ? 'Subject' : 'Message'}</th>
                <th scope="col">Status</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {items.map((message) => (
                <tr key={message.id}>
                  <td>{message.direction === 'inbound' ? 'In' : 'Out'}</td>
                  <td>
                    {message.leadId ? (
                      <a href={`/leads/${message.leadId}`}>
                        {message.direction === 'inbound' ? message.fromAddress : message.toAddress}
                      </a>
                    ) : message.direction === 'inbound' ? (
                      message.fromAddress
                    ) : (
                      message.toAddress
                    )}
                  </td>
                  <td>
                    {message.subject ?? message.body?.slice(0, 80) ?? '—'}
                    {message.failureReason ? (
                      <>
                        <br />
                        <span className="field-error">{message.failureReason}</span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    <span className={`badge badge--${STATUS_BADGE[message.status] ?? 'muted'}`}>
                      {message.status}
                    </span>
                  </td>
                  <td>
                    <RelativeTime iso={message.sentAt ?? message.createdAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
