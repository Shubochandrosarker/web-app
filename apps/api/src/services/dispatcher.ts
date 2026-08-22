import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '@bos/database';
import { dispatchOutbox, type OutboxHandler } from '../lib/outbox.ts';
import { claimOnce, type RedisClient } from '../lib/redis.ts';

/**
 * The in-process outbox dispatcher.
 *
 * Without it the outbox is drained only by the nightly cron, which means a
 * visitor's confirmation email arrives the following morning and a published
 * page stays stale until then. Both are the kind of "works in the test, wrong
 * in production" gap that a queue silently creates.
 *
 * The cron stays, as the backstop: it catches anything written while every API
 * instance was down, and it is the thing that still runs if this loop dies.
 *
 * Two properties make it safe to run on every instance at once:
 *
 *  1. `dispatchOutbox` claims rows with `FOR UPDATE SKIP LOCKED`, so two
 *     instances take different rows rather than the same one.
 *  2. A short Redis lease keeps them from all waking at the same instant and
 *     hammering the database with claim queries that mostly return nothing.
 */

export interface DispatcherOptions {
  readonly db: Database;
  readonly redis: RedisClient;
  readonly logger: FastifyBaseLogger;
  readonly handler: OutboxHandler;
  /**
   * Wakes automation runs whose sleep or retry backoff has come due, under
   * the same lease as the outbox pass — the two are the same shape of work
   * and a second polling loop would double the idle query load for nothing.
   */
  readonly resumeAutomations?: () => Promise<number>;
  /**
   * Turns due appointment-reminder rows into outbox events, under the same
   * lease and for the same reason as `resumeAutomations`.
   */
  readonly dispatchReminders?: () => Promise<number>;
  /**
   * Enrolls schedule-triggered automations whose cron matches the current
   * minute. Idempotent per minute, so the five-second cadence is harmless.
   */
  readonly runSchedules?: () => Promise<number>;
  /** How often to look for work. */
  readonly intervalMs?: number;
  readonly batchSize?: number;
}

export interface Dispatcher {
  start(): void;
  stop(): void;
  /** Run one pass now. Exposed for tests and for an operator draining a backlog. */
  runOnce(): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 5_000;

export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const runOnce = async (): Promise<void> => {
    // A pass that overruns its interval must not have a second pass started on
    // top of it: the claim is safe, but the log noise and the connection use
    // are not.
    if (running) return;
    running = true;

    try {
      /*
       * A short lease, so N instances polling every five seconds produce
       * roughly one claim query every five seconds rather than N. The lease is
       * deliberately shorter than the interval — if the holder dies mid-pass,
       * another instance picks up almost immediately, and the rows it had
       * claimed are still locked only for the length of its transaction.
       */
      const leased = await claimOnce(options.redis, 'outbox:lease', 3).catch(() => true);
      if (!leased) return;

      const result = await dispatchOutbox(options.db, options.handler, options.batchSize ?? 25);

      if (options.resumeAutomations) {
        const resumed = await options.resumeAutomations().catch((error: unknown) => {
          options.logger.error({ err: error }, 'Automation resume pass failed');
          return 0;
        });
        if (resumed > 0) options.logger.info({ resumed }, 'Automation runs resumed');
      }

      if (options.dispatchReminders) {
        const reminders = await options.dispatchReminders().catch((error: unknown) => {
          options.logger.error({ err: error }, 'Reminder dispatch pass failed');
          return 0;
        });
        if (reminders > 0) options.logger.info({ reminders }, 'Appointment reminders dispatched');
      }

      if (options.runSchedules) {
        const matched = await options.runSchedules().catch((error: unknown) => {
          options.logger.error({ err: error }, 'Schedule sweep failed');
          return 0;
        });
        if (matched > 0) options.logger.info({ matched }, 'Scheduled automations matched');
      }

      if (result.claimed > 0) {
        options.logger.info({ ...result }, 'Outbox dispatched');
      }
      if (result.dead > 0) {
        // A dead event needs a person. Logged at error so it reaches whatever
        // is watching, rather than sitting in a table nobody queries.
        options.logger.error(
          { dead: result.dead },
          'Events exhausted their retries and were parked. Inspect event_outbox where status = dead.',
        );
      }
    } catch (error) {
      // The loop must survive anything a handler throws, or one bad event
      // stops every future dispatch.
      options.logger.error({ err: error }, 'Outbox dispatch pass failed');
    } finally {
      running = false;
    }
  };

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => void runOnce(), intervalMs);
      // Do not hold the process open: a graceful shutdown should not wait for
      // the next tick of a polling loop.
      timer.unref();
      options.logger.info({ intervalMs }, 'Outbox dispatcher started');
    },

    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },

    runOnce,
  };
}
