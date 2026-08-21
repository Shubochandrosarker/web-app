import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import { schema, withoutTenantScope } from '@bos/database';
import { buildApp, type BuiltApp } from '../src/app.ts';
import {
  authHeaders,
  clearRateLimits,
  createHarness,
  createMember,
  login,
  seedForm,
  seedPipeline,
  testConfig,
  type Harness,
} from './helpers.ts';

/**
 * The WhatsApp path end to end without Meta: the webhook simulator here IS
 * the integration seam — signed payloads exactly as the Cloud API sends
 * them, against the real verification and the real database.
 */

const APP_SECRET = 'test-meta-app-secret';
const VERIFY_TOKEN = 'test-verify-token-42';

let harness: Harness;
let built: BuiltApp;

before(async () => {
  harness = await createHarness();
  built = buildApp({
    config: testConfig({
      WHATSAPP_APP_SECRET: APP_SECRET,
      WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
      WHATSAPP_INBOUND_WORKSPACE: harness.workspaceSlug,
    }),
    database: harness.db,
    redis: harness.redis,
  });
  await built.app.ready();
  await seedPipeline(harness);
  await seedForm(harness);
});

after(async () => {
  await built?.app.close();
  await harness?.close();
});

function sign(body: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

function metaEnvelope(value: Record<string, unknown>): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value }] }],
  });
}

describe('webhook handshake and verification', () => {
  it('answers the subscription handshake only for the right verify token', async () => {
    const good = await built.app.inject({
      method: 'GET',
      url: `/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=echo-me-42`,
    });
    assert.equal(good.statusCode, 200);
    assert.equal(good.body, 'echo-me-42');

    const bad = await built.app.inject({
      method: 'GET',
      url: '/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=guessing&hub.challenge=x',
    });
    assert.equal(bad.statusCode, 403);
  });

  it('refuses an unsigned or mis-signed delivery', async () => {
    const body = metaEnvelope({ statuses: [] });

    const unsigned = await built.app.inject({
      method: 'POST',
      url: '/v1/webhooks/whatsapp',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    assert.equal(unsigned.statusCode, 401);

    const misSigned = await built.app.inject({
      method: 'POST',
      url: '/v1/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=deadbeef',
      },
      payload: body,
    });
    assert.equal(misSigned.statusCode, 401);
  });
});

describe('staff send and delivery lifecycle', () => {
  it('sends a template, records the message, and follows Meta’s receipts to delivered', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'staff');
    const tokens = await login(harness, member.email);
    const headers = authHeaders(harness, tokens.accessToken);

    // A lead arrives the way every real one does.
    const submitted = await built.app.inject({
      method: 'POST',
      url: `/v1/forms/service-request/submissions?workspace=${harness.workspaceSlug}`,
      payload: {
        values: {
          name: 'WhatsApp Person',
          phone: '+8801712345801',
          message: 'Enquiring properly.',
        },
        consent: true,
        elapsedMs: 9000,
      },
    });
    assert.equal(submitted.statusCode, 201, submitted.body);

    const leads = await built.app.inject({
      method: 'GET',
      url: '/v1/crm/leads?search=WhatsApp+Person',
      headers,
    });
    const leadId = (leads.json() as { items: { id: string }[] }).items[0]?.id;
    assert.ok(leadId);

    // A template to send.
    await withoutTenantScope(harness.db, (tx) =>
      tx.insert(schema.messageTemplates).values({
        workspaceId: harness.workspaceId,
        slug: 'follow_up',
        name: 'Follow up',
        channel: 'whatsapp',
        locale: 'en',
        body: 'Hello {{1}}, your request {{2}} is in progress.',
        variables: ['name', 'reference'],
      }),
    );

    const templates = await built.app.inject({
      method: 'GET',
      url: '/v1/crm/message-templates?channel=whatsapp',
      headers,
    });
    assert.equal(templates.statusCode, 200);
    assert.ok(
      (templates.json() as { items: { slug: string }[] }).items.some(
        (template) => template.slug === 'follow_up',
      ),
    );

    const sent = await built.app.inject({
      method: 'POST',
      url: `/v1/crm/leads/${leadId}/whatsapp`,
      headers,
      payload: { templateSlug: 'follow_up', variables: ['WhatsApp Person', 'REF-1'] },
    });
    assert.equal(sent.statusCode, 201, sent.body);
    const messageId = (sent.json() as { id: string }).id;

    // The log provider "sent" it; the row says so with the rendered body.
    const history = await built.app.inject({
      method: 'GET',
      url: `/v1/crm/leads/${leadId}/messages`,
      headers,
    });
    const recorded = (
      history.json() as { items: { id: string; status: string; body: string }[] }
    ).items.find((message) => message.id === messageId);
    assert.ok(recorded);
    assert.equal(recorded.status, 'sent');
    assert.match(recorded.body, /Hello WhatsApp Person, your request REF-1/);

    // Give the row a provider id, then let Meta's receipts walk it forward.
    await withoutTenantScope(harness.db, (tx) =>
      tx
        .update(schema.messages)
        .set({ providerMessageId: 'wamid.TEST123' })
        .where(eq(schema.messages.id, messageId)),
    );

    for (const status of ['delivered', 'read'] as const) {
      const receipt = metaEnvelope({
        statuses: [{ id: 'wamid.TEST123', status }],
      });
      const delivered = await built.app.inject({
        method: 'POST',
        url: '/v1/webhooks/whatsapp',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(receipt) },
        payload: receipt,
      });
      assert.equal(delivered.statusCode, 200);
    }

    const after = await withoutTenantScope(harness.db, async (tx) => {
      const [row] = await tx
        .select({ status: schema.messages.status })
        .from(schema.messages)
        .where(eq(schema.messages.id, messageId))
        .limit(1);
      return row;
    });
    assert.equal(after?.status, 'read');
  });

  it('records a failed receipt with the provider’s reason', async () => {
    await withoutTenantScope(harness.db, (tx) =>
      tx.insert(schema.messages).values({
        workspaceId: harness.workspaceId,
        channel: 'whatsapp',
        direction: 'outbound',
        status: 'sent',
        toAddress: '+8801712345899',
        fromAddress: 'whatsapp',
        provider: 'meta_cloud',
        providerMessageId: 'wamid.FAILME',
        idempotencyKey: 'test-fail-1',
      }),
    );

    const receipt = metaEnvelope({
      statuses: [
        {
          id: 'wamid.FAILME',
          status: 'failed',
          errors: [{ code: 131047, title: 'Re-engagement message' }],
        },
      ],
    });
    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(receipt) },
      payload: receipt,
    });
    assert.equal(response.statusCode, 200);

    const row = await withoutTenantScope(harness.db, async (tx) => {
      const [message] = await tx
        .select({ status: schema.messages.status, failureReason: schema.messages.failureReason })
        .from(schema.messages)
        .where(eq(schema.messages.providerMessageId, 'wamid.FAILME'))
        .limit(1);
      return message;
    });
    assert.equal(row?.status, 'failed');
    assert.match(row?.failureReason ?? '', /Re-engagement/);
  });
});

describe('inbound messages', () => {
  it('stores an inbound reply against the matching contact and their open lead', async () => {
    await clearRateLimits(harness);

    // The person already enquired; their reply should land on that enquiry.
    const submitted = await built.app.inject({
      method: 'POST',
      url: `/v1/forms/service-request/submissions?workspace=${harness.workspaceSlug}`,
      payload: {
        values: { name: 'Reply Person', phone: '+8801712345850', message: 'First enquiry here.' },
        consent: true,
        elapsedMs: 9000,
      },
    });
    assert.equal(submitted.statusCode, 201);

    const inbound = metaEnvelope({
      contacts: [{ wa_id: '8801712345850', profile: { name: 'Reply Person' } }],
      messages: [
        {
          from: '8801712345850',
          id: 'wamid.INBOUND1',
          type: 'text',
          text: { body: 'Thank you, when should I come in?' },
        },
      ],
    });
    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(inbound) },
      payload: inbound,
    });
    assert.equal(response.statusCode, 200);

    const stored = await withoutTenantScope(harness.db, async (tx) => {
      const [message] = await tx
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.providerMessageId, 'wamid.INBOUND1'))
        .limit(1);
      return message;
    });
    assert.ok(stored, 'the inbound message is stored');
    assert.equal(stored.direction, 'inbound');
    assert.equal(stored.status, 'received');
    assert.ok(stored.contactId, 'matched to the contact by number');
    assert.ok(stored.leadId, 'linked to their one open enquiry');
    assert.match(stored.body ?? '', /when should I come in/);

    // Replays are one row, not two.
    await built.app.inject({
      method: 'POST',
      url: '/v1/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(inbound) },
      payload: inbound,
    });
    const count = await withoutTenantScope(harness.db, async (tx) => {
      const rows = await tx
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(eq(schema.messages.providerMessageId, 'wamid.INBOUND1'));
      return rows.length;
    });
    assert.equal(count, 1);
  });
});
