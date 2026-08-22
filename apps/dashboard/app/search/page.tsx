import { redirect } from 'next/navigation';
import { apiFetch, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';

export const metadata = { title: 'Search' };
export const dynamic = 'force-dynamic';

interface Hit {
  readonly type: string;
  readonly id: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly href: string;
}

const TYPE_LABELS: Record<string, string> = {
  contact: 'Contacts',
  lead: 'Enquiries',
  page: 'Pages',
  service: 'Services',
  order: 'Orders',
  automation: 'Automations',
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const { q } = await searchParams;
  const query = (q ?? '').trim();

  const results =
    query.length >= 2
      ? await apiFetch<{ items: Hit[] }>(`/v1/search?q=${encodeURIComponent(query)}`).catch(() => ({
          items: [] as Hit[],
        }))
      : { items: [] as Hit[] };

  const grouped = new Map<string, Hit[]>();
  for (const hit of results.items) {
    grouped.set(hit.type, [...(grouped.get(hit.type) ?? []), hit]);
  }

  return (
    <DashboardShell session={session} current="/search">
      <div className="page-header">
        <div>
          <h1>Search</h1>
          <p className="muted">Contacts, enquiries, pages, services, orders and automations.</p>
        </div>
        <form className="toolbar" method="get" role="search">
          <label className="visually-hidden" htmlFor="search-input">
            Search everything
          </label>
          <input
            id="search-input"
            name="q"
            type="search"
            defaultValue={query}
            minLength={2}
            required
            placeholder="Name, number, page, service…"
          />
          <button type="submit" className="button button--primary">
            Search
          </button>
        </form>
      </div>

      {query.length < 2 ? (
        <div className="panel">
          <p className="muted">Type at least two characters.</p>
        </div>
      ) : results.items.length === 0 ? (
        <div className="panel">
          <h2>Nothing found</h2>
          <p className="muted">No records match “{query}” in the areas you can see.</p>
        </div>
      ) : (
        [...grouped.entries()].map(([type, hits]) => (
          <section className="panel" key={type}>
            <h2>{TYPE_LABELS[type] ?? type}</h2>
            <ul>
              {hits.map((hit) => (
                <li key={hit.id}>
                  <a href={hit.href}>{hit.title}</a>
                  {hit.subtitle ? <span className="muted"> — {hit.subtitle}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </DashboardShell>
  );
}
