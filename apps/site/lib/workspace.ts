import {
  resolveWorkspaceConfig,
  workspaceConfigSchema,
  type ResolvedWorkspaceConfig,
} from '@bos/business-types';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Load the active tenant's configuration.
 *
 * One deployment serves one workspace, chosen by `BOS_WORKSPACE_SLUG`. The
 * config is read from `configs/<slug>/business.json` and validated — a typo in
 * a phone number or a missing country code fails the boot, not the LocalBusiness
 * schema three weeks later.
 */
let cached: ResolvedWorkspaceConfig | undefined;

export async function getWorkspace(): Promise<ResolvedWorkspaceConfig> {
  if (cached) return cached;

  const slug = process.env.BOS_WORKSPACE_SLUG;
  if (!slug)
    throw new Error('BOS_WORKSPACE_SLUG is not set — the site does not know which business it is.');

  const path = resolve(process.cwd(), '../../configs', slug, 'business.json');
  const raw = await readFile(path, 'utf8').catch((error: unknown) => {
    throw new Error(`Could not read the workspace config at ${path}: ${String(error)}`);
  });

  const parsed = workspaceConfigSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid workspace config for "${slug}":\n${detail}`);
  }

  cached = resolveWorkspaceConfig(parsed.data);
  return cached;
}
