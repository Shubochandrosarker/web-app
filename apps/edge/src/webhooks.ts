import type { Env } from './env.ts';

/**
 * Inbound webhook receipt.
 *
 * The Worker's job is narrow on purpose: verify the signature, hand the body
 * to the queue, return 200 fast. Providers retry aggressively on slow
 * responses, and processing inline turns one slow database write into a
 * thundering herd of duplicate deliveries.
 */
function timingSafeEqual(a: string, b: string): boolean {
  // Constant-time within the Worker runtime: comparing with === would leak the
  // length of the matching prefix, which is enough to forge a signature byte
  // by byte given enough attempts.
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function webhookHandler(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const source = request.headers.get('x-bos-source');
  const signature = request.headers.get('x-bos-signature');
  if (!source || !signature) return new Response('Missing source or signature', { status: 400 });

  // Read once, as text: re-reading the body to re-serialise it would verify a
  // signature over bytes that are not the bytes that were signed.
  const body = await request.text();
  const expected = await hmacHex(env.EDGE_SHARED_SECRET, body);

  if (!timingSafeEqual(signature, expected)) {
    return new Response('Invalid signature', { status: 401 });
  }

  ctx.waitUntil(
    env.EVENT_QUEUE.send({
      kind: 'webhook.received',
      source,
      body,
      receivedAt: new Date().toISOString(),
    }),
  );

  return new Response(null, { status: 202 });
}
