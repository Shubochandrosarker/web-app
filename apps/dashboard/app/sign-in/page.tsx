import { redirect } from 'next/navigation';
import { getSession } from '@/lib/api';
import { SignInForm } from '@/components/sign-in-form';

export const metadata = { title: 'Sign in' };

/*
 * Never cached, and never prerendered: the answer depends on a cookie, and a
 * cached sign-in page is a page that tells a signed-in visitor to sign in.
 */
export const dynamic = 'force-dynamic';

export default async function SignInPage() {
  // Somebody who is already signed in has no business on this page.
  if (await getSession()) redirect('/');

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Sign in</h1>
        <p className="muted">Business OS dashboard</p>
        <SignInForm />
      </div>
    </div>
  );
}
