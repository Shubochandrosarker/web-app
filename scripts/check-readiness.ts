import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  checkProductionReadiness,
  formatReadinessReport,
  resolveWorkspaceConfig,
  selectReleaseTargets,
  workspaceConfigSchema,
  type ReleaseTenant,
  type WorkspaceConfig,
} from '@bos/business-types';

/**
 * The launch gate for tenant configuration.
 *
 *   pnpm check:readiness                      # sweep: gate eligible tenants,
 *                                             # report fixtures informationally
 *   pnpm check:readiness nuesheba             # release check for one tenant
 *   pnpm check:readiness --release-eligible   # platform release: every
 *                                             # tenant marked eligible
 *
 * Which tenants *gate* the run is decided by `environment.releaseEligible`
 * in each business.json (see @bos/business-types selectReleaseTargets):
 * fixture tenants like `demo-consultancy` carry deliberate placeholder
 * values and must never block a real release, while naming a tenant that is
 * unknown or not marked eligible is a loud failure, never a skip.
 *
 * Exits non-zero when any gated tenant has a blocker. Warnings are printed
 * and do not fail — they are things to fix, not things that must not ship.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const requested = args.filter((arg) => !arg.startsWith('--'));
  const releaseEligibleOnly = args.includes('--release-eligible');
  const configsDir = resolve(process.cwd(), 'configs');

  const slugs = (await readdir(configsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  // Parse every config once; a config that does not parse cannot declare its
  // eligibility, which for a *named* tenant must fail rather than skip.
  const parsedBySlug = new Map<string, WorkspaceConfig>();
  const parseErrors: string[] = [];
  for (const slug of slugs) {
    const path = resolve(configsDir, slug, 'business.json');
    const raw = await readFile(path, 'utf8').catch(() => null);
    if (raw === null) {
      parseErrors.push(`No configuration at ${path}`);
      continue;
    }
    const parsed = workspaceConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      parseErrors.push(
        `Invalid configuration for "${slug}": ` +
          parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; '),
      );
      continue;
    }
    parsedBySlug.set(slug, parsed.data);
  }

  const tenants: ReleaseTenant[] = [...parsedBySlug.entries()].map(([slug, config]) => ({
    slug,
    releaseEligible: config.environment.releaseEligible,
  }));

  const selection = selectReleaseTargets(tenants, requested, releaseEligibleOnly);

  for (const error of [...parseErrors, ...selection.errors]) {
    console.error(`ERROR: ${error}`);
  }

  let blockers = 0;

  for (const slug of selection.targets) {
    const report = checkProductionReadiness(resolveWorkspaceConfig(parsedBySlug.get(slug)!));
    console.log(formatReadinessReport(report, slug));
    console.log('');
    blockers += report.blockers;
  }

  for (const slug of selection.informational) {
    const report = checkProductionReadiness(resolveWorkspaceConfig(parsedBySlug.get(slug)!));
    console.log(
      `Fixture tenant — ${slug} (not release-eligible; reported for information, never gates)`,
    );
    console.log(
      `  ${report.blockers} blocker(s), ${report.warnings} warning(s) — expected for a fixture.`,
    );
    console.log('');
  }

  if (selection.errors.length > 0 || parseErrors.length > 0) {
    process.exit(1);
  }

  if (blockers > 0) {
    console.error(
      `\n${blockers} blocker(s) across ${selection.targets.length} release-eligible ` +
        'workspace(s). These values would be published as fact — fill them in from ' +
        'the business, never by guessing.',
    );
    process.exit(1);
  }

  if (selection.targets.length > 0) {
    console.log(`Release-eligible tenant(s) ready: ${selection.targets.join(', ')}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
