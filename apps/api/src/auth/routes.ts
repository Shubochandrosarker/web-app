import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/errors.ts';
import { authenticatedRoute, publicRoute, requirePermission } from '../lib/permissions.ts';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  requestContext,
  requireUserId,
  requireWorkspace,
} from '../lib/context.ts';
import type { AuthService, SessionTokens } from './service.ts';
import { consumeRateLimit, type RedisClient } from '../lib/redis.ts';

/**
 * Authentication endpoints.
 *
 * The cookie/JSON split is deliberate. A browser gets `HttpOnly` cookies so no
 * script can read a token even if one manages to run; a server-to-server
 * caller gets the tokens in the body because it has no cookie jar. Both are
 * the same tokens — the transport differs, the credential does not.
 */

const passwordSchema = z
  .string()
  // Length is the only requirement, and twelve is the floor. Composition rules
  // ("one uppercase, one symbol") measurably push people towards `Password1!`
  // and are advised against by NIST SP 800-63B for exactly that reason.
  .min(12, 'must be at least 12 characters')
  .max(200);

/**
 * How the caller wants its session credential delivered.
 *
 * `cookie` (the default) is the browser contract: `HttpOnly` cookies, and a
 * response body that carries **no token at all** — a script that manages to
 * run in the page has nothing to read. `body` is the machine contract: tokens
 * in JSON, no cookies, for callers with no cookie jar (integrations, tests,
 * the dashboard's own server). It must be asked for by name; a browser client
 * that never sends it can never receive a readable token.
 */
const tokenTransport = z.enum(['cookie', 'body']).default('cookie');

const loginBody = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(200),
  tokenTransport,
});

const mfaBody = z.object({
  challengeToken: z.string().min(1).max(200),
  code: z.string().min(6).max(20),
  tokenTransport,
});

export interface AuthRouteOptions {
  readonly auth: AuthService;
  readonly redis: RedisClient;
  readonly cookieDomain: string | undefined;
  readonly isProduction: boolean;
  readonly accessTokenTtl: number;
  readonly refreshTokenTtl: number;
  /** Called when a reset or invitation email needs sending. */
  readonly sendAuthEmail: (message: {
    kind: 'password_reset' | 'invitation';
    to: string;
    token: string;
  }) => Promise<void>;
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const { auth, redis } = options;

  /**
   * Session cookies.
   *
   * `sameSite: 'lax'` rather than `'strict'`: the dashboard is a separate
   * subdomain and a link from an email into it must not land on a logged-out
   * page. `'lax'` still blocks the cross-site POST that CSRF needs, and the
   * refresh cookie is additionally pinned to the refresh path so it is not
   * even sent on ordinary API calls.
   */
  const setSessionCookies = (reply: FastifyReply, tokens: SessionTokens): void => {
    const base = {
      httpOnly: true,
      secure: options.isProduction,
      sameSite: 'lax' as const,
      path: '/',
      ...(options.cookieDomain ? { domain: options.cookieDomain } : {}),
    };

    reply.setCookie(ACCESS_COOKIE, tokens.accessToken, {
      ...base,
      maxAge: options.accessTokenTtl,
    });
    reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
      ...base,
      path: '/v1/auth',
      maxAge: options.refreshTokenTtl,
    });
  };

  const clearSessionCookies = (reply: FastifyReply): void => {
    const base = {
      path: '/',
      ...(options.cookieDomain ? { domain: options.cookieDomain } : {}),
    };
    reply.clearCookie(ACCESS_COOKIE, base);
    reply.clearCookie(REFRESH_COOKIE, { ...base, path: '/v1/auth' });
  };

  const publicAuth = publicRoute(
    'Authentication entry point; throttled per account and per address.',
  );

  /**
   * Deliver a fresh session on the requested transport.
   *
   * Exactly one of the two happens: cookies with a token-free body, or tokens
   * in the body with no cookie. Both at once — which is what this API used to
   * do — hands a browser a script-readable refresh token alongside the
   * `HttpOnly` one, and the `HttpOnly` is then decoration.
   */
  const deliverSession = (
    reply: FastifyReply,
    tokens: SessionTokens,
    transport: 'cookie' | 'body',
  ): Record<string, unknown> => {
    if (transport === 'body') {
      return {
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
        refreshToken: tokens.refreshToken,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
      };
    }

    setSessionCookies(reply, tokens);
    return {
      // Expiry metadata is not a credential: the client schedules its silent
      // refresh from it, and cannot derive a token from a timestamp.
      accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    };
  };

  app.post('/v1/auth/login', { config: { bosAccess: publicAuth } }, async (request, reply) => {
    const body = loginBody.parse(request.body);
    const outcome = await auth.login(body.email, body.password, requestContext(request));

    if (outcome.kind === 'mfa_required') {
      return reply.status(200).send({
        mfaRequired: true,
        challengeToken: outcome.challengeToken,
        expiresInSeconds: outcome.expiresInSeconds,
      });
    }

    return reply.status(200).send({
      mfaRequired: false,
      user: outcome.user,
      ...deliverSession(reply, outcome.tokens, body.tokenTransport),
    });
  });

  app.post('/v1/auth/mfa/verify', { config: { bosAccess: publicAuth } }, async (request, reply) => {
    const body = mfaBody.parse(request.body);
    const outcome = await auth.verifyMfaChallenge(
      body.challengeToken,
      body.code,
      requestContext(request),
    );

    // `verifyMfaChallenge` only ever returns an authenticated outcome; the
    // union is shared with `login` and this narrows it for the response.
    if (outcome.kind !== 'authenticated') throw ApiError.invalidCredentials();

    return reply.status(200).send({
      user: outcome.user,
      ...deliverSession(reply, outcome.tokens, body.tokenTransport),
    });
  });

  /**
   * Rotate the session.
   *
   * The refresh token comes from the cookie when there is one and from the
   * body otherwise. Presenting an already-rotated token revokes the whole
   * family — see `AuthService.refresh` for why that is the only safe response.
   */
  app.post(
    '/v1/auth/refresh',
    {
      config: {
        bosAccess: publicRoute('Rotates a session using a refresh token the caller already holds.'),
      },
    },
    async (request, reply) => {
      const fromCookie = (request.cookies as Record<string, string | undefined>)[REFRESH_COOKIE];
      const parsed = z
        .object({ refreshToken: z.string().min(1).max(400).optional() })
        .parse(request.body ?? {});

      const token = fromCookie ?? parsed.refreshToken;
      if (!token) throw ApiError.unauthorized();

      /*
       * The transport follows the credential: a caller that presented a body
       * token gets body tokens back, one that presented the cookie gets
       * rotated cookies. A cookie-presenting caller cannot opt into a body
       * response — that would let injected script upgrade an unreadable
       * session into a readable one with a single self-request.
       */
      const transport = fromCookie ? ('cookie' as const) : ('body' as const);

      try {
        const tokens = await auth.refresh(token, requestContext(request));
        return reply.status(200).send(deliverSession(reply, tokens, transport));
      } catch (error) {
        // A dead session must not leave a stale cookie behind, or the browser
        // retries with it forever.
        if (fromCookie) clearSessionCookies(reply);
        throw error;
      }
    },
  );

  app.post(
    '/v1/auth/logout',
    { config: { bosAccess: publicRoute('Ends a session; safe to call without one.') } },
    async (request, reply) => {
      const token =
        (request.cookies as Record<string, string | undefined>)[REFRESH_COOKIE] ??
        z.object({ refreshToken: z.string().max(400).optional() }).parse(request.body ?? {})
          .refreshToken;

      if (token) await auth.logout(token);
      clearSessionCookies(reply);
      return reply.status(204).send();
    },
  );

  app.post(
    '/v1/auth/logout-all',
    { config: { bosAccess: authenticatedRoute() } },
    async (request, reply) => {
      const count = await auth.logoutAll(requireUserId(request));
      clearSessionCookies(reply);
      return reply.status(200).send({ revokedSessions: count });
    },
  );

  /* ------------------------------------------------------------- sessions */

  app.get('/v1/auth/sessions', { config: { bosAccess: authenticatedRoute() } }, async (request) => {
    const sessions = await auth.listSessions(requireUserId(request), request.auth?.sessionId ?? '');
    return {
      sessions: sessions.map((session) => ({
        id: session.id,
        userAgent: session.userAgent,
        ipAddress: session.ipAddress,
        createdAt: session.createdAt.toISOString(),
        lastSeenAt: session.lastSeenAt?.toISOString() ?? null,
        expiresAt: session.expiresAt.toISOString(),
        current: session.current,
      })),
    };
  });

  app.delete(
    '/v1/auth/sessions/:id',
    { config: { bosAccess: authenticatedRoute() } },
    async (request, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const revoked = await auth.revokeSession(requireUserId(request), id);
      if (!revoked) throw ApiError.notFound('Session');

      await auth.audit(
        null,
        requireUserId(request),
        'auth.session_revoked',
        requestContext(request),
        {
          sessionId: id,
        },
      );
      return reply.status(204).send();
    },
  );

  /* ------------------------------------------------------------------ me */

  app.get('/v1/auth/me', { config: { bosAccess: authenticatedRoute() } }, async (request) => {
    const userId = requireUserId(request);
    const [user, memberships] = await Promise.all([
      auth.getUser(userId),
      auth.listMemberships(userId),
    ]);

    return {
      user,
      workspaces: memberships.map((membership) => ({
        id: membership.workspaceId,
        slug: membership.workspaceSlug,
        name: membership.workspaceName,
        role: membership.role,
        // Sent so the dashboard can hide what the user cannot do. It is a UI
        // hint and nothing more — every route re-checks server-side.
        permissions: [...membership.permissions],
        enabledModules: membership.enabledModules,
      })),
    };
  });

  /* ------------------------------------------------------------ passwords */

  /**
   * Request a reset link.
   *
   * Always reports success. Reporting "no such account" would turn this into
   * an address-enumeration endpoint, and the person who genuinely mistyped
   * their address is helped by the email that never arrives, not by a message
   * that also helps an attacker.
   */
  app.post(
    '/v1/auth/password/forgot',
    {
      config: {
        bosAccess: publicRoute(
          'Starts a password reset; reveals nothing about which accounts exist.',
        ),
      },
    },
    async (request, reply) => {
      const body = z.object({ email: z.email().max(320) }).parse(request.body);

      const limit = await consumeRateLimit(redis, `rl:pwreset:${request.clientIpPrefix}`, 5, 3600);
      if (!limit.allowed) {
        throw new ApiError(429, 'too_many_requests', 'Too many reset requests. Try again later.');
      }

      const created = await auth.createPasswordResetToken(body.email);
      if (created) {
        await options.sendAuthEmail({
          kind: 'password_reset',
          to: body.email,
          token: created.token,
        });
      }

      return reply.status(202).send({ status: 'accepted' });
    },
  );

  app.post(
    '/v1/auth/password/reset',
    { config: { bosAccess: publicRoute('Completes a password reset with a token from email.') } },
    async (request, reply) => {
      const body = z
        .object({ token: z.string().min(1).max(400), password: passwordSchema })
        .parse(request.body);

      await auth.resetPassword(body.token, body.password, requestContext(request));
      clearSessionCookies(reply);
      return reply.status(204).send();
    },
  );

  app.post(
    '/v1/auth/password/change',
    { config: { bosAccess: authenticatedRoute() } },
    async (request, reply) => {
      const body = z
        .object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema })
        .parse(request.body);

      await auth.changePassword(
        requireUserId(request),
        body.currentPassword,
        body.newPassword,
        requestContext(request),
      );
      return reply.status(204).send();
    },
  );

  /* ------------------------------------------------------------------ MFA */

  app.post('/v1/auth/mfa/enrol', { config: { bosAccess: authenticatedRoute() } }, async (request) =>
    auth.beginMfaEnrolment(requireUserId(request)),
  );

  app.post(
    '/v1/auth/mfa/confirm',
    { config: { bosAccess: authenticatedRoute() } },
    async (request) => {
      const body = z.object({ code: z.string().min(6).max(10) }).parse(request.body);
      return auth.confirmMfaEnrolment(requireUserId(request), body.code, requestContext(request));
    },
  );

  app.post(
    '/v1/auth/mfa/disable',
    { config: { bosAccess: authenticatedRoute() } },
    async (request, reply) => {
      const body = z.object({ password: z.string().min(1).max(200) }).parse(request.body);
      await auth.disableMfa(requireUserId(request), body.password, requestContext(request));
      return reply.status(204).send();
    },
  );

  /* ---------------------------------------------------------- invitations */

  app.post(
    '/v1/workspaces/members/invite',
    { config: { bosAccess: requirePermission('members.invite') } },
    async (request, reply) => {
      const workspace = requireWorkspace(request);
      const body = z
        .object({
          email: z.email().max(320),
          role: z.enum(['admin', 'manager', 'staff', 'viewer']),
        })
        .parse(request.body);

      const created = await auth.createInvitation(
        workspace.workspaceId,
        body.email,
        body.role,
        requireUserId(request),
      );

      await options.sendAuthEmail({ kind: 'invitation', to: body.email, token: created.token });
      await auth.audit(
        workspace.workspaceId,
        requireUserId(request),
        'member.invited',
        requestContext(request),
        { email: body.email, role: body.role },
      );

      return reply.status(201).send({ invitationId: created.invitationId });
    },
  );

  app.post(
    '/v1/auth/invitations/accept',
    { config: { bosAccess: publicRoute('Completes an invitation with a token from email.') } },
    async (request, reply) => {
      const body = z
        .object({
          token: z.string().min(1).max(400),
          fullName: z.string().min(1).max(200),
          password: passwordSchema,
          tokenTransport,
        })
        .parse(request.body);

      const tokens = await auth.acceptInvitation(
        body.token,
        body.fullName,
        body.password,
        requestContext(request),
      );

      return reply.status(201).send(deliverSession(reply, tokens, body.tokenTransport));
    },
  );
}
