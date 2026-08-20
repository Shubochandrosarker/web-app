import type { Env } from './env.ts';

/**
 * Nightly maintenance.
 *
 * The Worker triggers the work; the API performs it. Rollups and retention
 * sweeps need transactions and cross-tenant access, which belong next to the
 * database — the cron's contribution is being a reliable clock, not a place to
 * run business logic.
 */
const JOBS = ['analytics.rollup', 'documents.retention_sweep', 'seo.audit_refresh'] as const;

export async function runScheduled(event: ScheduledController, env: Env): Promise<void> {
  for (const job of JOBS) {
    try {
      const response = await fetch(`${env.API_BASE_URL}/v1/internal/jobs/${job}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bos-edge-secret': env.EDGE_SHARED_SECRET,
        },
        body: JSON.stringify({ scheduledTime: event.scheduledTime, cron: event.cron }),
      });

      if (!response.ok) {
        // Logged and continued rather than thrown: one failing job must not
        // stop the retention sweep from running for another night.
        console.error(`Scheduled job ${job} failed`, { status: response.status });
      }
    } catch (error) {
      console.error(`Scheduled job ${job} threw`, { error });
    }
  }
}
