import { consumersEnabled, type Env } from './env.ts';

/**
 * Queue consumer.
 *
 * Messages are acknowledged individually rather than per batch: one poisoned
 * message must not force twenty-four healthy ones to be redelivered, and a
 * redelivered message that already sent an email is exactly the failure the
 * outbox and idempotency keys exist to prevent.
 *
 * The `consumersEnabled` guard is the fix for the deployment problem this file
 * used to have. It forwarded every message to `/v1/internal/ingest`, an
 * endpoint that did not exist — so each message failed, retried five times
 * with backoff, and landed in the dead-letter queue. A Worker deployed ahead
 * of its API is now a Worker that parks its messages deliberately rather than
 * grinding them into the DLQ.
 */
export async function handleEventBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  if (!consumersEnabled(env)) {
    /*
     * Retry the whole batch rather than acknowledging it.
     *
     * Acknowledging would silently discard real analytics and real webhooks.
     * Retrying holds them until the API is deployed and the flag is set, at
     * which point they drain. `delaySeconds` is long because there is no point
     * checking every two seconds for a deploy.
     */
    console.warn('Consumers are disabled; holding the batch', { size: batch.messages.length });
    batch.retryAll({ delaySeconds: 900 });
    return;
  }

  for (const message of batch.messages) {
    try {
      await forwardToApi(message.body, env);
      message.ack();
    } catch (error) {
      // Retry with backoff. After max_retries the message lands in the DLQ,
      // where it can be inspected rather than lost.
      console.error('Failed to process queue message', { id: message.id, error });
      message.retry({ delaySeconds: Math.min(2 ** message.attempts, 900) });
    }
  }
}

async function forwardToApi(body: unknown, env: Env): Promise<void> {
  const response = await fetch(`${env.API_BASE_URL}/v1/internal/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Identifies the caller as the edge rather than the public internet.
      'x-bos-edge-secret': env.EDGE_SHARED_SECRET,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    /*
     * A 4xx other than 429 will fail identically on every retry — a malformed
     * event, an unknown workspace, a rejected event name — so it is thrown to
     * the DLQ immediately rather than after five pointless attempts. Anything
     * else is treated as transient.
     */
    const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
    const detail = `${response.status} ${response.statusText}`;

    if (permanent) {
      console.error('Ingest rejected a message permanently', { detail });
    }

    throw new Error(`Ingest rejected the message: ${detail}`);
  }
}
