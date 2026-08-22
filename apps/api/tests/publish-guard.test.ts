import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  authHeaders,
  createHarness,
  createMember,
  login,
  seedContent,
  type Harness,
} from './helpers.ts';

/**
 * The owner-placeholder publish gate: a page still carrying an `[OWNER: …]`
 * marker — the scaffold's way of naming a fact only the business can supply —
 * must be refused at publish and at schedule, and publish cleanly once the
 * marker is replaced.
 */

let harness: Harness;
let headers: Record<string, string>;

before(async () => {
  harness = await createHarness();
  const manager = await createMember(harness, 'manager');
  const tokens = await login(harness, manager.email);
  headers = authHeaders(harness, tokens.accessToken);
});

after(async () => {
  await harness?.close();
});

describe('owner-placeholder publish guard', () => {
  it('refuses to publish or schedule a page carrying an [OWNER: …] marker', async () => {
    const id = await seedContent(harness, {
      path: '/guarded',
      slug: 'guarded',
      title: 'Guarded page',
      status: 'draft',
      sections: [
        {
          id: '00000000-0000-4000-8000-000000000101',
          type: 'content',
          hidden: false,
          props: { html: '<p>[OWNER: the real opening hours]</p>', layout: 'prose' },
        },
      ],
    });

    const publish = await harness.app.inject({
      method: 'POST',
      url: `/v1/cms/content/${id}/status`,
      headers,
      payload: { status: 'published' },
    });
    assert.equal(publish.statusCode, 400, publish.body);
    assert.match(publish.body, /\[OWNER:/);

    const schedule = await harness.app.inject({
      method: 'POST',
      url: `/v1/cms/content/${id}/status`,
      headers,
      payload: { status: 'scheduled', publishAt: new Date(Date.now() + 3600_000).toISOString() },
    });
    assert.equal(schedule.statusCode, 400, 'scheduling is publishing on a delay');
  });

  it('publishes cleanly once the marker is replaced with real content', async () => {
    const id = await seedContent(harness, {
      path: '/unguarded',
      slug: 'unguarded',
      title: 'Ready page',
      status: 'draft',
      sections: [
        {
          id: '00000000-0000-4000-8000-000000000102',
          type: 'content',
          hidden: false,
          props: { html: '<p>Open Saturday to Thursday, 9am to 6pm.</p>', layout: 'prose' },
        },
      ],
    });

    const publish = await harness.app.inject({
      method: 'POST',
      url: `/v1/cms/content/${id}/status`,
      headers,
      payload: { status: 'published' },
    });
    assert.equal(publish.statusCode, 200, publish.body);
  });
});
