import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  checkProductionReadiness,
  formatReadinessReport,
  resolveWorkspaceConfig,
  workspaceConfigSchema,
} from '@bos/business-types';

/**
 * The launch gate for tenant configuration.
 *
 * Run in CI and before a production deploy:
 *
 *   pnpm check:readiness            # every workspace in configs/
 *   pnpm check:readiness nuesheba   # one
 *
 * Exits non-zero when any workspace has a blocker, which is what stops a
 * placeholder phone number reaching structured data. Warnings are printed and
 * do not fail — they are things to fix, not things that must not ship.
 */
async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const configsDir = resolve(process.cwd(), 'configs');

  const slugs =
    requested.length > 0
      ? requested
      : (await readdir(configsDir, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);

  let blockers = 0;

  for (const slug of slugs) {
    const path = resolve(configsDir, slug, 'business.json');
    const raw = await readFile(path, 'utf8').catch(() => null);
    if (raw === null) {
      console.error(`No configuration at ${path}`);
      blockers += 1;
      continue;
    }

    const parsed = workspaceConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      // A config that does not even parse is a blocker of its own.
      console.error(`Invalid configuration for "${slug}":`);
      for (const issue of parsed.error.issues) {
        console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
      }
      blockers += 1;
      continue;
    }

    const report = checkProductionReadiness(resolveWorkspaceConfig(parsed.data));
    console.log(formatReadinessReport(report, slug));
    console.log('');
    blockers += report.blockers;
  }

  if (blockers > 0) {
    console.error(
      `\n${blockers} blocker(s) across ${slugs.length} workspace(s). ` +
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
