import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
 * The public content API.
 *
 * The claim under test is narrow and load-bearing: **nothing that is not
 * published can be reached without a session.** Drafts, scheduled pages and
 * archived ones are all invisible, and there is no parameter that changes that
 * — which is why the public routes live in a different file from the CMS ones.
 */

let harness: Harness;
let ownerToken: string;

before(async () => {
  harness = await createHarness();
  await clearRateLimits(harness);
  const owner = await createMember(harness, 'owner');
  ownerToken = (await login(harness, owner.email)).accessToken;
});

after(async () => {
  await harness?.close();
});

describe('public content: only published is visible', () => {
  it('serves a published page', async () => {
    await seedContent(harness, { path: '/published', slug: 'published', title: 'Published' });

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/content/by-path?workspace=${harness.workspaceSlug}&path=/published&locale=en`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal((response.json() as { title: string }).title, 'Published');
  });

  it('hides a draft', async () => {
    await seedContent(harness, {
      path: '/secret-draft',
      slug: 'secret-draft',
      title: 'Draft',
      status: 'draft',
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/content/by-path?workspace=${harness.workspaceSlug}&path=/secret-draft&locale=en`,
    });

    assert.equal(response.statusCode, 404);
  });

  it('hides an archived page', async () => {
    await seedContent(harness, {
      path: '/archived',
      slug: 'archived',
      title: 'Archived',
      status: 'archived',
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/content/by-path?workspace=${harness.workspaceSlug}&path=/archived&locale=en`,
    });

    assert.equal(response.statusCode, 404);
  });

  /**
   * A page whose status is `published` but whose `published_at` is in the
   * future is *not* public. Status alone would leak next week's announcement
   * the moment somebody queued it.
   */
  it('hides a page published-dated in the future', async () => {
    await seedContent(harness, {
      path: '/future',
      slug: 'future',
      title: 'Future',
      status: 'published',
      publishedAt: new Date(Date.now() + 86_400_000),
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/content/by-path?workspace=${harness.workspaceSlug}&path=/future&locale=en`,
    });

    assert.equal(response.statusCode, 404);
  });

  it('excludes drafts from the list and from the route index', async () => {
    const list = await harness.app.inject({
      method: 'GET',
      url: `/v1/content?workspace=${harness.workspaceSlug}&limit=100`,
    });
    const titles = (list.json() as { items: { title: string }[] }).items.map((item) => item.title);
    assert.ok(!titles.includes('Draft'));
    assert.ok(!titles.includes('Archived'));
    assert.ok(!titles.includes('Future'));

    const routes = await harness.app.inject({
      method: 'GET',
      url: `/v1/content/routes?workspace=${harness.workspaceSlug}`,
    });
    const paths = (routes.json() as { routes: { path: string }[] }).routes.map((r) => r.path);
    assert.ok(!paths.includes('/secret-draft'));
  });

  it('lets an authenticated editor see the draft the public cannot', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/cms/content?status=draft',
      headers: authHeaders(harness, ownerToken),
    });

    assert.equal(response.statusCode, 200);
    const titles = (response.json() as { items: { title: string }[] }).items.map((i) => i.title);
    assert.ok(titles.includes('Draft'), 'the CMS must still show drafts');
  });
});

describe('cursor pagination', () => {
  /**
   * The bug this replaces: `cursor` was parsed and never applied, so every
   * page after the first returned the first page again. A client paging
   * through fifty pages saw the same twenty-five records fifty times.
   */
  it('walks the whole list exactly once', async () => {
    // Distinct publish times so the sort is deterministic and the assertion is
    // about the cursor rather than about tie-breaking.
    const total = 12;
    for (let index = 0; index < total; index += 1) {
      await seedContent(harness, {
        path: `/paged-${index}`,
        slug: `paged-${index}`,
        title: `Paged ${index}`,
        publishedAt: new Date(Date.UTC(2026, 0, index + 1)),
      });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const url =
        `/v1/content?workspace=${harness.workspaceSlug}&limit=5&type=page` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');

      const response = await harness.app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 200);

      const body = response.json() as { items: { id: string }[]; nextCursor?: string };
      seen.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
      pages += 1;

      assert.ok(pages < 20, 'pagination did not terminate');
    } while (cursor);

    assert.ok(pages > 1, 'expected more than one page');
    // No repeats: a cursor that is parsed but not applied shows up here as
    // duplicate ids long before it shows up as a missing record.
    assert.equal(new Set(seen).size, seen.length, 'a record appeared on two pages');
    assert.ok(seen.length >= total, 'some records were skipped');
  });

  it('rejects a malformed cursor with a 400 rather than a 500', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/content?workspace=${harness.workspaceSlug}&cursor=not-a-real-cursor`,
    });
    assert.equal(response.statusCode, 400);
  });
});

describe('CMS write path', () => {
  it('sanitises HTML before it is stored', async () => {
    const create = await harness.app.inject({
      method: 'POST',
      url: '/v1/cms/content',
      headers: authHeaders(harness, ownerToken),
      payload: {
        type: 'page',
        slug: 'xss-attempt',
        path: '/xss-attempt',
        locale: 'en',
        title: 'XSS attempt',
        document: {
          sections: [
            {
              id: randomUUID(),
              type: 'content',
              hidden: false,
              props: {
                html: '<p onclick="steal()">Hello</p><script>alert(1)</script>',
                layout: 'prose',
              },
            },
          ],
        },
      },
    });

    assert.equal(create.statusCode, 201);
    const { id } = create.json() as { id: string };

    const read = await harness.app.inject({
      method: 'GET',
      url: `/v1/cms/content/${id}`,
      headers: authHeaders(harness, ownerToken),
    });

    const stored = JSON.stringify((read.json() as { document: unknown }).document);
    assert.ok(!stored.includes('onclick'), 'an event handler survived sanitisation');
    assert.ok(!stored.includes('alert(1)'), 'a script survived sanitisation');
    assert.ok(stored.includes('Hello'), 'the content itself was lost');
  });

  it('refuses a section carrying a javascript: link', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/cms/content',
      headers: authHeaders(harness, ownerToken),
      payload: {
        type: 'page',
        slug: 'bad-link',
        path: '/bad-link',
        locale: 'en',
        title: 'Bad link',
        document: {
          sections: [
            {
              id: randomUUID(),
              type: 'cta',
              hidden: false,
              props: {
                heading: 'Click',
                links: [{ label: 'Go', href: 'javascript:alert(1)', primary: true }],
              },
            },
          ],
        },
      },
    });

    // 422 with the offending field named, so an editor can fix it — rather
    // than a silent drop that leaves them wondering where the button went.
    assert.equal(response.statusCode, 422);
    assert.equal((response.json() as { error: { code: string } }).error.code, 'invalid_section');
  });

  it('creates content as a draft even when the caller may publish', async () => {
    const create = await harness.app.inject({
      method: 'POST',
      url: '/v1/cms/content',
      headers: authHeaders(harness, ownerToken),
      payload: {
        type: 'page',
        slug: 'new-page',
        path: '/new-page',
        locale: 'en',
        title: 'New page',
      },
    });
    assert.equal(create.statusCode, 201);

    const publicRead = await harness.app.inject({
      method: 'GET',
      url: `/v1/content/by-path?workspace=${harness.workspaceSlug}&path=/new-page&locale=en`,
    });
    assert.equal(publicRead.statusCode, 404, 'new content must not be public until published');
  });

  it('publishes, and the page becomes public', async () => {
    const create = await harness.app.inject({
      method: 'POST',
      url: '/v1/cms/content',
      headers: authHeaders(harness, ownerToken),
      payload: {
        type: 'page',
        slug: 'to-publish',
        path: '/to-publish',
        locale: 'en',
        title: 'To publish',
      },
    });
    const { id } = create.json() as { id: string };

    const published = await harness.app.inject({
      method: 'POST',
      url: `/v1/cms/content/${id}/status`,
      headers: authHeaders(harness, ownerToken),
      payload: { status: 'published' },
    });
    assert.equal(published.statusCode, 200);

    const publicRead = await harness.app.inject({
      method: 'GET',
      url: `/v1/content/by-path?workspace=${harness.workspaceSlug}&path=/to-publish&locale=en`,
    });
    assert.equal(publicRead.statusCode, 200);
  });

  it('refuses a staff member the publish action', async () => {
    await clearRateLimits(harness);
    const staff = await createMember(harness, 'staff');
    const token = (await login(harness, staff.email)).accessToken;

    const create = await harness.app.inject({
      method: 'POST',
      url: '/v1/cms/content',
      headers: authHeaders(harness, token),
      payload: {
        type: 'page',
        slug: 'staff-draft',
        path: '/staff-draft',
        locale: 'en',
        title: 'Staff draft',
      },
    });
    assert.equal(create.statusCode, 201, 'staff may write');

    const { id } = create.json() as { id: string };
    const publish = await harness.app.inject({
      method: 'POST',
      url: `/v1/cms/content/${id}/status`,
      headers: authHeaders(harness, token),
      payload: { status: 'published' },
    });
    assert.equal(publish.statusCode, 403, 'staff may not publish');
  });

  it('creates a redirect when a published page moves', async () => {
    const create = await harness.app.inject({
      method: 'POST',
      url: '/v1/cms/content',
      headers: authHeaders(harness, ownerToken),
      payload: {
        type: 'page',
        slug: 'old-slug',
        path: '/old-slug',
        locale: 'en',
        title: 'Moving page',
      },
    });
    const { id } = create.json() as { id: string };

    await harness.app.inject({
      method: 'POST',
      url: `/v1/cms/content/${id}/status`,
      headers: authHeaders(harness, ownerToken),
      payload: { status: 'published' },
    });

    await harness.app.inject({
      method: 'PATCH',
      url: `/v1/cms/content/${id}`,
      headers: authHeaders(harness, ownerToken),
      payload: { path: '/new-slug', slug: 'new-slug' },
    });

    const redirects = await harness.app.inject({
      method: 'GET',
      url: `/v1/redirects?workspace=${harness.workspaceSlug}`,
    });

    const rows = (redirects.json() as { redirects: { fromPath: string; toPath: string }[] })
      .redirects;
    assert.ok(
      rows.some((row) => row.fromPath === '/old-slug' && row.toPath === '/new-slug'),
      'moving a published page must leave a redirect behind',
    );
  });

  /**
   * The regression this exists for: `entryInput.partial()` left `document`'s
   * `.default({ sections: [] })` in place, so a PATCH that renamed a page
   * replaced its entire content with nothing. A customer's page emptied by a
   * slug change is about as bad as a CMS bug gets, and nothing else in the
   * suite would have noticed.
   */
  it('leaves the document alone when a patch does not include one', async () => {
    const create = await harness.app.inject({
      method: 'POST',
      url: '/v1/cms/content',
      headers: authHeaders(harness, ownerToken),
      payload: {
        type: 'page',
        slug: 'keeps-content',
        path: '/keeps-content',
        locale: 'en',
        title: 'Keeps content',
        fields: { serviceId: 'abc' },
        document: {
          sections: [
            {
              id: randomUUID(),
              type: 'content',
              hidden: false,
              props: { html: '<p>Please do not delete me.</p>', layout: 'prose' },
            },
          ],
        },
      },
    });
    const { id } = create.json() as { id: string };

    // A rename, and nothing else.
    const renamed = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/cms/content/${id}`,
      headers: authHeaders(harness, ownerToken),
      payload: { slug: 'renamed', path: '/renamed' },
    });
    assert.equal(renamed.statusCode, 200);

    const read = await harness.app.inject({
      method: 'GET',
      url: `/v1/cms/content/${id}`,
      headers: authHeaders(harness, ownerToken),
    });

    const entry = read.json() as {
      document: { sections: unknown[] };
      fields: Record<string, unknown>;
      path: string;
    };

    assert.equal(entry.path, '/renamed');
    assert.equal(entry.document.sections.length, 1, 'the rename emptied the document');
    assert.deepEqual(entry.fields, { serviceId: 'abc' }, 'the rename emptied the fields');
  });

  it('rejects a duplicate path with a message an editor can act on', async () => {
    const payload = {
      type: 'page' as const,
      slug: 'duplicate',
      path: '/duplicate',
      locale: 'en',
      title: 'Duplicate',
    };

    const first = await harness.app.inject({
      method: 'POST',
      url: '/v1/cms/content',
      headers: authHeaders(harness, ownerToken),
      payload,
    });
    assert.equal(first.statusCode, 201);

    const second = await harness.app.inject({
      method: 'POST',
      url: '/v1/cms/content',
      headers: authHeaders(harness, ownerToken),
      payload: { ...payload, slug: 'duplicate-two' },
    });

    assert.equal(second.statusCode, 409);
    const message = (second.json() as { error: { message: string } }).error.message;
    // The raw error names an index, which tells an editor nothing and tells an
    // attacker about the schema.
    assert.ok(!message.includes('_key'), 'the constraint name leaked to the client');
  });
});
