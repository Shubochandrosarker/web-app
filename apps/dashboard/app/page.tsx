import { redirect } from 'next/navigation';
import { getSession, can } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * The dashboard's front door.
 *
 * It has no content of its own: it sends the signed-in person to the screen
 * they actually work from. For NuESheba staff that is the lead board; for
 * somebody who can only edit content it is the content list. A landing page
 * of tiles nobody reads is a click between them and their job.
 */
export default async function IndexPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  if (can(session, 'leads.read')) redirect('/leads');
  if (can(session, 'content.read')) redirect('/content');
  redirect('/settings');
}
