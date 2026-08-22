import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  checkProductionReadiness,
  formatReadinessReport,
  resolveWorkspaceConfig,
  selectReadinessTenants,
  workspaceConfigSchema,
} from '@bos/business-types';

/**
 * The launch gate for tenant configuration.
 *
 * Run in CI and before a production deploy:
 *
 *   pnpm check:readiness                    # every config, including fixtures
 *   pnpm check:readiness nuesheba           # one explicit tenant
 *   pnpm check:readiness --release-eligible # opted-in production tenants
 *
 * Exits non-zero when any workspace has a blocker, which is what stops a
 * placeholder phone number reaching structured data. Release-eligible mode
 * intentionally excludes demo/fixture tenants; the release workflow names
 * `nuesheba` explicitly so a real production tenant cannot be skipped.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const releaseEligibleOnly = args.includes('--release-eligible');
  const requested = args.filter((arg) => !arg.startsWith('--'));
  if (requested.length > 1) {
    throw new Error('Pass at most one tenant slug, or use --release-eligible.');
  }

  const configsDir = resolve(process.cwd(), 'configs');
  const tenantDirectories = (await readdir(configsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const entries = await Promise.all(
    tenantDirectories.map(async (slug) => {
      const path = resolve(configsDir, slug, 'business.json');
      const raw = await readFile(path, 'utf8').catch(() => null);
      let json: unknown;
      try {
        json = raw === null ? undefined : JSON.parse(raw);
      } catch {
        json = undefined;
      }
      const parsed = workspaceConfigSchema.safeParse(json);
      return {
        slug,
        path,
        raw,
        parsed,
        releaseEligible: parsed.success && parsed.data.environment.releaseEligible === true,
      };
    }),
  );

  const slugs = selectReadinessTenants(entries, requested[0], releaseEligibleOnly);

  let blockers = 0;

  for (const slug of slugs) {
    const entry = entries.find((candidate) => candidate.slug === slug);
    if (!entry || entry.raw === null) {
      console.error(
        `No configuration at ${entry?.path ?? resolve(configsDir, slug, 'business.json')}`,
      );
      blockers += 1;
      continue;
    }

    if (!entry.parsed.success) {
      // A config that does not even parse is a blocker of its own.
      console.error(`Invalid configuration for "${slug}":`);
      for (const issue of entry.parsed.error.issues) {
        console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
      }
      blockers += 1;
      continue;
    }

    const report = checkProductionReadiness(resolveWorkspaceConfig(entry.parsed.data));
    console.log(formatReadinessReport(report, slug));
    console.log('');
    blockers += report.blockers;
  }

  if (blockers > 0) {
    console.error(
      `\n${blockers} blocker(s) across ${slugs.length} selected workspace(s). ` +
        'These values would be published as fact — fill them in from the business, ' +
        'never by guessing.',
    );
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
