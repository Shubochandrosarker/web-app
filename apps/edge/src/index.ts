import { collectHandler } from './collect.ts';
import { webhookHandler } from './webhooks.ts';
import { handleEventBatch } from './consumer.ts';
import { runScheduled } from './scheduled.ts';
import type { Env } from './env.ts';

/**
 * The edge Worker.
 *
 * Three entry points, and each exists for a specific reason:
 *
 *  - `fetch`     analytics ingestion and webhook receipt. Both are spiky, both
 *                are cheap, and both want to terminate as close to the client
 *                as possible so a burst never reaches the origin.
 *  - `queue`     asynchronous work moved off the request path — outbound
 *                messages, indexing submissions, cache purges. Batched, with
 *                retries and a dead-letter queue.
 *  - `scheduled` nightly maintenance: analytics rollups, document retention.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/collect':
        return collectHandler(request, env, ctx);
      case '/webhooks':
        return webhookHandler(request, env, ctx);
      case '/health':
        return Response.json({ status: 'ok' });
      default:
        return new Response('Not found', { status: 404 });
    }
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await handleEventBatch(batch, env);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(event, env));
  },
};
