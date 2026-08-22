import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { schema, withoutTenantScope } from '@bos/database';
import {
  authHeaders,
  createHarness,
  createMember,
  login,
  seedContent,
  type Harness,
} from './helpers.ts';

/**
 * The SEO audit over a deliberately imperfect content set: an orphan, a thin
 * page, a duplicate-title pair, a broken internal link and a service without
 * a FAQ — each planted so the check that should catch it can prove it does.
 */

let harness: Harness;
let headers: Record<string, string>;

const LONG_TEXT = 'A properly substantial paragraph of page text. '.repeat(12);

before(async () => {
  harness = await createHarness();
  const member = await createMember(harness, 'manager');
  const tokens = await login(harness, member.email);
  headers = authHeaders(harness, tokens.accessToken);

  await seedContent(harness, {
    path: '/',
    slug: 'home',
    title: 'Home — the front page',
    sections: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        type: 'content',
        hidden: false,
        props: {
          html: `<p>${LONG_TEXT}</p><p><a href="/services/good">Our service</a> and a <a href="/missing-page">broken link</a>.</p>`,
          layout: 'prose',
        },
      },
    ],
  });

  await seedContent(harness, {
    path: '/services/good',
    slug: 'good',
    title: 'A well-linked service',
    type: 'service',
    sections: [
      {
        id: '00000000-0000-4000-8000-000000000002',
        type: 'content',
        hidden: false,
        props: { html: `<p>${LONG_TEXT}</p>`, layout: 'prose' },
      },
    ],
  });

  // Nobody links here, and there is almost nothing on it.
  await seedContent(harness, {
    path: '/orphan',
    slug: 'orphan',
    title: 'Orphan page',
    sections: [
      {
        id: '00000000-0000-4000-8000-000000000003',
        type: 'content',
        hidden: false,
        props: { html: '<p>Tiny.</p>', layout: 'prose' },
      },
    ],
  });

  // A duplicate-title pair.
  await seedContent(harness, {
    path: '/duplicate-a',
    slug: 'duplicate-a',
    title: 'Exactly The Same Title',
    sections: [],
  });
  await seedContent(harness, {
    path: '/duplicate-b',
    slug: 'duplicate-b',
    title: 'Exactly The Same Title',
    sections: [],
  });
});

after(async () => {
  await harness?.close();
});

function check(
  body: { checks: { id: string; findings: { path: string; detail: string }[] }[] },
  id: string,
) {
  return body.checks.find((entry) => entry.id === id);
}

describe('seo audit', () => {
  it('finds the planted problems and nothing imaginary', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/v1/seo/audit', headers });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      pagesAudited: number;
      summary: { critical: number };
      aiProvider: string | null;
      checks: { id: string; severity: string; findings: { path: string; detail: string }[] }[];
    };

    assert.equal(body.pagesAudited, 5);
    assert.equal(body.aiProvider, null, 'no AI provider is configured in tests');

    assert.equal(check(body, 'missing-home'), undefined, 'the home page exists');

    const broken = check(body, 'broken-internal-links');
    assert.ok(broken, 'the broken link was found');
    assert.equal(broken.findings[0]?.path, '/');
    assert.match(broken.findings[0]?.detail ?? '', /\/missing-page/);

    const orphans = check(body, 'orphan-pages');
    assert.ok(orphans);
    assert.ok(
      orphans.findings.some((finding) => finding.path === '/orphan'),
      'the orphan is flagged',
    );
    assert.ok(
      !orphans.findings.some((finding) => finding.path === '/services/good'),
      'a linked page is not an orphan',
    );

    const thin = check(body, 'thin-content');
    assert.ok(thin?.findings.some((finding) => finding.path === '/orphan'));
    assert.ok(!thin?.findings.some((finding) => finding.path === '/'));

    const duplicates = check(body, 'duplicate-titles');
    assert.equal(duplicates?.findings.length, 2, 'both halves of the pair are named');

    const faq = check(body, 'services-without-faq');
    assert.ok(faq?.findings.some((finding) => finding.path === '/services/good'));

    // Every published page lacks a meta description in this seed.
    assert.equal(check(body, 'missing-description')?.findings.length, 5);
  });

  it('classifies Search Console opportunities from ingested rows', async () => {
    const day = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    await withoutTenantScope(harness.db, (tx) =>
      tx.insert(schema.searchConsoleDaily).values([
        {
          workspaceId: harness.workspaceId,
          date: day,
          dimension: 'query',
          dimensionValue: 'almost page one',
          clicks: 10,
          impressions: 200,
          positionTimes100: 820,
        },
        {
          workspaceId: harness.workspaceId,
          date: day,
          dimension: 'query',
          dimensionValue: 'ignored on page one',
          clicks: 0,
          impressions: 200,
          positionTimes100: 300,
        },
        {
          workspaceId: harness.workspaceId,
          date: day,
          dimension: 'query',
          dimensionValue: 'healthy query',
          clicks: 50,
          impressions: 200,
          positionTimes100: 150,
        },
      ]),
    );

    const response = await harness.app.inject({ method: 'GET', url: '/v1/seo/audit', headers });
    const body = response.json() as {
      opportunities: { query: string; kind: string }[];
    };
    const kinds = new Map(body.opportunities.map((row) => [row.query, row.kind]));
    assert.equal(kinds.get('almost page one'), 'striking_distance');
    assert.equal(kinds.get('ignored on page one'), 'low_ctr');
    assert.equal(kinds.get('healthy query'), undefined, 'a healthy query is not an opportunity');
  });

  it('suggestions without a configured provider explain themselves', async () => {
    const pageId = await seedContent(harness, {
      path: '/for-suggestions',
      slug: 'for-suggestions',
      title: 'Suggestions target',
      sections: [],
    });
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/seo/suggestions',
      headers,
      payload: { contentId: pageId },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /AI_PROVIDER/);
  });
});
