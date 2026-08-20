import type { Env } from './env.ts';

/**
 * Queue consumer.
 *
 * Messages are acknowledged individually rather than per batch: one poisoned
 * message must not force 24 healthy ones to be redelivered, and a redelivered
 * message that already sent an email is exactly the failure the outbox and
 * idempotency keys exist to prevent.
 */
export async function handleEventBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
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
  });

  if (!response.ok) {
    throw new Error(`Ingest rejected the message: ${response.status} ${response.statusText}`);
  }
}
