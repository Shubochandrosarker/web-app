import { redirect } from 'next/navigation';
import { apiFetch, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';

export const metadata = { title: 'Forms' };
export const dynamic = 'force-dynamic';

interface FormSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly enabled: boolean;
}

export default async function FormsPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const { items } = await apiFetch<{ items: FormSummary[] }>('/v1/cms/forms').catch(() => ({
    items: [] as FormSummary[],
  }));

  return (
    <DashboardShell session={session} businessType="education_service" current="/forms">
      <div className="page-header">
        <div>
          <h1>Forms</h1>
          <p className="muted">
            {items.length} {items.length === 1 ? 'form' : 'forms'}
          </p>
        </div>
        {can(session, 'forms.write') ? (
          <div className="page-actions">
            <a className="button button--primary" href="/forms/new">
              New form
            </a>
          </div>
        ) : null}
      </div>

      {items.length === 0 ? (
        <div className="panel">
          <h2>No forms yet</h2>
          <p className="muted">
            A form collects service requests from the public site and turns them into leads.
          </p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">Forms</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Slug</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((form) => (
                <tr key={form.id}>
                  <th scope="row">
                    <a href={`/forms/${form.id}`}>{form.name}</a>
                  </th>
                  <td>
                    <code>{form.slug}</code>
                  </td>
                  <td>
                    <span
                      className={form.enabled ? 'badge badge--published' : 'badge badge--muted'}
                    >
                      {form.enabled ? 'Accepting submissions' : 'Disabled'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DashboardShell>
  );
}
