import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import { schema, withoutTenantScope } from '@bos/database';
import { currentTotp, generateTotpSecret, hashToken } from '../src/lib/crypto.ts';
import {
  authHeaders,
  clearRateLimits,
  createHarness,
  createMember,
  createSecondaryWorkspace,
  login,
  TEST_PASSWORD,
  type Harness,
} from './helpers.ts';

/**
 * Authentication and RBAC.
 *
 * These run against a real database because the properties under test are
 * database properties: a session family revoked by a recursive CTE, a
 * membership row that decides a permission, an audit row written in the same
 * breath as a rejection.
 */

let harness: Harness;

before(async () => {
  harness = await createHarness();
});

after(async () => {
  await harness?.close();
});

describe('login', () => {
  it('issues a session for correct credentials', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'owner');

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: member.email, password: TEST_PASSWORD },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as { accessToken: string; mfaRequired: boolean };
    assert.equal(body.mfaRequired, false);
    assert.ok(body.accessToken.length > 20);

    // The refresh cookie must be HttpOnly and scoped to the refresh path, so
    // it is not attached to ordinary API calls and no script can read it.
    const cookies = response.cookies;
    const refresh = cookies.find((cookie) => cookie.name === 'bos_refresh');
    assert.ok(refresh, 'expected a refresh cookie');
    assert.equal(refresh.httpOnly, true);
    assert.equal(refresh.path, '/v1/auth');
  });

  it('rejects a wrong password with the same error as an unknown account', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'staff');

    const wrongPassword = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: member.email, password: 'not-the-password-at-all' },
    });

    const unknownAccount = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@example.test', password: 'not-the-password-at-all' },
    });

    assert.equal(wrongPassword.statusCode, 401);
    assert.equal(unknownAccount.statusCode, 401);
    // Identical bodies: anything that distinguishes them is an enumeration
    // oracle regardless of how carefully the message is worded.
    assert.deepEqual(
      (wrongPassword.json() as { error: unknown }).error,
      (unknownAccount.json() as { error: unknown }).error,
    );
  });

  it('throttles repeated failures for one account', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'staff');

    let sawThrottle = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: member.email, password: `wrong-${attempt}-attempt` },
      });
      if (response.statusCode === 429) {
        sawThrottle = true;
        break;
      }
    }

    assert.ok(sawThrottle, 'expected the account to be throttled before the twelfth attempt');
    await clearRateLimits(harness);
  });

  it('refuses a suspended account', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'staff');

    await withoutTenantScope(harness.db, (tx) =>
      tx
        .update(schema.users)
        .set({ status: 'suspended' })
        .where(eq(schema.users.id, member.userId)),
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: member.email, password: TEST_PASSWORD },
    });

    assert.equal(response.statusCode, 401);
  });
});

describe('refresh rotation', () => {
  it('rotates the token and invalidates the previous one', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'owner');
    const first = await login(harness, member.email);

    const rotated = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: first.refreshToken },
    });

    assert.equal(rotated.statusCode, 200);
    const second = rotated.json() as { refreshToken: string };
    assert.notEqual(second.refreshToken, first.refreshToken);
  });

  /**
   * The property that matters most in this file.
   *
   * A replayed refresh token is either a race or a theft, and the two are
   * indistinguishable from the server. Revoking the whole family is the only
   * response that is safe in the theft case.
   */
  it('revokes the entire family when a rotated token is replayed', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'owner');
    const first = await login(harness, member.email);

    const rotated = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: first.refreshToken },
    });
    const second = (rotated.json() as { refreshToken: string }).refreshToken;

    const replay = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: first.refreshToken },
    });

    assert.equal(replay.statusCode, 401);
    assert.equal((replay.json() as { error: { code: string } }).error.code, 'session_revoked');

    // The token the legitimate client is holding must be dead too — otherwise
    // the attacker who triggered the replay keeps the working session.
    const afterReplay = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: second },
    });
    assert.equal(afterReplay.statusCode, 401);

    const audits = await withoutTenantScope(harness.db, (tx) =>
      tx
        .select({ action: schema.auditLog.action })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.actorUserId, member.userId)),
    );
    assert.ok(
      audits.some((row) => row.action === 'auth.refresh_reuse_detected'),
      'expected the reuse to be audited',
    );
  });
});

describe('logout', () => {
  it('ends one session', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'owner');
    const tokens = await login(harness, member.email);

    await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      payload: { refreshToken: tokens.refreshToken },
    });

    const refreshed = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: tokens.refreshToken },
    });
    assert.equal(refreshed.statusCode, 401);
  });

  /**
   * "Log out everywhere" must bite immediately, not after the access token
   * expires — which is why `resolveAccessToken` re-checks the session rather
   * than trusting the cache entry alone.
   */
  it('ends every session and invalidates live access tokens at once', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'owner');
    const first = await login(harness, member.email);
    const second = await login(harness, member.email);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/logout-all',
      headers: { authorization: `Bearer ${first.accessToken}` },
    });
    assert.equal(response.statusCode, 200);

    for (const tokens of [first, second]) {
      const me = await harness.app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      });
      assert.equal(me.statusCode, 401, 'an access token must die with its session');
    }
  });
});

describe('MFA', () => {
  it('requires a code once enrolled, and rejects a replayed one', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'owner');
    const secret = generateTotpSecret();

    await withoutTenantScope(harness.db, (tx) =>
      tx
        .update(schema.users)
        .set({ mfaSecret: secret, mfaEnabledAt: new Date() })
        .where(eq(schema.users.id, member.userId)),
    );

    const first = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: member.email, password: TEST_PASSWORD },
    });

    const challenge = first.json() as { mfaRequired: boolean; challengeToken: string };
    assert.equal(challenge.mfaRequired, true);
    assert.ok(challenge.challengeToken);

    const code = currentTotp(secret);
    const verified = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken: challenge.challengeToken, code },
    });
    assert.equal(verified.statusCode, 200);

    // A second login with the *same* code must fail: a TOTP step stays valid
    // for up to ninety seconds, so verifying without burning the step means a
    // shoulder-surfed code works twice.
    const secondLogin = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: member.email, password: TEST_PASSWORD },
    });
    const secondChallenge = (secondLogin.json() as { challengeToken: string }).challengeToken;

    const replay = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken: secondChallenge, code },
    });
    assert.equal(replay.statusCode, 401, 'a TOTP code must be single-use');
  });

  it('accepts a recovery code exactly once', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'owner');
    const secret = generateTotpSecret();
    const recoveryCode = '12345-67890';

    await withoutTenantScope(harness.db, (tx) =>
      tx
        .update(schema.users)
        .set({
          mfaSecret: secret,
          mfaEnabledAt: new Date(),
          mfaRecoveryCodeHashes: [hashToken(recoveryCode)],
        })
        .where(eq(schema.users.id, member.userId)),
    );

    const startLogin = async (): Promise<string> => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: member.email, password: TEST_PASSWORD },
      });
      return (response.json() as { challengeToken: string }).challengeToken;
    };

    const firstUse = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken: await startLogin(), code: recoveryCode },
    });
    assert.equal(firstUse.statusCode, 200);

    const secondUse = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken: await startLogin(), code: recoveryCode },
    });
    assert.equal(secondUse.statusCode, 401, 'a recovery code must be single-use');
  });
});

describe('RBAC', () => {
  it('grants and withholds by role', async () => {
    await clearRateLimits(harness);

    const cases = [
      { role: 'owner', canPublish: true, canInvite: true },
      { role: 'admin', canPublish: true, canInvite: true },
      { role: 'manager', canPublish: true, canInvite: false },
      { role: 'staff', canPublish: false, canInvite: false },
      { role: 'viewer', canPublish: false, canInvite: false },
    ] as const;

    for (const scenario of cases) {
      const member = await createMember(harness, scenario.role);
      const tokens = await login(harness, member.email);
      const headers = authHeaders(harness, tokens.accessToken);

      const invite = await harness.app.inject({
        method: 'POST',
        url: '/v1/workspaces/members/invite',
        headers,
        payload: { email: `invitee-${scenario.role}@example.test`, role: 'staff' },
      });

      assert.equal(
        invite.statusCode !== 403,
        scenario.canInvite,
        `${scenario.role} invite permission`,
      );

      // Every role may at least read content; only some may publish it.
      const read = await harness.app.inject({
        method: 'GET',
        url: '/v1/cms/content',
        headers,
      });
      assert.equal(read.statusCode, 200, `${scenario.role} should be able to read content`);
    }
  });

  it('reports a workspace the caller is not a member of as 404, never 403', async () => {
    await clearRateLimits(harness);

    // A second workspace this member has no membership in.
    const other = await createSecondaryWorkspace(harness);
    try {
      const member = await createMember(harness, 'owner');
      const tokens = await login(harness, member.email);

      const response = await harness.app.inject({
        method: 'GET',
        url: '/v1/cms/content',
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          'x-bos-workspace': other.workspaceSlug,
        },
      });

      // 403 would confirm the workspace exists, which is enough to enumerate
      // tenants one slug at a time.
      assert.equal(response.statusCode, 404);
    } finally {
      await other.drop();
    }
  });

  it('rejects an unauthenticated call to a protected route', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/cms/content',
      headers: { 'x-bos-workspace': harness.workspaceSlug },
    });
    assert.equal(response.statusCode, 401);
  });

  /**
   * `extraPermissions` is additive, and additive without a ceiling means a
   * viewer can be promoted to an owner one grant at a time.
   */
  it('will not let an extra grant lift a role past its ceiling', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'viewer', ['members.manage', 'leads.write']);
    const tokens = await login(harness, member.email);

    const me = await harness.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });

    const body = me.json() as { workspaces: { permissions: string[] }[] };
    const permissions = body.workspaces[0]?.permissions ?? [];

    // `leads.write` is within a viewer's ceiling (it is a staff permission);
    // `members.manage` is an admin one and must be dropped.
    assert.ok(permissions.includes('leads.write'));
    assert.ok(!permissions.includes('members.manage'));
  });
});

describe('password reset', () => {
  it('reports success for an unknown address', async () => {
    await clearRateLimits(harness);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/password/forgot',
      payload: { email: 'definitely-nobody@example.test' },
    });

    // 202 either way. A 404 here is an account-enumeration endpoint.
    assert.equal(response.statusCode, 202);
  });

  it('rejects a password below the minimum length', async () => {
    await clearRateLimits(harness);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/password/reset',
      payload: { token: 'irrelevant', password: 'short' },
    });
    assert.equal(response.statusCode, 400);
  });
});

describe('health and readiness', () => {
  it('reports liveness without touching a dependency', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok' });
  });

  it('reports readiness with per-dependency detail', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/ready' });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { status: string; checks: Record<string, string> };
    assert.equal(body.status, 'ready');
    assert.equal(body.checks.database, 'ok');
    assert.equal(body.checks.redis, 'ok');
  });

  /*
   * Asserting on the outbox depth, not merely that the endpoint answered.
   *
   * The query behind this had a syntax error and threw on every call. The
   * readiness handler caught it and left the key out, so the endpoint returned
   * 200 with database and redis both "ok" — and this suite passed, because it
   * only ever checked those two. A dead-letter queue could have grown without
   * limit and nothing would have said so.
   *
   * The numbers matter more than the keys: "unavailable" is what a broken
   * check now reports, and it has to fail here rather than pass quietly.
   */
  it('reports how deep the outbox is, rather than staying silent about it', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/ready' });
    const body = response.json() as {
      outbox:
        | 'unavailable'
        | { pending: number; dead: number; oldestPendingSeconds: number | null };
    };

    assert.notEqual(body.outbox, 'unavailable', 'the outbox health query failed');
    const outbox = body.outbox as Exclude<typeof body.outbox, 'unavailable'>;
    assert.equal(typeof outbox.pending, 'number');
    assert.equal(typeof outbox.dead, 'number');
    assert.ok(
      outbox.oldestPendingSeconds === null || typeof outbox.oldestPendingSeconds === 'number',
    );
  });

  it('echoes a request id on every response', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/health' });
    assert.ok(response.headers['x-request-id'], 'expected a request id header');
  });
});
