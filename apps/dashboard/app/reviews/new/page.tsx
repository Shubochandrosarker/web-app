import { redirect } from 'next/navigation';
import { can, getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { ReviewForm } from '@/components/review-form';
import type { ReviewPayload } from '@/lib/actions';

export const metadata = { title: 'New review' };
export const dynamic = 'force-dynamic';

export default async function NewReviewPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const initial: ReviewPayload = {
    source: 'internal',
    externalId: null,
    authorName: '',
    rating: 5,
    title: null,
    body: null,
    contactId: null,
    response: null,
  };
  return (
    <DashboardShell session={session} current="/reviews">
      <div className="page-header">
        <div>
          <h1>New review</h1>
          <p className="muted">Record the source and keep it pending until a person approves it.</p>
        </div>
      </div>
      <ReviewForm reviewId={null} initial={initial} canWrite={can(session, 'reviews.write')} />
    </DashboardShell>
  );
}
