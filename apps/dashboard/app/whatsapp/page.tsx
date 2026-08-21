import { redirect } from 'next/navigation';
import { getSession } from '@/lib/api';
import { DashboardShell } from '@/components/shell';
import { ChannelMessages } from '@/components/channel-messages';

export const metadata = { title: 'WhatsApp' };
export const dynamic = 'force-dynamic';

export default async function WhatsappPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; direction?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const params = await searchParams;

  return (
    <DashboardShell session={session} businessType="education_service" current="/whatsapp">
      <ChannelMessages
        channel="whatsapp"
        title="WhatsApp"
        description="Acknowledgements and staff sends going out, replies coming in — with delivery state from Meta's receipts."
        status={params.status}
        direction={params.direction}
      />
    </DashboardShell>
  );
}
