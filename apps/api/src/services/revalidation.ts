import type { ApiConfig } from '../lib/env.ts';

/**
 * Tell the public site that a page changed.
 *
 * Called from the outbox handler for `content.published`, which means it
 * inherits the outbox's retry: a site that is briefly down does not lose the
 * invalidation, it gets it on the next dispatch.
 *
 * The site does the actual work — expiring the page's cache tag and, if the
 * deployment is indexable, submitting the URL to IndexNow. This is a signal,
 * not an implementation, because only the site knows what its cache keys are.
 */
export interface RevalidationRequest {
  readonly paths: readonly string[];
  readonly locale: string;
}

export function createRevalidator(config: ApiConfig) {
  return async function revalidate(request: RevalidationRequest): Promise<void> {
    if (!config.SITE_URL) return;
    if (request.paths.length === 0) return;

    const response = await fetch(`${config.SITE_URL.replace(/\/+$/, '')}/api/revalidate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The same shared secret the Worker uses. This endpoint can purge any
        // page's cache, so an unauthenticated version would be a free
        // denial-of-service against the origin.
        'x-bos-edge-secret': config.EDGE_SHARED_SECRET,
      },
      body: JSON.stringify({
        paths: request.paths,
        locale: request.locale,
        // The site decides whether to submit; it is the process that knows
        // whether this deployment is indexable.
        submitToIndexNow: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      // Thrown so the outbox retries. A page that is live but still serving
      // its previous version is a real problem, and a silent one.
      throw new Error(`Revalidation was rejected: ${response.status} ${response.statusText}`);
    }
  };
}
