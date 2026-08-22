import { redirect } from 'next/navigation';
import { apiFetch, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { ReviewModeration } from '@/components/review-moderation';

export const metadata = { title: 'Reviews' };
export const dynamic = 'force-dynamic';

interface ReviewSummary {
  readonly id: string;
  readonly source: string;
  readonly authorName: string;
  readonly rating: number;
  readonly title: string | null;
  readonly body: string | null;
  readonly approved: boolean;
  readonly reviewedAt: string;
}

export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const params = await searchParams;
  const status =
    params.status === 'pending' || params.status === 'approved' ? params.status : 'all';
  const { items } = await apiFetch<{ items: ReviewSummary[] }>(
    `/v1/reviews?status=${status}&limit=100`,
  );

  return (
    <DashboardShell session={session} current="/reviews">
      <div className="page-header">
        <div>
          <h1>Reviews</h1>
          <p className="muted">
            Capture, moderate and publish only the feedback a customer has actually given.
          </p>
        </div>
        {can(session, 'reviews.write') ? (
          <a className="button button--primary" href="/reviews/new">
            New review
          </a>
        ) : null}
        <form className="toolbar" method="get">
          <label className="visually-hidden" htmlFor="review-status">
            Status
          </label>
          <select id="review-status" name="status" defaultValue={status}>
            <option value="all">All reviews</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
          </select>
          <button type="submit" className="button">
            Filter
          </button>
        </form>
      </div>
      {items.length === 0 ? (
        <div className="panel">
          <h2>No reviews</h2>
          <p className="muted">
            Reviews imported from a connected source or entered by staff appear here.
          </p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">Reviews</caption>
            <thead>
              <tr>
                <th scope="col">Author</th>
                <th scope="col">Rating</th>
                <th scope="col">Source</th>
                <th scope="col">Review</th>
                <th scope="col">Status</th>
                <th scope="col">Moderation</th>
              </tr>
            </thead>
            <tbody>
              {items.map((review) => (
                <tr key={review.id}>
                  <th scope="row">
                    <a href={`/reviews/${review.id}`}>{review.authorName}</a>
                  </th>
                  <td>
                    {'★'.repeat(review.rating)}
                    <span className="visually-hidden"> {review.rating} out of 5</span>
                  </td>
                  <td>{review.source}</td>
                  <td>{review.title ?? review.body?.slice(0, 120) ?? '—'}</td>
                  <td>
                    <span className={`badge badge--${review.approved ? 'published' : 'draft'}`}>
                      {review.approved ? 'Approved' : 'Pending'}
                    </span>
                  </td>
                  <td>
                    <ReviewModeration
                      reviewId={review.id}
                      approved={review.approved}
                      canWrite={can(session, 'reviews.write')}
                    />
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
