import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import { eq } from 'drizzle-orm';
import { schema, withoutTenantScope, type Database } from '@bos/database';
import { ApiError } from './errors.ts';
import { constantTimeEqual, truncateIp } from './crypto.ts';
import type { Permission, RouteAccess } from './permissions.ts';
import type { AuthService, WorkspaceMembership } from '../auth/service.ts';
import type { RedisClient } from './redis.ts';

/**
 * Request classification and the authentication hook.
 *
 * The design goal is that "forgot to add auth" is not a thing that can happen.
 * Fastify has no notion of a route being protected, so one is added: every
 * route must carry a `bosAccess` config, and a startup assertion refuses to
 * listen if any route does not. A new endpoint that says nothing about its
 * access is a boot failure with the method and path in the message — not a
 * silently public endpoint.
 */

declare module 'fastify' {
  interface FastifyContextConfig {
    /** How this route is protected. Required — see `assertEveryRouteIsClassified`. */
    bosAccess?: RouteAccess;
  }

  interface FastifyRequest {
    /** Set for authenticated requests. */
    auth?: {
      readonly userId: string;
      readonly sessionId: string;
    };
    /** Set once a workspace has been resolved and access to it confirmed. */
    workspace?: WorkspaceMembership;
    /** Client address, already truncated for storage. */
    clientIpPrefix: string;
  }
}

export interface ContextDependencies {
  readonly db: Database;
  readonly redis: RedisClient;
  readonly auth: AuthService;
  readonly edgeSharedSecret: string;
}

/** The cookie the dashboard's browser session lives in. */
export const REFRESH_COOKIE = 'bos_refresh';
export const ACCESS_COOKIE = 'bos_access';

function clientIp(request: FastifyRequest): string {
  return request.ip ?? '0.0.0.0';
}

/**
 * Read the access token.
 *
 * Two transports, and both are needed: the dashboard is a browser and uses a
 * `HttpOnly` cookie so no script can read the token, while server-to-server
 * callers (the site's content fetches, integration tests) use a bearer header
 * because they have no cookie jar.
 */
function readAccessToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;

  const cookie = (request.cookies as Record<string, string | undefined>)[ACCESS_COOKIE];
  return cookie ?? null;
}

export function registerContext(app: FastifyInstance, deps: ContextDependencies): void {
  /**
   * Resolve a workspace slug to an id.
   *
   * On the path of every request, and slugs effectively never change, so it is
   * cached in Redis rather than read per call. `withoutTenantScope` is
   * explicit because this is the lookup that *establishes* the tenant context
   * and therefore cannot run inside it — and it selects only the id, so
   * nothing else about another tenant is reachable through it.
   */
  const resolveWorkspaceId = async (slug: string): Promise<string> => {
    const cacheKey = `ws:slug:${slug}`;
    const cached = await deps.redis.get(cacheKey).catch(() => null);
    if (cached) return cached;

    const id = await withoutTenantScope(deps.db, async (tx) => {
      const [row] = await tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.slug, slug))
        .limit(1);
      return row?.id;
    });

    if (!id) throw ApiError.hidden('Workspace');

    await deps.redis.set(cacheKey, id, 'EX', 300).catch(() => undefined);
    return id;
  };

  app.decorate('resolveWorkspaceId', resolveWorkspaceId);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    request.clientIpPrefix = truncateIp(clientIp(request));

    /*
     * A CORS preflight carries no credentials, no body and never reaches a
     * handler — @fastify/cors answers it from its own hook. Authenticating it
     * would reject every cross-origin request the browser is asking permission
     * for, before the real request is ever sent.
     */
    if (request.method === 'OPTIONS') return;

    const access = request.routeOptions.config.bosAccess;

    // A request that reached a handler with no classification is a bug that
    // the startup assertion should have caught. Refusing here as well means a
    // dynamically registered route cannot slip past it either.
    if (!access) {
      request.log.error(
        { method: request.method, url: request.url },
        'Route has no bosAccess classification',
      );
      throw ApiError.forbidden();
    }

    if (access.kind === 'public') return;

    if (access.kind === 'internal') {
      const presented = request.headers['x-bos-edge-secret'];
      if (typeof presented !== 'string' || !constantTimeEqual(presented, deps.edgeSharedSecret)) {
        // Logged rather than merely rejected: a call to an internal endpoint
        // from something that is not the Worker is worth knowing about.
        request.log.warn({ url: request.url }, 'Rejected an unsigned internal request');
        throw ApiError.unauthorized();
      }
      return;
    }

    const token = readAccessToken(request);
    if (!token) throw ApiError.unauthorized();

    const resolved = await deps.auth.resolveAccessToken(token);
    if (!resolved) throw ApiError.unauthorized();

    request.auth = resolved;

    if (access.kind === 'authenticated') return;

    /*
     * A permission-bearing route needs a workspace to check the permission
     * against. It comes from a header rather than the path so that every
     * dashboard route does not have to carry the slug, and it is *verified*
     * against the caller's memberships — a header the client controls decides
     * which workspace is asked about, never whether the answer is yes.
     */
    const slug = request.headers['x-bos-workspace'];
    if (typeof slug !== 'string' || slug.length === 0) {
      throw ApiError.badRequest('An X-Bos-Workspace header is required for this endpoint.');
    }

    const workspaceId = await resolveWorkspaceId(slug);
    const membership = await deps.auth.getMembership(resolved.userId, workspaceId);

    // Not a member: 404, not 403. A 403 confirms the workspace exists, which
    // is enough to enumerate tenants by trying slugs.
    if (!membership) throw ApiError.hidden('Workspace');

    if (!membership.permissions.has(access.permission)) {
      await deps.auth.audit(
        workspaceId,
        resolved.userId,
        'auth.permission_denied',
        { ipAddress: clientIp(request), userAgent: request.headers['user-agent'] ?? '' },
        { permission: access.permission, method: request.method, url: request.url },
      );
      throw ApiError.forbidden();
    }

    request.workspace = membership;
    void reply;
  });
}

/**
 * Fail the boot if any route did not declare how it is protected.
 *
 * This is the whole point of `bosAccess`. Called after every plugin has
 * registered and before `listen`, so the failure happens in CI and at deploy
 * time rather than in production traffic.
 */
export function assertEveryRouteIsClassified(routes: readonly RouteOptions[]): void {
  const methodsOf = (route: RouteOptions): string[] =>
    Array.isArray(route.method) ? route.method : [route.method];

  const unclassified = routes
    .filter((route) => route.config?.bosAccess === undefined)
    .filter((route) => {
      const declared = methodsOf(route);
      /*
       * Two exemptions, both for routes nobody wrote:
       *
       *  - HEAD is generated alongside every GET and shares its handler.
       *  - `OPTIONS *` is the CORS preflight responder @fastify/cors installs.
       *    It answers with headers and never reaches application code.
       *
       * Everything else must say what it is.
       */
      const generated =
        declared.every((method) => method === 'HEAD') ||
        (declared.every((method) => method === 'OPTIONS') && route.url === '*');
      return !generated;
    })
    .map((route) => `${methodsOf(route).join('|')} ${route.url}`);

  if (unclassified.length > 0) {
    throw new Error(
      'These routes do not declare how they are protected. Add a `config.bosAccess` of ' +
        'publicRoute(), requirePermission(), authenticatedRoute() or internalRoute():\n' +
        unclassified.map((route) => `  - ${route}`).join('\n'),
    );
  }
}

/** Narrow a request that a permission route has already authenticated. */
export function requireWorkspace(request: FastifyRequest): WorkspaceMembership {
  if (!request.workspace) {
    // Unreachable through the hook above; present so a handler that is moved
    // to a differently classified route fails loudly instead of reading
    // `undefined.workspaceId`.
    throw ApiError.unauthorized();
  }
  return request.workspace;
}

export function requireUserId(request: FastifyRequest): string {
  if (!request.auth) throw ApiError.unauthorized();
  return request.auth.userId;
}

export function hasPermission(request: FastifyRequest, permission: Permission): boolean {
  return request.workspace?.permissions.has(permission) ?? false;
}

export function requestContext(request: FastifyRequest): {
  ipAddress: string;
  userAgent: string;
} {
  return {
    ipAddress: clientIp(request),
    userAgent: request.headers['user-agent'] ?? '',
  };
}
