import { redirect } from 'next/navigation';
import { getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { ChannelMessages } from '@/components/channel-messages';

export const metadata = { title: 'Email' };
export const dynamic = 'force-dynamic';

export default async function EmailPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const { status } = await searchParams;

  return (
    <DashboardShell session={session} businessType="education_service" current="/email">
      <ChannelMessages
        channel="email"
        title="Email"
        description="Every email the platform has sent — confirmations, notifications, resets — with delivery state and failure reasons."
        status={status}
      />
    </DashboardShell>
  );
}
