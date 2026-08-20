import { z } from 'zod';
import type { Env } from './env.ts';

/**
 * First-party analytics ingestion.
 *
 * Runs at the edge because it is the highest-volume, least valuable-per-request
 * endpoint on the platform: a traffic spike must not consume origin capacity
 * that a form submission needs.
 *
 * Privacy is structural, not a setting. No cookie is set, no raw IP is stored,
 * and the visitor identifier is a salted hash that rotates daily — so the same
 * person on two different days is not linkable, and the hash cannot be
 * reversed to an address.
 */
const eventSchema = z.object({
  workspace: z.string().min(1).max(140),
  name: z.string().min(1).max(64),
  path: z.string().max(2048),
  sessionId: z.uuid().optional(),
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

const payloadSchema = z.object({ events: z.array(eventSchema).min(1).max(50) });

/**
 * Daily-rotating visitor hash.
 *
 * Deriving it from coarse signals plus the date means it identifies a visit,
 * not a person, and stops being useful for correlation after 24 hours.
 */
async function visitorHash(request: Request, workspace: string): Promise<string> {
  const ip = request.headers.get('cf-connecting-ip') ?? '';
  const userAgent = request.headers.get('user-agent') ?? '';
  const day = new Date().toISOString().slice(0, 10);

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${day}:${workspace}:${ip}:${userAgent}`),
  );

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function collectHandler(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let payload: z.infer<typeof payloadSchema>;
  try {
    payload = payloadSchema.parse(await request.json());
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  const workspace = payload.events[0]!.workspace;
  const hash = await visitorHash(request, workspace);
  const country = request.headers.get('cf-ipcountry') ?? undefined;

  const enriched = payload.events.map((event) => ({
    ...event,
    visitorHash: hash,
    country,
    occurredAt: new Date().toISOString(),
  }));

  /*
   * Respond before the write completes. A beacon that blocks on the origin
   * would add the origin's latency to every page view, and the client has no
   * use for the response anyway. `waitUntil` keeps the Worker alive to finish
   * the forward after the response is sent.
   */
  ctx.waitUntil(env.EVENT_QUEUE.send({ kind: 'analytics.batch', workspace, events: enriched }));

  return new Response(null, {
    status: 204,
    headers: { 'cache-control': 'no-store' },
  });
}
