import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  clearRateLimits,
  createHarness,
  createMember,
  login,
  TEST_PASSWORD,
  type Harness,
} from './helpers.ts';

/**
 * The sessions surface behind the "where am I signed in" screen, and the
 * contract the dashboard's silent refresh depends on.
 */

let harness: Harness;

before(async () => {
  harness = await createHarness();
});

after(async () => {
  await harness?.close();
});

describe('session management', () => {
  it('lists the caller’s sessions and marks the current one', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'staff');

    const first = await login(harness, member.email);
    await login(harness, member.email);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/auth/sessions',
      headers: { authorization: `Bearer ${first.accessToken}` },
    });

    assert.equal(response.statusCode, 200);
    const { sessions } = response.json() as {
      sessions: { id: string; current: boolean; userAgent: string }[];
    };
    assert.equal(sessions.length, 2, 'both sign-ins appear');
    assert.equal(sessions.filter((session) => session.current).length, 1);
  });

  it('revokes one of the caller’s own sessions, and only their own', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'staff');
    const other = await createMember(harness, 'staff');

    const mine = await login(harness, member.email);
    const second = await login(harness, member.email);
    const theirs = await login(harness, other.email);

    const listed = await harness.app.inject({
      method: 'GET',
      url: '/v1/auth/sessions',
      headers: { authorization: `Bearer ${mine.accessToken}` },
    });
    const { sessions } = listed.json() as { sessions: { id: string; current: boolean }[] };
    const target = sessions.find((session) => !session.current);
    assert.ok(target, 'there is a second session to revoke');

    const revoke = await harness.app.inject({
      method: 'DELETE',
      url: `/v1/auth/sessions/${target.id}`,
      headers: { authorization: `Bearer ${mine.accessToken}` },
    });
    assert.equal(revoke.statusCode, 204);

    // The revoked session's refresh token is dead.
    const refreshDead = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: second.refreshToken },
    });
    assert.equal(refreshDead.statusCode, 401);

    // Someone else's session id answers 404 — not 403, which would confirm it.
    const theirSessions = await harness.app.inject({
      method: 'GET',
      url: '/v1/auth/sessions',
      headers: { authorization: `Bearer ${theirs.accessToken}` },
    });
    const theirId = (theirSessions.json() as { sessions: { id: string }[] }).sessions[0]?.id;
    assert.ok(theirId);

    const crossRevoke = await harness.app.inject({
      method: 'DELETE',
      url: `/v1/auth/sessions/${theirId}`,
      headers: { authorization: `Bearer ${mine.accessToken}` },
    });
    assert.equal(crossRevoke.statusCode, 404);

    // And it is genuinely still alive.
    const stillAlive = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: theirs.refreshToken },
    });
    assert.equal(stillAlive.statusCode, 200);
  });

  it('supports the dashboard’s silent-refresh round trip: cookie in, rotated cookies out, session stays continuous', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'staff');

    const loginResponse = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: member.email, password: TEST_PASSWORD },
    });
    const refreshCookie = loginResponse.cookies.find((cookie) => cookie.name === 'bos_refresh');
    assert.ok(refreshCookie);

    // What the middleware does when the access cookie has lapsed.
    const refreshed = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { bos_refresh: refreshCookie.value },
      payload: {},
    });
    assert.equal(refreshed.statusCode, 200);

    const newAccess = refreshed.cookies.find((cookie) => cookie.name === 'bos_access');
    const newRefresh = refreshed.cookies.find((cookie) => cookie.name === 'bos_refresh');
    assert.ok(newAccess?.value, 'a fresh access cookie arrives');
    assert.ok(newRefresh?.value, 'a rotated refresh cookie arrives');
    assert.ok((newAccess.maxAge ?? 0) > 0, 'Max-Age travels so the dashboard can mirror it');

    // The fresh access cookie authenticates immediately.
    const me = await harness.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      cookies: { bos_access: newAccess.value },
    });
    assert.equal(me.statusCode, 200);

    // And a failed refresh clears the cookies rather than leaving dead ones.
    const failed = await harness.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { bos_refresh: refreshCookie.value },
      payload: {},
    });
    assert.equal(failed.statusCode, 401);
    const cleared = failed.cookies.find((cookie) => cookie.name === 'bos_refresh');
    assert.ok(cleared, 'the dead refresh cookie is explicitly expired');
    assert.equal(cleared.value, '');
  });
});
