export interface Env {
  readonly ENVIRONMENT: string;
  readonly API_BASE_URL: string;
  /** Signs Worker → API calls so the API can distinguish them from the public. */
  readonly EDGE_SHARED_SECRET: string;
  /**
   * Origins allowed to post analytics, and the workspace each maps to.
   *
   * A JSON object: `{"https://nuesheba.com": "nuesheba"}`.
   *
   * This is what stops a page on any origin writing into any tenant's
   * analytics. The collector used to take the workspace slug from the request
   * body — which is a value the browser controls, so anyone who read the site's
   * JavaScript could post events into a competitor's dashboard, or into a
   * workspace whose slug they guessed.
   */
  readonly ANALYTICS_ORIGINS: string;
  readonly INDEXNOW_KEY?: string;
  readonly EVENT_QUEUE: Queue<unknown>;
  readonly PUBLIC_ASSETS: R2Bucket;
  /**
   * Whether the queue consumer and cron are wired to real API endpoints.
   *
   * `"true"` once `/v1/internal/*` is deployed. Anything else and the Worker
   * declines the work rather than forwarding it to a 404 — a consumer posting
   * to a route that does not exist retries five times per message and fills
   * the dead-letter queue, which is worse than doing nothing.
   */
  readonly CONSUMERS_ENABLED?: string;
}

/**
 * Resolve a request's origin to a workspace.
 *
 * Returns null for an origin that is not configured, and the caller answers
 * 403. Deliberately strict: an unrecognised origin is either a
 * misconfiguration somebody should notice, or somebody else's page posting
 * events, and both deserve the same answer.
 */
export function workspaceForOrigin(env: Env, origin: string | null): string | null {
  if (!origin) return null;

  let map: Record<string, string>;
  try {
    map = JSON.parse(env.ANALYTICS_ORIGINS) as Record<string, string>;
  } catch {
    // A malformed binding means no origin resolves, so the collector rejects
    // everything rather than failing open.
    return null;
  }

  return map[origin] ?? null;
}

export function consumersEnabled(env: Env): boolean {
  return env.CONSUMERS_ENABLED === 'true';
}
