import { and, eq, lte, sql } from 'drizzle-orm';
import { schema, withoutTenantScope, type Database } from '@bos/database';

/**
 * The transactional event outbox.
 *
 * The problem it solves: a lead is created and a confirmation must be sent.
 * Doing both without an outbox means picking which one is allowed to fail
 * silently — publish before commit and a rolled-back transaction sends a
 * confirmation for a lead that does not exist; publish after commit and a
 * crash in between loses the confirmation for a lead that does.
 *
 * With an outbox there is no in-between: the event is a row written by the
 * same transaction as the lead, so either both exist or neither does. A
 * dispatcher then moves rows to their handlers, at least once.
 *
 * "At least once" is the whole contract. Every handler must be idempotent,
 * and `idempotencyKey` is how — it is unique per workspace, so a retry that
 * re-inserts is rejected by the index rather than duplicated.
 */

export interface OutboxEvent {
  readonly name: string;
  readonly payload: Record<string, unknown>;
  readonly correlationId: string;
  /**
   * Stable across retries of the same logical action.
   *
   * Derive it from the thing that happened — `lead.created:<leadId>` — never
   * from a timestamp or a fresh UUID, or a retry produces a different key and
   * the deduplication it exists for does not happen.
   */
  readonly idempotencyKey: string;
  readonly actorUserId?: string | null;
  readonly availableAt?: Date;
}

/**
 * Append an event **inside an existing transaction**.
 *
 * `tx` is required rather than optional on purpose: an overload that opens its
 * own transaction would be the easy call to make, and it would silently
 * destroy the only property this module has.
 */
export async function appendOutboxEvent(
  tx: Database,
  workspaceId: string,
  event: OutboxEvent,
): Promise<string | null> {
  const [row] = await tx
    .insert(schema.eventOutbox)
    .values({
      workspaceId,
      name: event.name,
      payload: event.payload,
      correlationId: event.correlationId,
      idempotencyKey: event.idempotencyKey,
      actorUserId: event.actorUserId ?? null,
      ...(event.availableAt ? { availableAt: event.availableAt } : {}),
    })
    // A duplicate key means this exact action already produced this exact
    // event. That is success, not a conflict — the caller is retrying.
    .onConflictDoNothing({
      target: [schema.eventOutbox.workspaceId, schema.eventOutbox.idempotencyKey],
    })
    .returning({ id: schema.eventOutbox.id });

  return row?.id ?? null;
}

export type OutboxHandler = (event: {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly payload: Record<string, unknown>;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly attempts: number;
}) => Promise<void>;

export interface DispatchResult {
  readonly claimed: number;
  readonly dispatched: number;
  readonly failed: number;
  readonly dead: number;
}

/** Give up after this many attempts and park the row for a human. */
const MAX_ATTEMPTS = 8;

/**
 * Claim and dispatch a batch of pending events.
 *
 * The claim uses `FOR UPDATE SKIP LOCKED`, which is what lets two API
 * instances run this concurrently without either blocking on the other or both
 * grabbing the same row. Without `SKIP LOCKED` a second dispatcher waits
 * behind the first and the throughput of N instances is the throughput of one.
 *
 * Runs under `withoutTenantScope` because the outbox spans tenants by
 * definition — this is one of the three places in the platform where that is
 * correct rather than a bug.
 */
export async function dispatchOutbox(
  db: Database,
  handler: OutboxHandler,
  batchSize = 50,
): Promise<DispatchResult> {
  const claimed = await withoutTenantScope(db, async (tx) => {
    const result = await tx.execute<{
      id: string;
      workspace_id: string;
      name: string;
      payload: Record<string, unknown>;
      correlation_id: string;
      idempotency_key: string;
      attempts: number;
    }>(sql`
      with claimed as (
        select id
        from event_outbox
        where status = 'pending'
          and available_at <= now()
        order by available_at
        for update skip locked
        limit ${batchSize}
      )
      update event_outbox e
      set attempts = e.attempts + 1
      from claimed c
      where e.id = c.id
      returning e.id, e.workspace_id, e.name, e.payload, e.correlation_id,
                e.idempotency_key, e.attempts
    `);
    return result.rows;
  });

  let dispatched = 0;
  let failed = 0;
  let dead = 0;

  for (const row of claimed) {
    try {
      await handler({
        id: row.id,
        workspaceId: row.workspace_id,
        name: row.name,
        payload: row.payload,
        correlationId: row.correlation_id,
        idempotencyKey: row.idempotency_key,
        attempts: row.attempts,
      });

      await withoutTenantScope(db, (tx) =>
        tx
          .update(schema.eventOutbox)
          .set({ status: 'dispatched', dispatchedAt: new Date(), lastError: null })
          .where(eq(schema.eventOutbox.id, row.id)),
      );
      dispatched += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const exhausted = row.attempts >= MAX_ATTEMPTS;

      /*
       * Exponential backoff, capped at fifteen minutes. Retrying a failing
       * provider every second turns a brief outage into a self-inflicted one,
       * and a fixed delay synchronises every failed event into the same
       * thundering retry.
       */
      const delaySeconds = Math.min(2 ** row.attempts, 900);

      await withoutTenantScope(db, (tx) =>
        tx
          .update(schema.eventOutbox)
          .set({
            status: exhausted ? 'dead' : 'pending',
            lastError: message.slice(0, 2000),
            availableAt: new Date(Date.now() + delaySeconds * 1000),
          })
          .where(eq(schema.eventOutbox.id, row.id)),
      );

      if (exhausted) dead += 1;
      else failed += 1;
    }
  }

  return { claimed: claimed.length, dispatched, failed, dead };
}

/** Counts for the readiness probe and the health dashboard. */
export async function outboxHealth(db: Database): Promise<{
  pending: number;
  dead: number;
  oldestPendingSeconds: number | null;
}> {
  return withoutTenantScope(db, async (tx) => {
    const result = await tx.execute<{
      pending: string;
      dead: string;
      oldest_seconds: string | null;
    }>(sql`
      select
        count(*) filter (where status = 'pending')                        as pending,
        count(*) filter (where status = 'dead')                           as dead,
        extract(epoch from now() - min(available_at))
          filter (where status = 'pending' and available_at <= now())     as oldest_seconds
      from event_outbox
    `);

    const row = result.rows[0];
    return {
      pending: Number(row?.pending ?? 0),
      dead: Number(row?.dead ?? 0),
      oldestPendingSeconds:
        row?.oldest_seconds === null || row?.oldest_seconds === undefined
          ? null
          : Number(row.oldest_seconds),
    };
  });
}

/** Requeue dead rows after the underlying cause has been fixed. */
export async function requeueDeadEvents(db: Database, workspaceId?: string): Promise<number> {
  return withoutTenantScope(db, async (tx) => {
    const rows = await tx
      .update(schema.eventOutbox)
      .set({ status: 'pending', attempts: 0, availableAt: new Date(), lastError: null })
      .where(
        workspaceId
          ? and(
              eq(schema.eventOutbox.status, 'dead'),
              eq(schema.eventOutbox.workspaceId, workspaceId),
            )
          : eq(schema.eventOutbox.status, 'dead'),
      )
      .returning({ id: schema.eventOutbox.id });
    return rows.length;
  });
}

/** Delete dispatched rows older than the retention window. */
export async function pruneOutbox(db: Database, olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000);
  return withoutTenantScope(db, async (tx) => {
    const rows = await tx
      .delete(schema.eventOutbox)
      .where(
        and(
          eq(schema.eventOutbox.status, 'dispatched'),
          lte(schema.eventOutbox.dispatchedAt, cutoff),
        ),
      )
      .returning({ id: schema.eventOutbox.id });
    return rows.length;
  });
}
