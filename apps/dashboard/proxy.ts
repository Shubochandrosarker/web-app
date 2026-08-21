import { NextResponse, type NextRequest } from 'next/server';

/**
 * The dashboard's Content Security Policy.
 *
 * Every page here is authenticated and rendered per request, so the
 * nonce-per-response requirement costs nothing — unlike on the public site,
 * where it drove a real caching decision.
 *
 * The policy is tighter than the site's: no third-party script origin at all,
 * because the dashboard integrates with nothing in the browser. Everything it
 * needs, it fetches server-side with the session cookie attached.
 */
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};

function buildCsp(nonce: string, apiOrigin: string, isDev: boolean): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      // For browsers that do not understand `strict-dynamic` and would
      // otherwise fall back to blocking the application's own chunks.
      'https:',
      ...(isDev ? ["'unsafe-eval'"] : []),
    ],
    // React sets inline styles on elements it renders, and a style attribute
    // cannot carry a nonce. An injected style can deface a screen, not execute.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'", 'data:'],
    // The MFA enrolment panel is the one place the browser calls the API
    // directly; everything else goes through a Server Action.
    'connect-src': ["'self'", apiOrigin].filter(Boolean),
    'frame-src': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
    'upgrade-insecure-requests': [],
  };

  return Object.entries(directives)
    .map(([name, values]) => (values.length > 0 ? `${name} ${values.join(' ')}` : name))
    .join('; ');
}

export default function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCsp(
    nonce,
    process.env.NEXT_PUBLIC_API_URL ?? '',
    process.env.NODE_ENV !== 'production',
  );

  // Next reads the nonce back out of the request headers to stamp it onto the
  // scripts it injects. Setting it only on the response would give a valid
  // policy and an application whose own bootstrap is blocked by it.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);
  return response;
}
