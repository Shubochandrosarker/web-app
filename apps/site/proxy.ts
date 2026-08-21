import { NextResponse, type NextRequest } from 'next/server';

/**
 * Content Security Policy, and database-owned redirects.
 *
 * Named `proxy.ts` rather than `middleware.ts`: Next 16 renamed the convention
 * and deprecated the old filename, which now prints a warning on every build.
 *
 * **CSP.** The previous configuration described a strict policy in a comment
 * and sent no `Content-Security-Policy` header at all — the security posture
 * existed only in prose. This emits one, and it is nonce-based rather than
 * `unsafe-inline`, because a policy that allows arbitrary inline script is a
 * policy that stops none of the injection it exists to stop.
 *
 * A nonce has to be different per response, which is why the content pages
 * render per request rather than as fully static HTML. The data behind them is
 * still cached and tag-revalidated, so the cost is a render, not a query — see
 * `lib/content.ts` and ADR-0014.
 *
 * **Redirects.** Served from the API's `redirects` table rather than
 * `next.config.ts`, so an editor changing a slug does not need a deploy. That
 * is the difference between a URL migration somebody can carry out and one
 * that waits on an engineer.
 */

/** Paths middleware must not touch. Static assets need no policy and no lookup. */
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt|xml|json|woff2?)$).*)',
  ],
};

/**
 * The policy.
 *
 * Every directive is listed, including the ones that are `'none'`: an absent
 * directive falls back to `default-src`, and relying on that fallback is how a
 * policy quietly permits something after `default-src` is later widened.
 */
function buildCsp(nonce: string, apiOrigin: string, mediaOrigin: string, isDev: boolean): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],

    /*
     * `strict-dynamic` lets a nonced script load the chunks it needs without
     * every chunk URL being listed. `'self'` and `https:` are there for
     * browsers that do not understand `strict-dynamic` and would otherwise
     * fall back to blocking everything.
     *
     * In development Next injects an eval-based refresh runtime, so
     * `unsafe-eval` is added there and nowhere else.
     */
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      'https:',
      ...(isDev ? ["'unsafe-eval'"] : []),
      // Turnstile is the one third-party script on the public site.
      'https://challenges.cloudflare.com',
    ],

    /*
     * `unsafe-inline` for styles, and not for scripts.
     *
     * React sets inline styles on elements it renders, and there is no nonce
     * path for a style attribute. The risk is bounded — an injected style can
     * deface a page, not execute — and it is the one concession here.
     */
    'style-src': ["'self'", "'unsafe-inline'"],

    // `data:` for the inline SVG placeholders; `blob:` for nothing yet, so it
    // is absent rather than pre-emptively allowed.
    'img-src': ["'self'", 'data:', mediaOrigin].filter(Boolean),
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", apiOrigin, 'https://challenges.cloudflare.com'].filter(Boolean),

    // Turnstile renders in an iframe. Nothing else may.
    'frame-src': ['https://challenges.cloudflare.com'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    // The only place a form on this site may post is its own origin and the
    // API. An injected form that posts credentials elsewhere is blocked here.
    'form-action': ["'self'", apiOrigin].filter(Boolean),
    'frame-ancestors': ["'none'"],
    'upgrade-insecure-requests': [],
  };

  return Object.entries(directives)
    .map(([name, values]) => (values.length > 0 ? `${name} ${values.join(' ')}` : name))
    .join('; ');
}

/** In-process redirect cache, refreshed on a short interval. */
let redirectCache: { map: Map<string, { toPath: string; statusCode: number }>; expiresAt: number } =
  {
    map: new Map(),
    expiresAt: 0,
  };

async function loadRedirects(
  apiUrl: string,
  workspace: string,
): Promise<Map<string, { toPath: string; statusCode: number }>> {
  if (Date.now() < redirectCache.expiresAt) return redirectCache.map;

  try {
    const response = await fetch(
      `${apiUrl}/v1/redirects?workspace=${encodeURIComponent(workspace)}`,
      { signal: AbortSignal.timeout(2_000) },
    );
    if (!response.ok) throw new Error(String(response.status));

    const body = (await response.json()) as {
      redirects: { fromPath: string; toPath: string; statusCode: number }[];
    };

    const map = new Map(
      body.redirects.map((row) => [
        row.fromPath,
        { toPath: row.toPath, statusCode: row.statusCode },
      ]),
    );

    redirectCache = { map, expiresAt: Date.now() + 60_000 };
    return map;
  } catch {
    /*
     * Keep serving the previous map, and retry sooner than a successful load
     * would. An API blip must not turn every redirect into a 404 — those URLs
     * are the ones that are ranking.
     */
    redirectCache = { map: redirectCache.map, expiresAt: Date.now() + 10_000 };
    return redirectCache.map;
  }
}

export default async function proxy(request: NextRequest): Promise<NextResponse> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? '';
  const workspace = process.env.BOS_WORKSPACE_SLUG ?? '';
  const pathname = request.nextUrl.pathname;

  /* ------------------------------------------------------------ redirects */

  if (apiUrl && workspace) {
    const redirects = await loadRedirects(apiUrl, workspace);

    // Try the path as given and without a trailing slash, so one stored row
    // covers both forms rather than needing two.
    const candidate =
      redirects.get(pathname) ??
      (pathname.length > 1 && pathname.endsWith('/')
        ? redirects.get(pathname.slice(0, -1))
        : undefined);

    if (candidate) {
      const destination = new URL(candidate.toPath, request.url);
      // The query string survives the redirect: dropping it loses the campaign
      // parameters on exactly the links most likely to carry them.
      destination.search = request.nextUrl.search;
      return NextResponse.redirect(destination, candidate.statusCode === 302 ? 302 : 301);
    }
  }

  /* ------------------------------------------------------------------ CSP */

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const mediaOrigin = process.env.NEXT_PUBLIC_MEDIA_ORIGIN ?? '';
  const isDev = process.env.NODE_ENV !== 'production';

  const csp = buildCsp(nonce, apiUrl, mediaOrigin, isDev);

  /*
   * Next reads the nonce back out of the request headers to stamp it onto the
   * scripts it injects. Setting it only on the response would give a valid
   * policy and a page whose own bootstrap is blocked by it.
   */
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);

  return response;
}
