/**
 * Permissions and roles.
 *
 * The rule this file exists to make unbreakable: **every route is either
 * declared public or declares a permission.** There is no third state, and no
 * default. A route registered without saying which it is fails at startup, in
 * CI, with the route's method and path in the message — rather than shipping
 * as an unauthenticated endpoint nobody notices until it is indexed.
 *
 * See `assertEveryRouteIsClassified` in app.ts for the enforcement, and
 * docs/architecture/07-security-and-data-protection.md for the model.
 */

export const PERMISSIONS = [
  // Content
  'content.read',
  'content.write',
  'content.publish',
  'content.delete',
  // Media
  'media.read',
  'media.write',
  'media.delete',
  // Private documents — separated from media on purpose. Someone who may
  // upload a hero image has no business reading a student's transcript.
  'documents.read',
  'documents.download',
  'documents.write',
  'documents.delete',
  // CRM
  'leads.read',
  'leads.write',
  'leads.assign',
  'leads.delete',
  'contacts.read',
  'contacts.write',
  'contacts.delete',
  'tasks.read',
  'tasks.write',
  // Forms
  'forms.read',
  'forms.write',
  'forms.submissions.read',
  // Business configuration
  'services.read',
  'services.write',
  'locations.read',
  'locations.write',
  'appointments.read',
  'appointments.write',
  'reviews.read',
  'reviews.write',
  // Analytics and SEO
  'analytics.read',
  'seo.read',
  'seo.write',
  // Automation — read shows definitions and run history (which can include
  // webhook configuration), write can send messages at scale; both sit above
  // the day-to-day roles on purpose.
  'automations.read',
  'automations.write',
  // Administration
  'members.read',
  'members.invite',
  'members.manage',
  'settings.read',
  'settings.write',
  'audit.read',
  'apikeys.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const WORKSPACE_ROLES = ['owner', 'admin', 'manager', 'staff', 'viewer'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/**
 * What each role may do.
 *
 * Written out per role rather than as a hierarchy of "admin includes manager".
 * A hierarchy reads well and then hides the one grant somebody did not intend
 * to hand down; a flat table is longer and can be read in full during a review,
 * which is the property that matters for an authorisation table.
 */
const VIEWER: readonly Permission[] = [
  'content.read',
  'media.read',
  'leads.read',
  'contacts.read',
  'tasks.read',
  'forms.read',
  'services.read',
  'locations.read',
  'appointments.read',
  'reviews.read',
  'analytics.read',
  'seo.read',
  'settings.read',
];

/**
 * Staff run the day-to-day: they work leads and answer enquiries.
 *
 * Deliberately absent: `documents.download`. Seeing that a transcript was
 * attached is part of working a lead; opening it is a separate decision, and
 * it is granted per person through `extraPermissions` so the audit log has
 * someone to name.
 */
const STAFF: readonly Permission[] = [
  ...VIEWER,
  'leads.write',
  'contacts.write',
  'tasks.write',
  'documents.read',
  'forms.submissions.read',
  'content.write',
  'media.write',
];

const MANAGER: readonly Permission[] = [
  ...STAFF,
  'leads.assign',
  'automations.read',
  'documents.download',
  'documents.write',
  'content.publish',
  'forms.write',
  'services.write',
  'locations.write',
  'appointments.write',
  'reviews.write',
  'seo.write',
  'members.read',
];

const ADMIN: readonly Permission[] = [
  ...MANAGER,
  'automations.write',
  'content.delete',
  'media.delete',
  'documents.delete',
  'leads.delete',
  'contacts.delete',
  'members.invite',
  'members.manage',
  'settings.write',
  'audit.read',
  'apikeys.manage',
];

export const ROLE_PERMISSIONS: Readonly<Record<WorkspaceRole, readonly Permission[]>> = {
  viewer: VIEWER,
  staff: STAFF,
  manager: MANAGER,
  admin: ADMIN,
  // The owner is the only role that holds every permission by construction, so
  // adding a permission above cannot silently leave the owner unable to use it.
  owner: PERMISSIONS,
};

/**
 * Grants a role must never receive through `extraPermissions`.
 *
 * `extraPermissions` is additive, and additive-without-a-ceiling means a
 * viewer can be handed `members.manage` one row at a time until they are an
 * owner. This is the ceiling.
 */
const ROLE_CEILING: Readonly<Record<WorkspaceRole, readonly Permission[]>> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  manager: ADMIN,
  staff: MANAGER,
  viewer: STAFF,
};

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Resolve a member's effective permissions.
 *
 * Extra grants are intersected with the role's ceiling before being unioned
 * with the role's own set, so a grant that would promote someone past their
 * role is dropped rather than honoured.
 */
export function effectivePermissions(
  role: WorkspaceRole,
  extraPermissions: readonly string[] = [],
): ReadonlySet<Permission> {
  const ceiling = new Set(ROLE_CEILING[role]);
  const granted = new Set<Permission>(ROLE_PERMISSIONS[role]);

  for (const candidate of extraPermissions) {
    if (isPermission(candidate) && ceiling.has(candidate)) granted.add(candidate);
  }

  return granted;
}

export function roleHas(role: WorkspaceRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * How a route is classified.
 *
 * `public` is a positive assertion, not an absence: writing it is a decision
 * somebody makes and a reviewer can see in the diff.
 */
export type RouteAccess =
  | { readonly kind: 'public'; readonly why: string }
  /** Authenticated session, plus the named permission in the active workspace. */
  | { readonly kind: 'permission'; readonly permission: Permission }
  /** Authenticated session, no further permission — e.g. "who am I". */
  | { readonly kind: 'authenticated' }
  /** Called by the edge Worker with the shared secret, never by a browser. */
  | { readonly kind: 'internal' };

export const publicRoute = (why: string): RouteAccess => ({ kind: 'public', why });
export const requirePermission = (permission: Permission): RouteAccess => ({
  kind: 'permission',
  permission,
});
export const authenticatedRoute = (): RouteAccess => ({ kind: 'authenticated' });
export const internalRoute = (): RouteAccess => ({ kind: 'internal' });
