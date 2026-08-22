import { notFound, redirect } from 'next/navigation';
import { apiFetch, can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { ReviewForm } from '@/components/review-form';
import type { ReviewPayload } from '@/lib/actions';

export const metadata = { title: 'Review' };
export const dynamic = 'force-dynamic';

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const { id } = await params;
  const result = await apiFetch<{ review: ReviewPayload & { id: string } }>(
    `/v1/reviews/${id}`,
  ).catch(() => null);
  if (!result) notFound();
  return (
    <DashboardShell session={session} current="/reviews">
      <div className="page-header">
        <div>
          <h1>{result.review.authorName}</h1>
          <p className="muted">Review details and moderation state.</p>
        </div>
        <a className="button" href="/reviews">
          Back to reviews
        </a>
      </div>
      <ReviewForm reviewId={id} initial={result.review} canWrite={can(session, 'reviews.write')} />
    </DashboardShell>
  );
}
