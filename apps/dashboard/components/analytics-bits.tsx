/**
 * Small server-rendered pieces shared by the analytics screens.
 */

export function StatCard({
  label,
  value,
  compare,
}: {
  readonly label: string;
  readonly value: number;
  readonly compare?: string | undefined;
}) {
  return (
    <div className="stat-card">
      <p className="stat-value">{value.toLocaleString('en')}</p>
      <p className="stat-label">{label}</p>
      {compare ? <p className="stat-delta muted">{compare} vs previous period</p> : null}
    </div>
  );
}

export function WindowSwitch({
  base,
  days,
  extra = '',
}: {
  readonly base: string;
  readonly days: number;
  /** Extra query-string to preserve (e.g. `&dimension=page`). */
  readonly extra?: string;
}) {
  return (
    <nav className="view-switch" aria-label="Time window">
      {[7, 30, 90].map((option) => (
        <a
          key={option}
          href={`${base}?days=${option}${extra}`}
          className={days === option ? 'active' : ''}
        >
          {option} days
        </a>
      ))}
    </nav>
  );
}

export function pickDays(raw: string | undefined): number {
  return [7, 30, 90].includes(Number(raw)) ? Number(raw) : 30;
}
