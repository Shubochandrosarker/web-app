import type { LeadSummary } from '@/app/leads/page';
import { RelativeTime } from './relative-time';

/**
 * The list view.
 *
 * A real `<table>`, because this is tabular data and a grid of divs loses the
 * row/column relationships a screen reader uses to read a cell in context. It
 * scrolls inside its own container rather than widening the page.
 */
export function LeadTable({ leads }: { leads: readonly LeadSummary[] }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <caption className="visually-hidden">Service requests</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Contact</th>
            <th scope="col">Service</th>
            <th scope="col">Status</th>
            <th scope="col">Source</th>
            <th scope="col">Received</th>
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => (
            <tr key={lead.id}>
              <th scope="row">
                <a href={`/leads/${lead.id}`}>{lead.contactName ?? 'Unnamed enquiry'}</a>
              </th>
              <td>
                {lead.contactPhone ? (
                  <a href={`tel:${lead.contactPhone}`}>{lead.contactPhone}</a>
                ) : null}
                {lead.contactPhone && lead.contactEmail ? <br /> : null}
                {lead.contactEmail ? (
                  <a href={`mailto:${lead.contactEmail}`}>{lead.contactEmail}</a>
                ) : null}
              </td>
              <td>{lead.serviceName ?? '—'}</td>
              <td>
                <span className={`badge badge--${lead.status}`}>{lead.status}</span>
              </td>
              <td>{lead.landingPath ?? lead.source}</td>
              <td>
                <RelativeTime iso={lead.createdAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
