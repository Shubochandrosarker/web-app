/**
 * Release-target selection.
 *
 * The readiness script and the Release Gate both need one answer to "which
 * tenants does this run gate?" — and getting it wrong in either direction is
 * a production incident: a fixture tenant's deliberate placeholders must
 * never block a real release, and a real tenant must never be silently
 * skipped because somebody mistyped its slug.
 *
 * The logic is a pure function so the behaviour is unit-tested directly,
 * not through spawning the CLI.
 */

export interface ReleaseTenant {
  readonly slug: string;
  readonly releaseEligible: boolean;
}

export interface ReleaseSelection {
  /** Tenants whose readiness blockers fail the run. */
  readonly targets: readonly string[];
  /** Tenants reported for information only (fixtures in a bare sweep). */
  readonly informational: readonly string[];
  /** Fatal selection problems — a run with errors must exit non-zero. */
  readonly errors: readonly string[];
}

export function selectReleaseTargets(
  tenants: readonly ReleaseTenant[],
  requested: readonly string[],
  releaseEligibleOnly: boolean,
): ReleaseSelection {
  const bySlug = new Map(tenants.map((tenant) => [tenant.slug, tenant]));

  if (requested.length > 0) {
    // Naming a tenant is release intent: it must exist and must be marked
    // eligible. "Unknown tenant" and "fixture named for release" are both
    // loud failures, never silent skips.
    const errors: string[] = [];
    const targets: string[] = [];
    for (const slug of requested) {
      const tenant = bySlug.get(slug);
      if (!tenant) {
        errors.push(`Unknown tenant "${slug}" — no configs/${slug}/business.json.`);
        continue;
      }
      if (!tenant.releaseEligible) {
        errors.push(
          `Tenant "${slug}" is not marked environment.releaseEligible. ` +
            'A fixture cannot be released; if this tenant is real, mark it eligible ' +
            'in its business.json — deliberately, in a reviewed change.',
        );
        continue;
      }
      targets.push(slug);
    }
    return { targets, informational: [], errors };
  }

  const eligible = tenants.filter((tenant) => tenant.releaseEligible).map((tenant) => tenant.slug);
  const fixtures = tenants.filter((tenant) => !tenant.releaseEligible).map((tenant) => tenant.slug);

  if (releaseEligibleOnly) {
    // A platform release with zero eligible tenants is a misconfiguration,
    // not a success.
    return {
      targets: eligible,
      informational: [],
      errors:
        eligible.length === 0
          ? ['No tenant is marked environment.releaseEligible; nothing can be released.']
          : [],
    };
  }

  // Bare sweep: gate the eligible tenants, report the fixtures.
  return { targets: eligible, informational: fixtures, errors: [] };
}
