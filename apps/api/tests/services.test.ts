import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { authHeaders, createHarness, createMember, login, type Harness } from './helpers.ts';

let harness: Harness;
let managerHeaders: Record<string, string>;
let viewerHeaders: Record<string, string>;

before(async () => {
  harness = await createHarness();
  const manager = await createMember(harness, 'manager');
  const viewer = await createMember(harness, 'viewer');
  managerHeaders = authHeaders(harness, (await login(harness, manager.email)).accessToken);
  viewerHeaders = authHeaders(harness, (await login(harness, viewer.email)).accessToken);
});

after(async () => {
  await harness?.close();
});

describe('services catalogue', () => {
  it('enforces permissions and supports the catalogue lifecycle', async () => {
    const denied = await harness.app.inject({
      method: 'POST',
      url: '/v1/services',
      headers: viewerHeaders,
      payload: { name: 'Denied', slug: `denied-${randomUUID().slice(0, 8)}` },
    });
    assert.equal(denied.statusCode, 403, denied.body);

    const slug = `transcript-${randomUUID().slice(0, 8)}`;
    const created = await harness.app.inject({
      method: 'POST',
      url: '/v1/services',
      headers: managerHeaders,
      payload: {
        name: 'Transcript assistance',
        slug,
        summary: 'Help preparing a transcript request.',
        requirements: ['Registration number'],
        priceAmount: 1500,
        priceCurrency: 'BDT',
        bookable: true,
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const createdId = (created.json() as { service: { id: string } }).service.id;

    const listed = await harness.app.inject({
      method: 'GET',
      url: `/v1/services?search=Transcript&limit=10`,
      headers: managerHeaders,
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal((listed.json() as { items: { slug: string }[] }).items[0]?.slug, slug);

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/services/${createdId}`,
      headers: managerHeaders,
      payload: { status: 'published', durationMinutes: 45 },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal((updated.json() as { service: { status: string } }).service.status, 'published');

    const duplicated = await harness.app.inject({
      method: 'POST',
      url: `/v1/services/${createdId}/duplicate`,
      headers: managerHeaders,
      payload: {},
    });
    assert.equal(duplicated.statusCode, 200, duplicated.body);
    assert.equal((duplicated.json() as { service: { status: string } }).service.status, 'draft');

    const archived = await harness.app.inject({
      method: 'POST',
      url: `/v1/services/${createdId}/archive`,
      headers: managerHeaders,
      payload: {},
    });
    assert.equal(archived.statusCode, 200, archived.body);
    assert.equal((archived.json() as { service: { status: string } }).service.status, 'archived');
  });
});
