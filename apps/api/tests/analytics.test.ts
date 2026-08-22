import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import { schema, withoutTenantScope } from '@bos/database';
import { ingestSearchConsole } from '../src/services/search-console.ts';
import {
  authHeaders,
  createHarness,
  createMember,
  login,
  seedPipeline,
  testConfig,
  type Harness,
} from './helpers.ts';

/**
 * The analytics read API over seeded first-party data, the nightly rollup,
 * and Search Console ingestion against a faked Google — the JWT is really
 * signed, the upsert is really exercised, only the network is scripted.
 */

const EDGE_SECRET = 'test-edge-shared-secret-at-least-32-characters';

let harness: Harness;
let headers: Record<string, string>;

before(async () => {
  harness = await createHarness();
  await seedPipeline(harness);
  const member = await createMember(harness, 'manager');
  const tokens = await login(harness, member.email);
  headers = authHeaders(harness, tokens.accessToken);

  // Yesterday's traffic: two sessions (one from an AI assistant), page views,
  // a form submission, and one lead — enough for every screen to have a row.
  const yesterday = new Date(Date.now() - 86_400_000);
  await withoutTenantScope(harness.db, async (tx) => {
    const [organic] = await tx
      .insert(schema.analyticsSessions)
      .values({
        workspaceId: harness.workspaceId,
        visitorHash: 'a'.repeat(64),
        startedAt: yesterday,
        landingPath: '/services/transcript',
        channel: 'organic_search',
        sourceKey: 'google',
        pageViewCount: 2,
      })
      .returning({ id: schema.analyticsSessions.id });
    const [ai] = await tx
      .insert(schema.analyticsSessions)
      .values({
        workspaceId: harness.workspaceId,
        visitorHash: 'b'.repeat(64),
        startedAt: yesterday,
        landingPath: '/',
        channel: 'ai_assistant',
        sourceKey: 'chatgpt',
        pageViewCount: 1,
      })
      .returning({ id: schema.analyticsSessions.id });

    await tx.insert(schema.analyticsEvents).values([
      {
        workspaceId: harness.workspaceId,
        sessionId: organic!.id,
        name: 'page_view',
        path: '/services/transcript',
        occurredAt: yesterday,
      },
      {
        workspaceId: harness.workspaceId,
        sessionId: organic!.id,
        name: 'form_submit',
        path: '/services/transcript',
        occurredAt: yesterday,
      },
      {
        workspaceId: harness.workspaceId,
        sessionId: ai!.id,
        name: 'page_view',
        path: '/',
        occurredAt: yesterday,
      },
    ]);

    const [contact] = await tx
      .insert(schema.contacts)
      .values({ workspaceId: harness.workspaceId, fullName: 'Analytics Person' })
      .returning({ id: schema.contacts.id });
    await tx.insert(schema.leads).values({
      workspaceId: harness.workspaceId,
      contactId: contact!.id,
      title: 'Analytics lead',
      status: 'won',
      source: 'website_form',
      createdAt: yesterday,
    });
  });
});

after(async () => {
  await harness?.close();
});

describe('traffic analytics', () => {
  it('overview reports live totals and, after the rollup, the day series', async () => {
    const rollup = await harness.app.inject({
      method: 'POST',
      url: '/v1/internal/jobs/analytics.rollup',
      headers: { 'x-bos-edge-secret': EDGE_SECRET },
    });
    assert.equal(rollup.statusCode, 200);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/analytics/overview?days=7',
      headers,
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      current: { sessions: number; page_views: number; conversions: number; leads: number };
      series: { date: string; sessions: number; leads: number }[];
    };
    assert.equal(body.current.sessions, 2);
    assert.equal(body.current.page_views, 2);
    assert.equal(body.current.conversions, 1);
    assert.equal(body.current.leads, 1);
    assert.ok(body.series.length >= 1, 'the rollup produced the day series');
    assert.equal(
      body.series.reduce((sum, day) => sum + day.leads, 0),
      1,
      'the live lead count is merged into the series',
    );
  });

  it('sources breaks traffic down by channel, including AI assistants', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/analytics/sources?days=7',
      headers,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      channels: { channel: string; sessions: number }[];
      sources: { channel: string; source: string }[];
    };
    assert.ok(body.channels.some((row) => row.channel === 'organic_search'));
    assert.ok(
      body.sources.some((row) => row.channel === 'ai_assistant' && row.source === 'chatgpt'),
    );
  });

  it('conversions attributes enquiries to sources and services', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/analytics/conversions?days=7',
      headers,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      funnel: { status: string; count: number }[];
      bySource: { source: string; leads: number; won: number }[];
    };
    assert.deepEqual(
      body.funnel.find((row) => row.status === 'won'),
      { status: 'won', count: 1, value: 0 },
    );
    assert.equal(body.bySource[0]?.source, 'website_form');
    assert.equal(body.bySource[0]?.won, 1);
  });
});

describe('search console', () => {
  it('reports unconfigured without credentials, and ingests idempotently with them', async () => {
    const unconfigured = await harness.app.inject({
      method: 'GET',
      url: '/v1/analytics/search?days=30',
      headers,
    });
    assert.equal(unconfigured.statusCode, 200);
    assert.equal((unconfigured.json() as { configured: boolean }).configured, false);

    // A real key signs the JWT; a scripted fetch plays Google.
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const day = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);

    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (new URL(url).hostname === 'oauth2.googleapis.com') {
        return new Response(JSON.stringify({ access_token: 'fake-token' }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { dimensions?: string[] };
      const dimension = body.dimensions?.[1] ?? 'query';
      const value =
        dimension === 'query'
          ? 'transcript correction'
          : dimension === 'page'
            ? 'https://test.example.com/services/transcript'
            : dimension === 'device'
              ? 'MOBILE'
              : 'bgd';
      return new Response(
        JSON.stringify({
          rows: [{ keys: [day, value], clicks: 12, impressions: 340, position: 6.4 }],
        }),
        { status: 200 },
      );
    };

    const deps = {
      db: harness.db,
      config: testConfig({
        GSC_CLIENT_EMAIL: 'reporter@project.iam.gserviceaccount.com',
        GSC_PRIVATE_KEY: pem,
        GSC_WORKSPACE: harness.workspaceSlug,
      }),
      resolveWorkspaceId: async () => harness.workspaceId,
      logger: { info() {}, warn() {} },
      fetchImpl: fakeFetch,
    };

    const first = await ingestSearchConsole(deps);
    assert.deepEqual(first, { query: 1, page: 1, device: 1, country: 1 });

    // Re-ingesting the same window overwrites rather than duplicates.
    const second = await ingestSearchConsole(deps);
    assert.deepEqual(second, { query: 1, page: 1, device: 1, country: 1 });

    const rows = await withoutTenantScope(harness.db, (tx) =>
      tx
        .select()
        .from(schema.searchConsoleDaily)
        .where(eq(schema.searchConsoleDaily.workspaceId, harness.workspaceId)),
    );
    assert.equal(rows.length, 4, 'one row per dimension, not eight after two runs');
    const query = rows.find((row) => row.dimension === 'query');
    assert.equal(query?.dimensionValue, 'transcript correction');
    assert.equal(query?.clicks, 12);
    assert.equal(query?.positionTimes100, 640);

    // The read API aggregates what was ingested.
    const search = await harness.app.inject({
      method: 'GET',
      url: '/v1/analytics/search?days=30&dimension=query',
      headers,
    });
    const body = search.json() as {
      rows: { value: string; clicks: number; ctr: number; position: number }[];
    };
    assert.equal(body.rows[0]?.value, 'transcript correction');
    assert.equal(body.rows[0]?.clicks, 12);
    assert.ok(Math.abs((body.rows[0]?.ctr ?? 0) - 12 / 340) < 0.001);
    assert.equal(body.rows[0]?.position, 6.4);
  });
});

describe('attribution and revenue', () => {
  it('reports attribution under both models and revenue from verified payments', async () => {
    const attribution = await harness.app.inject({
      method: 'GET',
      url: '/v1/analytics/attribution?model=first_touch&days=30',
      headers,
    });
    assert.equal(attribution.statusCode, 200, attribution.body);
    assert.equal((attribution.json() as { model: string }).model, 'first_touch');

    const lastTouch = await harness.app.inject({
      method: 'GET',
      url: '/v1/analytics/attribution?days=30',
      headers,
    });
    assert.equal((lastTouch.json() as { model: string }).model, 'last_touch', 'default model');

    const revenue = await harness.app.inject({
      method: 'GET',
      url: '/v1/analytics/revenue?days=30',
      headers,
    });
    assert.equal(revenue.statusCode, 200, revenue.body);
    const body = revenue.json() as {
      totals: unknown[];
      orders: { completed: number; total: number };
    };
    assert.ok(Array.isArray(body.totals));
    assert.ok(body.orders.total >= 0);
  });
});
