import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authHeaders, createHarness, createMember, login, type Harness } from './helpers.ts';

/**
 * The settings integrations surface: status without secrets, and honest
 * failures when an integration is not configured.
 */

let harness: Harness;
let adminHeaders: Record<string, string>;
let viewerHeaders: Record<string, string>;

before(async () => {
  harness = await createHarness();
  const admin = await createMember(harness, 'admin');
  const viewer = await createMember(harness, 'viewer');
  adminHeaders = authHeaders(harness, (await login(harness, admin.email)).accessToken);
  viewerHeaders = authHeaders(harness, (await login(harness, viewer.email)).accessToken);
});

after(async () => {
  await harness?.close();
});

describe('settings integrations', () => {
  it('reports status without leaking any credential material', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/settings/integrations',
      headers: viewerHeaders,
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      searchConsole: { configured: boolean; totalRows: number };
      contentProvider: { provider: string };
    };
    assert.equal(typeof body.searchConsole.configured, 'boolean');
    assert.equal(body.contentProvider.provider, 'internal');
    // Whatever else is in the response, no key material belongs there.
    assert.ok(!/PRIVATE KEY|password|secret/i.test(response.body));
  });

  it('refuses a Search Console sync while unconfigured, with instructions', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/settings/search-console/sync',
      headers: adminHeaders,
      payload: {},
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /GSC_CLIENT_EMAIL/);
  });

  it('sync requires settings.write — viewers are refused', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/settings/search-console/sync',
      headers: viewerHeaders,
      payload: {},
    });
    assert.equal(response.statusCode, 403, response.body);
  });

  it('the content-provider check answers for the internal provider without probing', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/settings/content-provider/check',
      headers: viewerHeaders,
      payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as { provider: string; reachable: boolean | null };
    assert.equal(body.provider, 'internal');
    assert.equal(body.reachable, null);
  });
});
