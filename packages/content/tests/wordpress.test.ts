import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WordPressContentProvider } from '../src/providers/wordpress.ts';

/**
 * The adapter against a scripted WordPress REST API: mapping, path
 * resolution by canonical link, sanitisation of rendered HTML, stable ids,
 * and pagination cursors.
 */

const WP_PAGE = {
  id: 42,
  slug: 'attestation',
  type: 'page',
  link: 'https://legacy.example.com/services/attestation/',
  date_gmt: '2024-05-01T10:00:00',
  modified_gmt: '2024-06-01T10:00:00',
  title: { rendered: 'Attestation &amp; Legalisation' },
  excerpt: { rendered: '<p>We handle attestation.</p>' },
  content: {
    rendered:
      '<h2>How it works</h2><p>Bring the documents.</p><script>alert("x")</script><p><a href="javascript:alert(1)">bad link</a></p>',
  },
};

const WP_POST = {
  id: 7,
  slug: 'new-rules',
  type: 'post',
  link: 'https://legacy.example.com/blog/new-rules/',
  modified_gmt: '2024-07-01T09:00:00',
  title: { rendered: 'New rules' },
  excerpt: { rendered: '<p>Rules changed.</p>' },
  content: { rendered: '<p>Details.</p>' },
};

function scriptedFetch(routes: Record<string, unknown[]>): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    const key = url.pathname.split('/wp/v2/')[1] ?? '';
    const slug = url.searchParams.get('slug');
    let items = routes[key] ?? [];
    if (slug) {
      items = items.filter((item) => (item as { slug: string }).slug === slug);
    }
    return new Response(JSON.stringify(items), {
      status: 200,
      headers: { 'x-wp-totalpages': '1', 'content-type': 'application/json' },
    });
  };
}

function provider(routes: Record<string, unknown[]>): WordPressContentProvider {
  return new WordPressContentProvider({
    apiUrl: 'https://legacy.example.com',
    fetchImpl: scriptedFetch(routes),
  });
}

describe('WordPress adapter', () => {
  it('resolves a page by its full path via the canonical link', async () => {
    const wp = provider({ pages: [WP_PAGE], posts: [] });
    const entry = await wp.getByPath('/services/attestation', 'en');
    assert.ok(entry);
    assert.equal(entry.type, 'page');
    assert.equal(entry.path, '/services/attestation');
    assert.equal(entry.title, 'Attestation & Legalisation');
    assert.equal(entry.status, 'published');
    assert.equal(entry.fields.wordpressId, 42);
  });

  it('a slug that exists under a different parent path is not a match', async () => {
    const wp = provider({ pages: [WP_PAGE], posts: [] });
    assert.equal(await wp.getByPath('/other/attestation', 'en'), null);
  });

  it('sanitises rendered HTML before it becomes a section', async () => {
    const wp = provider({ pages: [WP_PAGE], posts: [] });
    const entry = await wp.getByPath('/services/attestation', 'en');
    const html = (entry?.document.sections[0]?.props as { html: string }).html;
    assert.ok(html.includes('<h2>How it works</h2>'));
    assert.ok(!html.includes('<script'), 'scripts are stripped');
    assert.ok(!html.includes('javascript:'), 'javascript: URLs are stripped');
  });

  it('derives stable ids so the same page keeps its identity across fetches', async () => {
    const wp = provider({ pages: [WP_PAGE], posts: [] });
    const first = await wp.getByPath('/services/attestation', 'en');
    const second = await wp.getByPath('/services/attestation', 'en');
    assert.equal(first?.id, second?.id);
    const found = await wp.getById(first!.id);
    assert.equal(found?.fields.wordpressId, 42);
  });

  it('lists routes across pages and posts with mapped types', async () => {
    const wp = provider({ pages: [WP_PAGE], posts: [WP_POST] });
    const routes = await wp.listRoutes('en');
    assert.deepEqual(routes.map((route) => [route.path, route.type]).sort(), [
      ['/blog/new-rules', 'post'],
      ['/services/attestation', 'page'],
    ]);
  });

  it('list() maps types and reports no next page when WordPress says one page', async () => {
    const wp = provider({ pages: [WP_PAGE], posts: [WP_POST] });
    const posts = await wp.list({ type: 'post' });
    assert.equal(posts.items[0]?.type, 'post');
    assert.equal(posts.nextCursor, undefined);
  });
});
