import type { LeadSummary } from '@/app/leads/page';
import { RelativeTime } from './relative-time';

/** One lead, as it appears on the board. */
export function LeadCard({ lead }: { lead: LeadSummary }) {
  return (
    <a href={`/leads/${lead.id}`} className="lead-card">
      <strong>{lead.contactName ?? 'Unnamed enquiry'}</strong>

      {lead.serviceName ? <span className="lead-card-service">{lead.serviceName}</span> : null}

      {lead.title ? <span className="lead-card-title">{lead.title}</span> : null}

      <span className="lead-card-meta">
        {/*
          The phone number is on the card because the next action for most of
          these is a phone call, and making somebody open the lead to read it
          is a click they perform dozens of times a day.
        */}
        {lead.contactPhone ?? lead.contactEmail ?? 'No contact details'}
      </span>

      <span className="lead-card-meta">
        <RelativeTime iso={lead.createdAt} />
        {lead.assignedToUserId ? null : <span className="badge badge--muted">Unassigned</span>}
      </span>
    </a>
  );
}
