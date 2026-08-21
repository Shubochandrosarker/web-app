import { z } from 'zod';
import { workspaceForOrigin, type Env } from './env.ts';

/**
 * First-party analytics ingestion.
 *
 * Runs at the edge because it is the highest-volume, least valuable-per-request
 * endpoint on the platform: a traffic spike must not consume origin capacity
 * that a form submission needs.
 *
 * Two things changed here from the first version, and both were security
 * problems rather than refinements:
 *
 *  1. **The workspace comes from the request's Origin**, resolved against a
 *     configured map. It used to be a field in the body — a value the browser
 *     controls — so any page on the internet could post events into any
 *     tenant's analytics by naming its slug.
 *
 *  2. **The visitor identifier is not computed here at all.** It used to be an
 *     unsalted `SHA-256(ip + user-agent)`. That is not a pseudonym: the input
 *     space of IPv4 addresses and common user agents is small enough to
 *     enumerate exhaustively, so anyone holding the digests can recover the
 *     addresses. The Worker now sends a coarse, per-request value and the API
 *     — the only place holding the long-lived HMAC key — derives the stored
 *     pseudonym. Rotating that key rotates every pseudonym.
 *
 * No cookie is set, and no raw address is stored anywhere.
 */

/**
 * Event names the collector accepts.
 *
 * An allow-list, not free text. Without one, anything that can reach this
 * endpoint can mint event names, and the events table becomes a
 * write-anything endpoint with a CORS check in front of it. Kept in step with
 * the API's own list in `apps/api/src/routes/internal.ts`.
 */
const EVENT_NAMES = [
  'page_view',
  'cta_click',
  'whatsapp_click',
  'phone_click',
  'form_view',
  'form_start',
  'form_submit',
  'scroll_depth',
  'outbound_click',
  'conversion',
] as const;

const eventSchema = z.object({
  name: z.enum(EVENT_NAMES),
  path: z.string().max(2048),
  referrer: z.string().max(2048).optional(),
  properties: z.record(z.string(), z.unknown()).default({}),
  utm: z
    .object({
      source: z.string().max(255).optional(),
      medium: z.string().max(255).optional(),
      campaign: z.string().max(255).optional(),
      term: z.string().max(255).optional(),
      content: z.string().max(255).optional(),
    })
    .default({}),
});

/**
 * No `workspace` field.
 *
 * Its absence is the fix. There is nowhere for a client to say which tenant
 * these events belong to.
 */
const payloadSchema = z.object({ events: z.array(eventSchema).min(1).max(50) });

/** Beacons are small. A large body is a mistake or an attempt at one. */
const MAX_BODY_BYTES = 32 * 1024;

/**
 * A coarse, per-request signal the API turns into a pseudonym.
 *
 * Not itself an identifier: it is hashed again, server-side, with a secret the
 * Worker does not hold, together with the date. What crosses the wire is
 * therefore already one step removed from the address, and what is stored is
 * two.
 */
async function requestSignal(request: Request): Promise<string> {
  const ip = request.headers.get('cf-connecting-ip') ?? '';
  const userAgent = request.headers.get('user-agent') ?? '';

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${ip}|${userAgent}`),
  );

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Obvious automated traffic, dropped before it becomes a session.
 *
 * Crude on purpose — a bot that sets a browser user agent gets through, and
 * that is fine. What this removes is the uncontroversial bulk: crawlers that
 * identify themselves, and preview fetchers that would otherwise register as
 * visits and quietly inflate every page's traffic.
 */
function looksAutomated(userAgent: string): boolean {
  return /bot|crawler|spider|crawling|preview|headless|monitor|pingdom|lighthouse|curl|wget|python-requests/i.test(
    userAgent,
  );
}

export async function collectHandler(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const origin = request.headers.get('origin');
  const workspace = workspaceForOrigin(env, origin);

  if (!workspace) {
    // 403 rather than 400: the request is well-formed, it is just not from
    // somewhere allowed to write into any tenant here.
    return new Response('Origin not permitted', { status: 403 });
  }

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_BODY_BYTES) {
    return new Response('Payload too large', { status: 413 });
  }

  const userAgent = request.headers.get('user-agent') ?? '';
  if (looksAutomated(userAgent)) {
    // Accepted and discarded. A crawler told it failed simply retries.
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return new Response('Payload too large', { status: 413 });

  let payload: z.infer<typeof payloadSchema>;
  try {
    payload = payloadSchema.parse(JSON.parse(body));
  } catch {
    return new Response('Bad request', { status: 400, headers: corsHeaders(origin) });
  }

  const signal = await requestSignal(request);
  const country = request.headers.get('cf-ipcountry') ?? undefined;
  const occurredAt = new Date().toISOString();

  const enriched = payload.events.map((event) => ({
    ...event,
    visitorHash: signal,
    country,
    occurredAt,
  }));

  /*
   * Respond before the write completes. A beacon that blocks on the origin
   * would add the origin's latency to every page view, and the client has no
   * use for the response anyway. `waitUntil` keeps the Worker alive to finish
   * the forward after the response is sent.
   */
  ctx.waitUntil(
    env.EVENT_QUEUE.send({ kind: 'analytics.batch', workspace, events: enriched }).catch(
      (error: unknown) => {
        // A queue failure loses a page view. That is an acceptable loss and
        // not worth failing the visitor's request over.
        console.error('Failed to enqueue an analytics batch', { error });
      },
    ),
  );

  return new Response(null, {
    status: 204,
    headers: { 'cache-control': 'no-store', ...corsHeaders(origin) },
  });
}

/** Answer the preflight for the one origin this request came from. */
export function collectPreflight(request: Request, env: Env): Response {
  const origin = request.headers.get('origin');
  if (!workspaceForOrigin(env, origin)) return new Response(null, { status: 403 });

  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin),
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    },
  });
}

function corsHeaders(origin: string | null): Record<string, string> {
  // Echo the specific origin rather than `*`: the allow-list has already
  // decided, and a wildcard would let the browser reuse the response for an
  // origin that was never checked.
  return origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
}
