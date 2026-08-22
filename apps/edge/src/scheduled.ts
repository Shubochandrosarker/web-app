import { consumersEnabled, type Env } from './env.ts';

/**
 * Nightly maintenance.
 *
 * The Worker triggers the work; the API performs it. Rollups and retention
 * sweeps need transactions and cross-tenant access, which belong next to the
 * database — the cron's contribution is being a reliable clock, not a place to
 * run business logic.
 *
 * The job list is now exactly the set of endpoints the API implements. It
 * previously named three that did not exist, so every night produced three
 * failures and no work.
 */
const JOBS = [
  // Drains anything the in-process dispatcher missed — a confirmation whose
  // provider was down, an event written while the API was restarting.
  'outbox.dispatch',
  // Same backstop for automation runs sleeping past every instance's loop.
  'automations.resume',
  // Schedule-triggered automations; idempotent per minute, so overlap with
  // the in-process sweep is harmless.
  'automations.schedule',
  'analytics.rollup',
  // Search Console lags ~2 days; the nightly pull re-ingests a trailing
  // window and upserts, so late data corrects itself.
  'gsc.ingest',
  'documents.retention_sweep',
  // Publishes content whose scheduled time has passed.
  'seo.audit_refresh',
] as const;

export async function runScheduled(event: ScheduledController, env: Env): Promise<void> {
  if (!consumersEnabled(env)) {
    console.warn('Scheduled jobs are disabled; skipping', { cron: event.cron });
    return;
  }

  for (const job of JOBS) {
    try {
      const response = await fetch(`${env.API_BASE_URL}/v1/internal/jobs/${job}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bos-edge-secret': env.EDGE_SHARED_SECRET,
        },
        body: JSON.stringify({ scheduledTime: event.scheduledTime, cron: event.cron }),
        // A rollup over a busy day takes real time; a retention sweep deletes
        // objects one at a time. Both are well inside a minute in practice.
        signal: AbortSignal.timeout(120_000),
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
