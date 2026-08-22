import { redirect } from 'next/navigation';
import { apiFetch, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { LeadBoard } from '@/components/lead-board';
import { LeadTable } from '@/components/lead-table';

export const metadata = { title: 'Leads' };
export const dynamic = 'force-dynamic';

/**
 * The lead list.
 *
 * Two views of the same data, and both earn their place: the board is how
 * somebody sees where work is stuck, and the table is how they find one person
 * they are about to phone. Which one is showing is a URL parameter rather than
 * client state, so a link to "the board, filtered to mine" is a link somebody
 * can send.
 */

export interface LeadSummary {
  readonly id: string;
  readonly title: string | null;
  readonly status: string;
  readonly stageId: string | null;
  readonly source: string;
  readonly assignedToUserId: string | null;
  readonly followUpAt: string | null;
  readonly createdAt: string;
  readonly stageChangedAt: string;
  readonly landingPath: string | null;
  readonly contactId: string;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly contactEmail: string | null;
  readonly serviceName: string | null;
}

export interface PipelineStage {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly position: number;
  readonly isWon: boolean;
  readonly isLost: boolean;
}

export interface Pipeline {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly stages: readonly PipelineStage[];
}

interface PageProps {
  searchParams: Promise<{ view?: string; assigned?: string; search?: string; status?: string }>;
}

export default async function LeadsPage({ searchParams }: PageProps) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const params = await searchParams;
  const view = params.view === 'table' ? 'table' : 'board';

  const query = new URLSearchParams({ limit: '100' });
  if (params.assigned) query.set('assigned', params.assigned);
  if (params.search) query.set('search', params.search);
  if (params.status) query.set('status', params.status);

  const [leads, pipelines] = await Promise.all([
    apiFetch<{ items: LeadSummary[] }>(`/v1/crm/leads?${query.toString()}`),
    apiFetch<{ pipelines: Pipeline[] }>('/v1/crm/pipelines'),
  ]);

  const pipeline = pipelines.pipelines.find((entry) => entry.isDefault) ?? pipelines.pipelines[0];

  return (
    <DashboardShell session={session} current="/leads">
      <div className="page-header">
        <div>
          <h1>Service requests</h1>
          <p className="muted">
            {leads.items.length} {leads.items.length === 1 ? 'request' : 'requests'}
            {params.assigned === 'me' ? ' assigned to you' : ''}
          </p>
        </div>

        {/*
          Filters as a plain GET form. The state lives in the URL, so the back
          button works, a filtered view is linkable, and none of it needs
          JavaScript.
        */}
        <form className="toolbar" method="get">
          <input type="hidden" name="view" value={view} />

          <label className="visually-hidden" htmlFor="search">
            Search by name, phone or email
          </label>
          <input
            id="search"
            name="search"
            type="search"
            placeholder="Name, phone or email"
            defaultValue={params.search ?? ''}
          />

          <label className="visually-hidden" htmlFor="assigned">
            Assignment
          </label>
          <select id="assigned" name="assigned" defaultValue={params.assigned ?? ''}>
            <option value="">Everyone</option>
            <option value="me">Assigned to me</option>
            <option value="unassigned">Unassigned</option>
          </select>

          <button type="submit" className="button">
            Filter
          </button>
        </form>
      </div>

      <div className="view-switch" role="group" aria-label="View">
        <a
          href={`/leads?${new URLSearchParams({ ...params, view: 'board' }).toString()}`}
          className={view === 'board' ? 'active' : undefined}
          {...(view === 'board' ? { 'aria-current': 'page' as const } : {})}
        >
          Board
        </a>
        <a
          href={`/leads?${new URLSearchParams({ ...params, view: 'table' }).toString()}`}
          className={view === 'table' ? 'active' : undefined}
          {...(view === 'table' ? { 'aria-current': 'page' as const } : {})}
        >
          List
        </a>
      </div>

      {leads.items.length === 0 ? (
        <div className="panel">
          <h2>No requests yet</h2>
          <p className="muted">
            Requests submitted through the website&rsquo;s service form appear here immediately.
          </p>
        </div>
      ) : view === 'board' && pipeline ? (
        <LeadBoard leads={leads.items} pipeline={pipeline} />
      ) : (
        <LeadTable leads={leads.items} />
      )}
    </DashboardShell>
  );
}
