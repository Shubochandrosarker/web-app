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

/* ------------------------------------------------------------ silent refresh */

const ACCESS_COOKIE = 'bos_access';
const REFRESH_COOKIE = 'bos_refresh';

interface RefreshedCookies {
  readonly access: { value: string; maxAge: number };
  readonly refresh: { value: string; maxAge: number };
}

/**
 * One in-flight refresh per refresh token, per server process.
 *
 * The API treats two concurrent rotations of one token as reuse and revokes
 * the family — correctly, because it cannot tell a self-race from a theft.
 * So the dashboard must not race itself: every request that arrives while a
 * refresh is in flight awaits the same promise. This covers the common case
 * (one browser, several parallel requests after the access token lapses); a
 * multi-instance dashboard would additionally need sticky sessions, which
 * the deployment docs state.
 */
const refreshesInFlight = new Map<string, Promise<RefreshedCookies | null>>();

function parseSetCookie(header: string): { name: string; value: string; maxAge: number } | null {
  const parts = header.split(';').map((part) => part.trim());
  const [pair, ...attributes] = parts;
  const separator = pair?.indexOf('=') ?? -1;
  if (!pair || separator === -1) return null;

  let maxAge = 0;
  for (const attribute of attributes) {
    const [name, value] = attribute.split('=');
    if (name?.toLowerCase() === 'max-age') maxAge = Number(value) || 0;
  }

  return { name: pair.slice(0, separator), value: pair.slice(separator + 1), maxAge };
}

async function refreshSession(refreshToken: string): Promise<RefreshedCookies | null> {
  const apiUrl = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/+$/, '');
  if (!apiUrl) return null;

  try {
    const response = await fetch(`${apiUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${REFRESH_COOKIE}=${refreshToken}`,
      },
      body: '{}',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return null;

    let access: { value: string; maxAge: number } | undefined;
    let refresh: { value: string; maxAge: number } | undefined;
    for (const header of response.headers.getSetCookie()) {
      const parsed = parseSetCookie(header);
      if (parsed?.name === ACCESS_COOKIE) access = parsed;
      if (parsed?.name === REFRESH_COOKIE) refresh = parsed;
    }

    return access && refresh ? { access, refresh } : null;
  } catch {
    // The API being unreachable is not a reason to destroy the session; the
    // page will render signed-out and recover on the next request.
    return null;
  }
}

function singleFlightRefresh(refreshToken: string): Promise<RefreshedCookies | null> {
  const existing = refreshesInFlight.get(refreshToken);
  if (existing) return existing;

  const flight = refreshSession(refreshToken).finally(() => {
    refreshesInFlight.delete(refreshToken);
  });
  refreshesInFlight.set(refreshToken, flight);
  return flight;
}

export default async function proxy(request: NextRequest): Promise<NextResponse> {
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

  /*
   * Silent refresh.
   *
   * The access cookie expires after minutes by design; the refresh session
   * lives for weeks. A dashboard that answers the gap between the two with a
   * sign-in page is treating its own token schedule as the user's problem.
   * When the access cookie has lapsed but a refresh cookie is present, the
   * session is rotated here — before rendering — and the request proceeds
   * authenticated. At most one rotation per request, so a refresh that fails
   * cannot loop; the failure path clears the dead cookies and the page
   * renders signed out.
   */
  const hasAccess = Boolean(request.cookies.get(ACCESS_COOKIE)?.value);
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;

  let refreshed: RefreshedCookies | null = null;
  let refreshFailed = false;

  if (!hasAccess && refreshToken) {
    refreshed = await singleFlightRefresh(refreshToken);
    refreshFailed = refreshed === null;

    if (refreshed) {
      // The downstream Server Components must see the new access token on
      // *this* request, not the next one — patch the forwarded cookie header.
      const forwarded = request.cookies
        .getAll()
        .filter((cookie) => cookie.name !== ACCESS_COOKIE && cookie.name !== REFRESH_COOKIE)
        .map((cookie) => `${cookie.name}=${cookie.value}`);
      forwarded.push(`${ACCESS_COOKIE}=${refreshed.access.value}`);
      forwarded.push(`${REFRESH_COOKIE}=${refreshed.refresh.value}`);
      requestHeaders.set('cookie', forwarded.join('; '));
    }
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);

  const isProduction = process.env.NODE_ENV === 'production';
  const cookieBase = {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax' as const,
    path: '/',
  };

  if (refreshed) {
    response.cookies.set(ACCESS_COOKIE, refreshed.access.value, {
      ...cookieBase,
      maxAge: refreshed.access.maxAge || 900,
    });
    response.cookies.set(REFRESH_COOKIE, refreshed.refresh.value, {
      ...cookieBase,
      maxAge: refreshed.refresh.maxAge || 2_592_000,
    });
  } else if (refreshFailed) {
    // A refresh token the API refused is dead; presenting it forever is how
    // a browser gets stuck half signed-in.
    response.cookies.delete(ACCESS_COOKIE);
    response.cookies.delete(REFRESH_COOKIE);
  }

  return response;
}
