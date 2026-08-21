import Redis from 'ioredis';

/**
 * The Redis connection.
 *
 * Used for three things the database is the wrong tool for: rate-limit
 * counters (write-heavy, worthless after a minute), the workspace slug cache
 * (read on every single request), and short-lived authentication state such as
 * a half-finished MFA challenge.
 *
 * Nothing durable lives here. If Redis is wiped the platform keeps working —
 * rate limits reset, caches refill, and a user part-way through an MFA
 * challenge starts it again. That property is what makes it safe to run a
 * single unreplicated instance.
 */
let client: Redis | undefined;

export function createRedis(url: string): Redis {
  client ??= new Redis(url, {
    // Fail a command rather than queue it forever behind a dead server: a
    // rate-limit check that hangs is worse than one that errors, because the
    // request it is guarding hangs with it.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    connectTimeout: 3_000,
    lazyConnect: false,
  });
  return client;
}

export async function closeRedis(): Promise<void> {
  await client?.quit().catch(() => undefined);
  client = undefined;
}

export type RedisClient = Redis;

/**
 * A fixed-window counter.
 *
 * Fixed rather than sliding on purpose: a sliding window needs a sorted set
 * per key and an O(log n) trim on every request, and the failure it prevents —
 * a burst straddling a window boundary — costs at most a doubled allowance for
 * one window. That is an acceptable trade for a counter that is two Redis
 * commands.
 *
 * The INCR and EXPIRE are pipelined so a crash between them cannot leave a key
 * without a TTL, which would silently lock a caller out forever.
 */
export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetSeconds: number;
  readonly count: number;
}

export async function consumeRateLimit(
  redis: RedisClient,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitVerdict> {
  const results = await redis.multi().incr(key).expire(key, windowSeconds, 'NX').ttl(key).exec();

  // A Redis outage must not become an open door *or* a total outage. Failing
  // closed on the login route and open on a read route is the right split, so
  // the decision is pushed to the caller by reporting the failure as "allowed
  // with no information" and letting the route's own policy apply.
  if (!results) {
    return { allowed: true, remaining: limit, resetSeconds: windowSeconds, count: 0 };
  }

  const count = Number(results[0]?.[1] ?? 0);
  const ttl = Number(results[2]?.[1] ?? windowSeconds);

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetSeconds: ttl > 0 ? ttl : windowSeconds,
    count,
  };
}

/** Clear a counter — called after a successful login so one typo is not sticky. */
export async function resetRateLimit(redis: RedisClient, key: string): Promise<void> {
  await redis.del(key).catch(() => undefined);
}

/**
 * Claim an idempotency key.
 *
 * Returns true exactly once per key within the TTL. Used to stop a queue
 * redelivery from sending a second confirmation email — the guarantee that
 * makes `max_retries = 5` on the event queue safe rather than terrifying.
 */
export async function claimOnce(
  redis: RedisClient,
  key: string,
  ttlSeconds: number,
): Promise<boolean> {
  const result = await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}
