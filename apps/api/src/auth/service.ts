import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, withoutTenantScope, type Database } from '@bos/database';
import { ApiError } from '../lib/errors.ts';
import {
  burnPasswordTime,
  currentTotp,
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  hashToken,
  mintToken,
  totpUri,
  verifyPassword,
  verifyTotp,
} from '../lib/crypto.ts';
import { claimOnce, consumeRateLimit, resetRateLimit, type RedisClient } from '../lib/redis.ts';
import { effectivePermissions, type Permission, type WorkspaceRole } from '../lib/permissions.ts';

/**
 * Authentication.
 *
 * The session model, and why it is this one:
 *
 *  - **Opaque tokens, hashed at rest.** The client holds 32 random bytes; the
 *    database holds their SHA-256. A database read yields no usable
 *    credential, and revocation is a row update rather than a blocklist bolted
 *    onto a stateless token.
 *
 *  - **Refresh rotation with family reuse detection.** Every refresh issues a
 *    new token and marks the old one as replaced. Presenting a token that has
 *    already been replaced means either a race or a stolen token, and there is
 *    no way to tell which — so the entire family is revoked and the user is
 *    asked to log in again. Annoying once, versus an attacker with a
 *    self-renewing session forever.
 *
 *  - **A short-lived access token derived from the session.** The dashboard
 *    sends it on every call; it expires in minutes, so a revoked session stops
 *    working within one access-token lifetime without a database read per
 *    request.
 *
 * Nothing in this file logs a password, a token, or a TOTP secret.
 */

export interface AuthConfig {
  readonly accessTokenTtl: number;
  readonly refreshTokenTtl: number;
  readonly mfaIssuer: string;
  readonly sessionSecret: string;
}

export interface AuthenticatedUser {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string | null;
  readonly mfaEnabled: boolean;
}

export interface WorkspaceMembership {
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly workspaceName: string;
  readonly businessType: string;
  readonly role: WorkspaceRole;
  readonly permissions: ReadonlySet<Permission>;
  readonly enabledModules: readonly string[];
}

export interface SessionTokens {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
  readonly sessionId: string;
}

export type LoginOutcome =
  | {
      readonly kind: 'authenticated';
      readonly tokens: SessionTokens;
      readonly user: AuthenticatedUser;
    }
  /** Password accepted, second factor still required. */
  | {
      readonly kind: 'mfa_required';
      readonly challengeToken: string;
      readonly expiresInSeconds: number;
    };

export interface RequestContext {
  readonly ipAddress: string;
  readonly userAgent: string;
}

/** Login attempts allowed per account and per address before a lockout. */
const LOGIN_LIMIT_PER_ACCOUNT = 8;
const LOGIN_LIMIT_PER_IP = 30;
const LOGIN_WINDOW_SECONDS = 900;

/** How long a half-finished MFA login stays resumable. */
const MFA_CHALLENGE_TTL_SECONDS = 300;

/** Password reset and invitation tokens. Short, because email is not a vault. */
const RESET_TTL_SECONDS = 3600;

export class AuthService {
  private readonly db: Database;
  private readonly redis: RedisClient;
  private readonly config: AuthConfig;

  constructor(db: Database, redis: RedisClient, config: AuthConfig) {
    this.db = db;
    this.redis = redis;
    this.config = config;
  }

  /* ----------------------------------------------------------------- login */

  /**
   * Verify credentials and either issue a session or demand a second factor.
   *
   * Every failure path returns the same error and takes roughly the same time.
   * The account throttle is keyed on the *submitted* address rather than on a
   * resolved user id, so an attacker cannot probe which addresses exist by
   * watching which ones start rate-limiting.
   */
  async login(email: string, password: string, context: RequestContext): Promise<LoginOutcome> {
    const normalised = email.trim().toLowerCase();

    const [byAccount, byIp] = await Promise.all([
      consumeRateLimit(
        this.redis,
        `rl:login:account:${hashToken(normalised)}`,
        LOGIN_LIMIT_PER_ACCOUNT,
        LOGIN_WINDOW_SECONDS,
      ),
      consumeRateLimit(
        this.redis,
        `rl:login:ip:${context.ipAddress}`,
        LOGIN_LIMIT_PER_IP,
        LOGIN_WINDOW_SECONDS,
      ),
    ]);

    if (!byAccount.allowed || !byIp.allowed) {
      await this.audit(null, null, 'auth.login_throttled', context, { email: normalised });
      throw new ApiError(429, 'too_many_requests', 'Too many sign-in attempts. Try again later.', {
        retryAfterSeconds: Math.max(byAccount.resetSeconds, byIp.resetSeconds),
      });
    }

    const user = await withoutTenantScope(this.db, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.users)
        .where(
          and(sql`lower(${schema.users.email}) = ${normalised}`, isNull(schema.users.deletedAt)),
        )
        .limit(1);
      return row;
    });

    if (!user || !user.passwordHash) {
      // Spend the time a real verification would have taken.
      await burnPasswordTime(password);
      await this.audit(null, null, 'auth.login_failed', context, {
        email: normalised,
        reason: 'unknown_account',
      });
      throw ApiError.invalidCredentials();
    }

    if (user.status === 'suspended' || user.status === 'deleted') {
      await burnPasswordTime(password);
      await this.audit(null, user.id, 'auth.login_failed', context, { reason: 'account_disabled' });
      throw ApiError.invalidCredentials();
    }

    const passwordOk = await verifyPassword(user.passwordHash, password);
    if (!passwordOk) {
      await withoutTenantScope(this.db, (tx) =>
        tx
          .update(schema.users)
          .set({ failedLoginCount: sql`${schema.users.failedLoginCount} + 1` })
          .where(eq(schema.users.id, user.id)),
      );
      await this.audit(null, user.id, 'auth.login_failed', context, { reason: 'bad_password' });
      throw ApiError.invalidCredentials();
    }

    if (user.mfaSecret && user.mfaEnabledAt) {
      // The password is proven; hold that fact server-side under a one-shot
      // token rather than asking the client to resend the password with the
      // code. A challenge token is worthless without the second factor.
      const challengeToken = mintToken();
      await this.redis.set(
        `mfa:challenge:${hashToken(challengeToken)}`,
        user.id,
        'EX',
        MFA_CHALLENGE_TTL_SECONDS,
      );
      return {
        kind: 'mfa_required',
        challengeToken,
        expiresInSeconds: MFA_CHALLENGE_TTL_SECONDS,
      };
    }

    return this.completeLogin(user.id, normalised, context);
  }

  /** Second step of an MFA login: exchange the challenge plus a code. */
  async verifyMfaChallenge(
    challengeToken: string,
    code: string,
    context: RequestContext,
  ): Promise<LoginOutcome> {
    const challengeKey = `mfa:challenge:${hashToken(challengeToken)}`;
    const userId = await this.redis.get(challengeKey);
    if (!userId) throw ApiError.invalidCredentials();

    const attempts = await consumeRateLimit(this.redis, `rl:mfa:${userId}`, 6, 900);
    if (!attempts.allowed) {
      await this.redis.del(challengeKey);
      throw new ApiError(429, 'too_many_requests', 'Too many codes tried. Sign in again.');
    }

    const user = await withoutTenantScope(this.db, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      return row;
    });
    if (!user?.mfaSecret) throw ApiError.invalidCredentials();

    const verdict = verifyTotp(user.mfaSecret, code);
    if (!verdict.valid) {
      const usedRecovery = await this.consumeRecoveryCode(user.id, code);
      if (!usedRecovery) {
        await this.audit(null, user.id, 'auth.mfa_failed', context, {});
        throw ApiError.invalidCredentials();
      }
    } else {
      /*
       * A TOTP code is valid for its whole 30-second step plus the drift
       * window, so verifying it is not enough — the step has to be burned or
       * the same code works again for up to 90 seconds. Claiming it is what
       * makes a shoulder-surfed code single-use.
       */
      const fresh = await claimOnce(this.redis, `mfa:used:${user.id}:${verdict.step}`, 120);
      if (!fresh) {
        await this.audit(null, user.id, 'auth.mfa_replay', context, {});
        throw ApiError.invalidCredentials();
      }
    }

    await this.redis.del(challengeKey);
    await resetRateLimit(this.redis, `rl:mfa:${userId}`);
    return this.completeLogin(user.id, user.email, context);
  }

  private async completeLogin(
    userId: string,
    email: string,
    context: RequestContext,
  ): Promise<Extract<LoginOutcome, { kind: 'authenticated' }>> {
    const tokens = await this.createSession(userId, context);

    await withoutTenantScope(this.db, (tx) =>
      tx
        .update(schema.users)
        .set({ lastLoginAt: new Date(), failedLoginCount: 0 })
        .where(eq(schema.users.id, userId)),
    );

    await resetRateLimit(this.redis, `rl:login:account:${hashToken(email.toLowerCase())}`);
    await this.audit(null, userId, 'auth.login_succeeded', context, {});

    const user = await this.getUser(userId);
    return { kind: 'authenticated', tokens, user };
  }

  /* --------------------------------------------------------------- sessions */

  private async createSession(
    userId: string,
    context: RequestContext,
    replaces?: string,
  ): Promise<SessionTokens> {
    const refreshToken = mintToken();
    const accessToken = mintToken();
    const now = Date.now();
    const refreshExpiresAt = new Date(now + this.config.refreshTokenTtl * 1000);
    const accessExpiresAt = new Date(now + this.config.accessTokenTtl * 1000);

    const sessionId = await withoutTenantScope(this.db, async (tx) => {
      const [row] = await tx
        .insert(schema.sessions)
        .values({
          userId,
          tokenHash: hashToken(refreshToken),
          userAgent: context.userAgent.slice(0, 1000),
          ipAddress: context.ipAddress.slice(0, 45),
          expiresAt: refreshExpiresAt,
        })
        .returning({ id: schema.sessions.id });

      if (replaces) {
        await tx
          .update(schema.sessions)
          .set({ replacedBySessionId: row!.id, revokedAt: new Date() })
          .where(eq(schema.sessions.id, replaces));
      }

      return row!.id;
    });

    /*
     * The access token lives only in Redis. It is derived from a session but
     * is not a row: at one refresh per fifteen minutes per user, persisting
     * them would be a write-heavy table whose entire content is worthless
     * fifteen minutes later.
     */
    await this.redis.set(
      `access:${hashToken(accessToken)}`,
      JSON.stringify({ userId, sessionId }),
      'EX',
      this.config.accessTokenTtl,
    );

    return {
      accessToken,
      accessTokenExpiresAt: accessExpiresAt,
      refreshToken,
      refreshTokenExpiresAt: refreshExpiresAt,
      sessionId,
    };
  }

  /**
   * Rotate a refresh token — atomically.
   *
   * The whole check-and-rotate runs in **one transaction with the session row
   * locked** (`SELECT … FOR UPDATE`). Two requests presenting the same token
   * serialise on that lock: the first rotates; the second, re-reading the row
   * after the first commits, finds it already replaced. Without the lock both
   * would read "not yet replaced" and both would mint a session — a forked
   * family, which is indistinguishable from a stolen token being used in
   * parallel. A row lock works across any number of API instances, which an
   * in-memory mutex would not.
   *
   * The reuse case is deliberately strict. A replaced token being presented
   * means either a client raced itself or a token was stolen and both parties
   * are now using it — indistinguishable from here, and only one of them is
   * safe to ignore. A "grace window" for the race case would hand an attacker
   * who wins the rotation race a session that survives the victim's replay,
   * which is precisely the attack reuse detection exists to end. So any reuse
   * revokes the entire family, in the same transaction that detected it. The
   * dashboard avoids racing itself by single-flighting its refreshes.
   */
  async refresh(refreshToken: string, context: RequestContext): Promise<SessionTokens> {
    const tokenHash = hashToken(refreshToken);
    const newRefreshToken = mintToken();
    const now = new Date();
    const refreshExpiresAt = new Date(now.getTime() + this.config.refreshTokenTtl * 1000);

    const rotated = await withoutTenantScope(this.db, async (tx) => {
      const [session] = await tx
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.tokenHash, tokenHash))
        .for('update')
        .limit(1);

      if (!session) throw ApiError.unauthorized();

      if (session.replacedBySessionId !== null) {
        await this.revokeSessionFamilyTx(tx, session.id);
        return { reuse: true as const, userId: session.userId, sessionId: session.id };
      }

      if (session.revokedAt !== null || session.expiresAt.getTime() <= Date.now()) {
        throw ApiError.unauthorized();
      }

      const [created] = await tx
        .insert(schema.sessions)
        .values({
          userId: session.userId,
          tokenHash: hashToken(newRefreshToken),
          userAgent: context.userAgent.slice(0, 1000),
          ipAddress: context.ipAddress.slice(0, 45),
          expiresAt: refreshExpiresAt,
          lastSeenAt: now,
        })
        .returning({ id: schema.sessions.id });

      await tx
        .update(schema.sessions)
        .set({ replacedBySessionId: created!.id, revokedAt: now })
        .where(eq(schema.sessions.id, session.id));

      return { reuse: false as const, userId: session.userId, sessionId: created!.id };
    });

    if (rotated.reuse) {
      await this.audit(null, rotated.userId, 'auth.refresh_reuse_detected', context, {
        sessionId: rotated.sessionId,
      });
      throw new ApiError(
        401,
        'session_revoked',
        'This session has been ended for security reasons. Please sign in again.',
      );
    }

    // The access token is minted only after the rotation has committed, so a
    // rolled-back rotation cannot leave a live credential in the cache.
    const accessToken = mintToken();
    await this.redis.set(
      `access:${hashToken(accessToken)}`,
      JSON.stringify({ userId: rotated.userId, sessionId: rotated.sessionId }),
      'EX',
      this.config.accessTokenTtl,
    );

    return {
      accessToken,
      accessTokenExpiresAt: new Date(Date.now() + this.config.accessTokenTtl * 1000),
      refreshToken: newRefreshToken,
      refreshTokenExpiresAt: refreshExpiresAt,
      sessionId: rotated.sessionId,
    };
  }

  /**
   * Revoke a session and everything it was rotated into or out of.
   *
   * Walking forward alone would miss the case where the *older* token is the
   * stolen one, so the chain is walked in both directions from the presented
   * session.
   */
  private async revokeSessionFamily(sessionId: string): Promise<void> {
    await withoutTenantScope(this.db, (tx) => this.revokeSessionFamilyTx(tx, sessionId));
  }

  /**
   * Transaction-scoped variant, so `refresh` can revoke inside the same
   * transaction that detected the reuse — a crash between detection and
   * revocation must not leave the family alive.
   */
  private async revokeSessionFamilyTx(tx: Database, sessionId: string): Promise<void> {
    await tx.execute(sql`
      with recursive family as (
        select id, replaced_by_session_id
        from sessions
        where id = ${sessionId}::uuid

        union

        select s.id, s.replaced_by_session_id
        from sessions s
        join family f
          on s.id = f.replaced_by_session_id
          or s.replaced_by_session_id = f.id
      )
      update sessions
      set revoked_at = now()
      where id in (select id from family)
        and revoked_at is null
    `);
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = hashToken(refreshToken);
    await withoutTenantScope(this.db, (tx) =>
      tx
        .update(schema.sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(schema.sessions.tokenHash, tokenHash), isNull(schema.sessions.revokedAt))),
    );
  }

  /**
   * End every session for a user.
   *
   * The access tokens in Redis are not enumerable by user, so they are not
   * deleted here; they expire within one access-token lifetime, and
   * `resolveAccessToken` re-checks that the session behind the token is still
   * live. Fifteen minutes of stale-token tolerance would be too long, which is
   * why that check exists rather than being assumed unnecessary.
   */
  async logoutAll(userId: string): Promise<number> {
    return withoutTenantScope(this.db, async (tx) => {
      const revoked = await tx
        .update(schema.sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)))
        .returning({ id: schema.sessions.id });
      return revoked.length;
    });
  }

  /**
   * The user's live sessions, for the "where am I signed in" screen.
   *
   * Rows are the user's own and only the user's own — the user id comes from
   * the authenticated request, never from a parameter a client could vary.
   */
  async listSessions(
    userId: string,
    currentSessionId: string,
  ): Promise<
    readonly {
      id: string;
      userAgent: string;
      ipAddress: string;
      createdAt: Date;
      lastSeenAt: Date | null;
      expiresAt: Date;
      current: boolean;
    }[]
  > {
    return withoutTenantScope(this.db, async (tx) => {
      const rows = await tx
        .select({
          id: schema.sessions.id,
          userAgent: schema.sessions.userAgent,
          ipAddress: schema.sessions.ipAddress,
          createdAt: schema.sessions.createdAt,
          lastSeenAt: schema.sessions.lastSeenAt,
          expiresAt: schema.sessions.expiresAt,
        })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.userId, userId),
            isNull(schema.sessions.revokedAt),
            sql`${schema.sessions.expiresAt} > now()`,
          ),
        )
        .orderBy(sql`${schema.sessions.lastSeenAt} desc nulls last`);

      return rows.map((row) => ({
        ...row,
        userAgent: row.userAgent ?? '',
        ipAddress: row.ipAddress ?? '',
        current: row.id === currentSessionId,
      }));
    });
  }

  /**
   * Revoke one of the user's own sessions.
   *
   * The WHERE carries both ids: a session id belonging to someone else
   * matches zero rows, and the caller learns only "not found" — not whether
   * the id exists.
   */
  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    return withoutTenantScope(this.db, async (tx) => {
      const revoked = await tx
        .update(schema.sessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.sessions.id, sessionId),
            eq(schema.sessions.userId, userId),
            isNull(schema.sessions.revokedAt),
          ),
        )
        .returning({ id: schema.sessions.id });
      return revoked.length > 0;
    });
  }

  /**
   * Resolve an access token to a user.
   *
   * Two lookups, deliberately: Redis says which session the token belongs to,
   * and the database says whether that session is still alive. Skipping the
   * second would make "log out all devices" take up to a full access-token
   * lifetime to bite.
   */
  async resolveAccessToken(
    accessToken: string,
  ): Promise<{ userId: string; sessionId: string } | null> {
    const raw = await this.redis.get(`access:${hashToken(accessToken)}`);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { userId: string; sessionId: string };

    const alive = await withoutTenantScope(this.db, async (tx) => {
      const [row] = await tx
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.id, parsed.sessionId),
            isNull(schema.sessions.revokedAt),
            sql`${schema.sessions.expiresAt} > now()`,
          ),
        )
        .limit(1);
      return Boolean(row);
    });

    if (!alive) {
      await this.redis.del(`access:${hashToken(accessToken)}`);
      return null;
    }

    return parsed;
  }

  /* ------------------------------------------------------------ memberships */

  async getUser(userId: string): Promise<AuthenticatedUser> {
    const user = await withoutTenantScope(this.db, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      return row;
    });
    if (!user) throw ApiError.unauthorized();

    return {
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      mfaEnabled: Boolean(user.mfaEnabledAt),
    };
  }

  /**
   * The user's membership of one workspace, or null when they have none.
   *
   * Returning null rather than throwing lets the caller decide between 401,
   * 403 and 404 — and for a cross-workspace request the answer is 404, because
   * a 403 confirms that the workspace exists.
   */
  async getMembership(userId: string, workspaceId: string): Promise<WorkspaceMembership | null> {
    return withoutTenantScope(this.db, async (tx) => {
      const [row] = await tx
        .select({
          role: schema.workspaceMembers.role,
          extraPermissions: schema.workspaceMembers.extraPermissions,
          workspaceId: schema.workspaces.id,
          workspaceSlug: schema.workspaces.slug,
          workspaceName: schema.workspaces.name,
          businessType: schema.workspaces.businessType,
          enabledModules: schema.workspaces.enabledModules,
          workspaceStatus: schema.workspaces.status,
        })
        .from(schema.workspaceMembers)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
        .where(
          and(
            eq(schema.workspaceMembers.userId, userId),
            eq(schema.workspaceMembers.workspaceId, workspaceId),
            isNull(schema.workspaces.deletedAt),
          ),
        )
        .limit(1);

      if (!row || row.workspaceStatus !== 'active') return null;

      const role = row.role as WorkspaceRole;
      return {
        workspaceId: row.workspaceId,
        workspaceSlug: row.workspaceSlug,
        workspaceName: row.workspaceName,
        businessType: row.businessType,
        role,
        permissions: effectivePermissions(role, row.extraPermissions as string[]),
        enabledModules: row.enabledModules as string[],
      };
    });
  }

  async listMemberships(userId: string): Promise<readonly WorkspaceMembership[]> {
    return withoutTenantScope(this.db, async (tx) => {
      const rows = await tx
        .select({
          role: schema.workspaceMembers.role,
          extraPermissions: schema.workspaceMembers.extraPermissions,
          workspaceId: schema.workspaces.id,
          workspaceSlug: schema.workspaces.slug,
          workspaceName: schema.workspaces.name,
          businessType: schema.workspaces.businessType,
          enabledModules: schema.workspaces.enabledModules,
        })
        .from(schema.workspaceMembers)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
        .where(
          and(
            eq(schema.workspaceMembers.userId, userId),
            eq(schema.workspaces.status, 'active'),
            isNull(schema.workspaces.deletedAt),
          ),
        );

      return rows.map((row) => {
        const role = row.role as WorkspaceRole;
        return {
          workspaceId: row.workspaceId,
          workspaceSlug: row.workspaceSlug,
          workspaceName: row.workspaceName,
          businessType: row.businessType,
          role,
          permissions: effectivePermissions(role, row.extraPermissions as string[]),
          enabledModules: row.enabledModules as string[],
        };
      });
    });
  }

  /* ----------------------------------------------------------------- MFA */

  /** Begin enrolment. The secret is not active until a code confirms it. */
  async beginMfaEnrolment(userId: string): Promise<{ secret: string; uri: string }> {
    const user = await this.getUser(userId);
    const secret = generateTotpSecret();

    await this.redis.set(`mfa:enrol:${userId}`, secret, 'EX', 600);

    return { secret, uri: totpUri(secret, user.email, this.config.mfaIssuer) };
  }

  /**
   * Confirm enrolment with a live code.
   *
   * Requiring a code before the secret is stored is what stops a user locking
   * themselves out by scanning a QR code into an app they then delete.
   */
  async confirmMfaEnrolment(
    userId: string,
    code: string,
    context: RequestContext,
  ): Promise<{ recoveryCodes: string[] }> {
    const secret = await this.redis.get(`mfa:enrol:${userId}`);
    if (!secret) throw ApiError.badRequest('Enrolment expired. Start again.');

    if (!verifyTotp(secret, code).valid) {
      throw ApiError.badRequest('That code is not valid. Check your authenticator app.');
    }

    const recoveryCodes = generateRecoveryCodes();

    await withoutTenantScope(this.db, (tx) =>
      tx
        .update(schema.users)
        .set({
          mfaSecret: secret,
          mfaEnabledAt: new Date(),
          // Hashed, like every other credential, and in the database rather
          // than the cache — a Redis flush must not lock a user out.
          mfaRecoveryCodeHashes: recoveryCodes.map((entry) => hashToken(entry)),
        })
        .where(eq(schema.users.id, userId)),
    );

    await this.redis.del(`mfa:enrol:${userId}`);

    await this.audit(null, userId, 'auth.mfa_enabled', context, {});
    return { recoveryCodes };
  }

  async disableMfa(userId: string, password: string, context: RequestContext): Promise<void> {
    const user = await withoutTenantScope(this.db, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      return row;
    });
    if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
      throw ApiError.invalidCredentials();
    }

    await withoutTenantScope(this.db, (tx) =>
      tx
        .update(schema.users)
        .set({ mfaSecret: null, mfaEnabledAt: null, mfaRecoveryCodeHashes: [] })
        .where(eq(schema.users.id, userId)),
    );
    await this.audit(null, userId, 'auth.mfa_disabled', context, {});
  }

  /**
   * Spend a recovery code.
   *
   * The read-modify-write runs inside one transaction with the row locked, so
   * two simultaneous requests carrying the same code cannot both succeed —
   * "single-use" has to survive a race to mean anything.
   */
  private async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const target = hashToken(code.trim());

    return withoutTenantScope(this.db, async (tx) => {
      const [row] = await tx
        .select({ hashes: schema.users.mfaRecoveryCodeHashes })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .for('update')
        .limit(1);

      const hashes = (row?.hashes as string[] | undefined) ?? [];
      const remaining = hashes.filter((entry) => entry !== target);
      if (remaining.length === hashes.length) return false;

      await tx
        .update(schema.users)
        .set({ mfaRecoveryCodeHashes: remaining })
        .where(eq(schema.users.id, userId));
      return true;
    });
  }

  /* -------------------------------------------------------- password reset */

  /**
   * Start a password reset.
   *
   * Returns the token to the caller rather than sending the email itself, so
   * the delivery decision (and the "always report success" behaviour that
   * stops this endpoint enumerating accounts) lives in the route.
   */
  async createPasswordResetToken(email: string): Promise<{ token: string; userId: string } | null> {
    const normalised = email.trim().toLowerCase();

    const user = await withoutTenantScope(this.db, async (tx) => {
      const [row] = await tx
        .select({ id: schema.users.id, status: schema.users.status })
        .from(schema.users)
        .where(
          and(sql`lower(${schema.users.email}) = ${normalised}`, isNull(schema.users.deletedAt)),
        )
        .limit(1);
      return row;
    });

    if (!user || user.status === 'suspended' || user.status === 'deleted') return null;

    const token = mintToken();
    await this.redis.set(`pwreset:${hashToken(token)}`, user.id, 'EX', RESET_TTL_SECONDS);
    return { token, userId: user.id };
  }

  /**
   * Complete a reset.
   *
   * Every existing session is revoked, because the most likely reason someone
   * is resetting a password is that they think somebody else has it.
   */
  async resetPassword(token: string, newPassword: string, context: RequestContext): Promise<void> {
    const key = `pwreset:${hashToken(token)}`;
    const userId = await this.redis.get(key);
    if (!userId) throw ApiError.badRequest('That reset link is invalid or has expired.');

    const passwordHash = await hashPassword(newPassword);
    await withoutTenantScope(this.db, (tx) =>
      tx
        .update(schema.users)
        .set({ passwordHash, failedLoginCount: 0, status: 'active' })
        .where(eq(schema.users.id, userId)),
    );

    await this.redis.del(key);
    await this.logoutAll(userId);
    await this.audit(null, userId, 'auth.password_reset', context, {});
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    context: RequestContext,
  ): Promise<void> {
    const user = await withoutTenantScope(this.db, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      return row;
    });
    if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, currentPassword))) {
      throw ApiError.invalidCredentials();
    }

    const passwordHash = await hashPassword(newPassword);
    await withoutTenantScope(this.db, (tx) =>
      tx.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, userId)),
    );
    await this.audit(null, userId, 'auth.password_changed', context, {});
  }

  /* ----------------------------------------------------------- invitations */

  async createInvitation(
    workspaceId: string,
    email: string,
    role: WorkspaceRole,
    invitedBy: string,
  ): Promise<{ token: string; invitationId: string }> {
    const token = mintToken();

    const invitationId = await withoutTenantScope(this.db, async (tx) => {
      const [row] = await tx
        .insert(schema.workspaceInvitations)
        .values({
          workspaceId,
          email: email.trim().toLowerCase(),
          role,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
          invitedBy,
        })
        .returning({ id: schema.workspaceInvitations.id });
      return row!.id;
    });

    return { token, invitationId };
  }

  /**
   * Accept an invitation, creating the user account if there is not one yet.
   *
   * Done in one transaction so a crash between "create the user" and "add the
   * membership" cannot leave an account that exists but belongs to nothing.
   */
  async acceptInvitation(
    token: string,
    fullName: string,
    password: string,
    context: RequestContext,
  ): Promise<SessionTokens> {
    const tokenHash = hashToken(token);
    const passwordHash = await hashPassword(password);

    const userId = await withoutTenantScope(this.db, async (tx) => {
      const [invitation] = await tx
        .select()
        .from(schema.workspaceInvitations)
        .where(eq(schema.workspaceInvitations.tokenHash, tokenHash))
        .limit(1);

      if (!invitation || invitation.acceptedAt || invitation.expiresAt.getTime() <= Date.now()) {
        throw ApiError.badRequest('That invitation is invalid or has expired.');
      }

      const [existing] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(sql`lower(${schema.users.email}) = ${invitation.email}`)
        .limit(1);

      let id = existing?.id;
      if (id === undefined) {
        const [created] = await tx
          .insert(schema.users)
          .values({
            email: invitation.email,
            passwordHash,
            fullName: fullName.slice(0, 200),
            status: 'active',
            emailVerifiedAt: new Date(),
          })
          .returning({ id: schema.users.id });
        id = created!.id;
      }

      await tx
        .insert(schema.workspaceMembers)
        .values({
          workspaceId: invitation.workspaceId,
          userId: id,
          role: invitation.role,
          invitedBy: invitation.invitedBy,
          joinedAt: new Date(),
        })
        .onConflictDoNothing();

      await tx
        .update(schema.workspaceInvitations)
        .set({ acceptedAt: new Date() })
        .where(eq(schema.workspaceInvitations.id, invitation.id));

      return id;
    });

    await this.audit(null, userId, 'auth.invitation_accepted', context, {});
    return this.createSession(userId, context);
  }

  /* --------------------------------------------------------------- audit */

  /**
   * Append an audit row.
   *
   * Failures are swallowed on purpose: an audit write that fails must not turn
   * a successful login into a 500. It is logged by the caller's request logger
   * instead, and the gap is visible in the trail.
   */
  async audit(
    workspaceId: string | null,
    actorUserId: string | null,
    action: string,
    context: RequestContext,
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      await withoutTenantScope(this.db, (tx) =>
        tx.insert(schema.auditLog).values({
          workspaceId,
          actorUserId,
          action,
          ipAddress: context.ipAddress.slice(0, 45),
          userAgent: context.userAgent.slice(0, 1000),
          detail,
        }),
      );
    } catch {
      // Deliberately ignored — see the note above.
    }
  }

  /** Exposed for the test suite's clock-independent assertions. */
  static totpFor(secret: string): string {
    return currentTotp(secret);
  }
}
