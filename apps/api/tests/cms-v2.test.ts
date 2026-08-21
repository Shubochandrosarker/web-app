import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  authHeaders,
  clearRateLimits,
  createHarness,
  createMember,
  login,
  seedContent,
  type Harness,
} from './helpers.ts';

/**
 * The CMS v2 surface: draft preview that cannot leak, revision restore that
 * is itself undoable, and the reference lists the section editor's pickers
 * read.
 */

let harness: Harness;

before(async () => {
  harness = await createHarness();
});

after(async () => {
  await harness?.close();
});

describe('draft preview', () => {
  it('keeps a draft invisible to the public API, and serves it to a token holder', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'manager');
    const tokens = await login(harness, member.email);
    const headers = authHeaders(harness, tokens.accessToken);

    const contentId = await seedContent(harness, {
      path: '/drafts/preview-me',
      slug: 'preview-me',
      title: 'A draft in progress',
      status: 'draft',
      publishedAt: null,
      sections: [
        {
          id: crypto.randomUUID(),
          type: 'hero',
          hidden: false,
          props: { heading: 'Draft heading', variant: 'landing', links: [] },
        },
      ],
    });

    // The public API has no way to express a request for this draft.
    const publicAttempt = await harness.app.inject({
      method: 'GET',
      url: `/v1/content/by-path?workspace=${harness.workspaceSlug}&path=/drafts/preview-me&locale=en`,
    });
    assert.equal(publicAttempt.statusCode, 404, 'a draft is not public');

    // An editor mints a token; the token — nothing else — unlocks the draft.
    const minted = await harness.app.inject({
      method: 'POST',
      url: `/v1/cms/content/${contentId}/preview-token`,
      headers,
    });
    assert.equal(minted.statusCode, 200, minted.body);
    const { token } = minted.json() as { token: string };
    assert.ok(token);

    const preview = await harness.app.inject({
      method: 'GET',
      url: `/v1/content/preview?token=${encodeURIComponent(token)}`,
    });
    assert.equal(preview.statusCode, 200);
    const entry = preview.json() as { title: string; status: string };
    assert.equal(entry.title, 'A draft in progress');
    assert.equal(entry.status, 'draft');

    // A guessed token opens nothing.
    const guessed = await harness.app.inject({
      method: 'GET',
      url: '/v1/content/preview?token=not-a-real-preview-token',
    });
    assert.equal(guessed.statusCode, 404);
  });

  it('requires content.read to mint a preview token', async () => {
    await clearRateLimits(harness);
    const contentId = await seedContent(harness, {
      path: '/drafts/no-minting',
      slug: 'no-minting',
      title: 'Another draft',
      status: 'draft',
      publishedAt: null,
    });

    const anonymous = await harness.app.inject({
      method: 'POST',
      url: `/v1/cms/content/${contentId}/preview-token`,
      headers: { 'x-bos-workspace': harness.workspaceSlug },
    });
    assert.equal(anonymous.statusCode, 401);
  });
});

describe('revision restore', () => {
  it('restores an earlier revision and keeps the overwritten state as a new one', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'manager');
    const tokens = await login(harness, member.email);
    const headers = authHeaders(harness, tokens.accessToken);

    const contentId = await seedContent(harness, {
      path: '/drafts/history',
      slug: 'history',
      title: 'First title',
      status: 'draft',
      publishedAt: null,
    });

    // Two saves → two revisions snapshotting the pre-save state.
    for (const title of ['Second title', 'Third title']) {
      const saved = await harness.app.inject({
        method: 'PATCH',
        url: `/v1/cms/content/${contentId}`,
        headers,
        payload: { title },
      });
      assert.equal(saved.statusCode, 200, saved.body);
    }

    const listed = await harness.app.inject({
      method: 'GET',
      url: `/v1/cms/content/${contentId}/revisions`,
      headers,
    });
    const revisions = (listed.json() as { items: { revision: number; title: string }[] }).items;
    assert.equal(revisions.length, 2);

    // Revision 1 holds the original title.
    const detail = await harness.app.inject({
      method: 'GET',
      url: `/v1/cms/content/${contentId}/revisions/1`,
      headers,
    });
    assert.equal((detail.json() as { title: string }).title, 'First title');

    const restored = await harness.app.inject({
      method: 'POST',
      url: `/v1/cms/content/${contentId}/revisions/1/restore`,
      headers,
      payload: {},
    });
    assert.equal(restored.statusCode, 200, restored.body);

    const current = await harness.app.inject({
      method: 'GET',
      url: `/v1/cms/content/${contentId}`,
      headers,
    });
    assert.equal((current.json() as { title: string }).title, 'First title');

    // The restore snapshotted "Third title" first — a restore is undoable.
    const afterRestore = await harness.app.inject({
      method: 'GET',
      url: `/v1/cms/content/${contentId}/revisions`,
      headers,
    });
    const titles = (afterRestore.json() as { items: { title: string }[] }).items.map(
      (item) => item.title,
    );
    assert.ok(titles.includes('Third title'), 'the pre-restore state became a revision');
  });
});

describe('reference lists', () => {
  it('serves picker choices to content.read and refuses everyone else', async () => {
    await clearRateLimits(harness);
    const viewer = await createMember(harness, 'viewer');
    const tokens = await login(harness, viewer.email);

    for (const path of [
      '/v1/cms/services',
      '/v1/cms/forms',
      '/v1/cms/locations',
      '/v1/cms/people',
    ]) {
      const allowed = await harness.app.inject({
        method: 'GET',
        url: path,
        headers: authHeaders(harness, tokens.accessToken),
      });
      assert.equal(allowed.statusCode, 200, `${path} for a viewer`);
      assert.ok(Array.isArray((allowed.json() as { items: unknown[] }).items));

      const anonymous = await harness.app.inject({ method: 'GET', url: path });
      assert.equal(anonymous.statusCode, 401, `${path} anonymously`);
    }
  });
});
