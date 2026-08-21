import type { LeadSummary, Pipeline } from '@/app/leads/page';
import { LeadCard } from './lead-card';

/**
 * The pipeline board.
 *
 * A column per stage, scrolling horizontally on a narrow screen. Cards are
 * links rather than drag targets: dragging is a poor fit for a phone, needs a
 * pointer library and an accessible fallback, and the move it performs is one
 * select on the lead's own page. The board's job is to show where work is
 * stuck, which it does without any of that.
 */
export function LeadBoard({
  leads,
  pipeline,
}: {
  leads: readonly LeadSummary[];
  pipeline: Pipeline;
}) {
  const byStage = new Map<string, LeadSummary[]>();
  const unstaged: LeadSummary[] = [];

  for (const lead of leads) {
    if (!lead.stageId) {
      unstaged.push(lead);
      continue;
    }
    const bucket = byStage.get(lead.stageId) ?? [];
    bucket.push(lead);
    byStage.set(lead.stageId, bucket);
  }

  const stages = [...pipeline.stages].sort((a, b) => a.position - b.position);

  return (
    <div className="board">
      {unstaged.length > 0 ? (
        /*
         * A lead with no stage is a real state — it arrived before the
         * pipeline was provisioned, or its stage was deleted. Showing it in
         * its own column beats it silently vanishing from the board, which is
         * how a request goes unanswered.
         */
        <BoardColumn title="No stage" tone="warning" leads={unstaged} />
      ) : null}

      {stages.map((stage) => (
        <BoardColumn
          key={stage.id}
          title={stage.name}
          tone={stage.isWon ? 'won' : stage.isLost ? 'lost' : 'default'}
          leads={byStage.get(stage.id) ?? []}
        />
      ))}
    </div>
  );
}

function BoardColumn({
  title,
  tone,
  leads,
}: {
  title: string;
  tone: 'default' | 'won' | 'lost' | 'warning';
  leads: readonly LeadSummary[];
}) {
  return (
    <section className={`board-column board-column--${tone}`} aria-label={title}>
      <header>
        <h2>{title}</h2>
        <span className="badge">{leads.length}</span>
      </header>
      <ul>
        {leads.map((lead) => (
          <li key={lead.id}>
            <LeadCard lead={lead} />
          </li>
        ))}
      </ul>
    </section>
  );
}
