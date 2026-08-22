/** The small piece of release selection shared by the CLI and its tests. */
export interface ReleaseEligibilityEntry {
  readonly slug: string;
  readonly releaseEligible: boolean;
}

/**
 * Select tenant configs for a readiness run.
 *
 * An explicit tenant is always an intentional override. A platform release
 * without an explicit tenant is narrower: it can only include configs that
 * opt in with `environment.releaseEligible: true`.
 */
export function selectReadinessTenants(
  entries: readonly ReleaseEligibilityEntry[],
  requestedTenant: string | undefined,
  releaseEligibleOnly: boolean,
): readonly string[] {
  if (requestedTenant) {
    if (!entries.some((entry) => entry.slug === requestedTenant)) {
      const known = entries
        .map((entry) => entry.slug)
        .sort()
        .join(', ');
      throw new Error(`Unknown tenant "${requestedTenant}". Known tenants: ${known}`);
    }
    return [requestedTenant];
  }

  if (!releaseEligibleOnly) {
    return entries.map((entry) => entry.slug);
  }

  const eligible = entries.filter((entry) => entry.releaseEligible).map((entry) => entry.slug);
  if (eligible.length === 0) {
    throw new Error(
      'No release-eligible tenant found. Set environment.releaseEligible=true on the production tenant.',
    );
  }
  return eligible;
}
