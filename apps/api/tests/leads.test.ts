import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { schema, withoutTenantScope } from '@bos/database';
import {
  authHeaders,
  clearRateLimits,
  createHarness,
  createMember,
  createSecondaryWorkspace,
  login,
  seedForm,
  seedPipeline,
  type Harness,
} from './helpers.ts';

/**
 * The forms → leads → CRM slice.
 *
 * What is worth testing here is not that a row is written — it is that the
 * *whole* set of rows is written together and exactly once. A lead without its
 * activity, or a confirmation sent twice because a queue redelivered, are both
 * failures a happy-path test would miss.
 */

let harness: Harness;
let ownerToken: string;
let stageIds: string[];

const EDGE_SECRET = 'test-edge-shared-secret-at-least-32-characters';

before(async () => {
  harness = await createHarness();
  await clearRateLimits(harness);

  const owner = await createMember(harness, 'owner');
  ownerToken = (await login(harness, owner.email)).accessToken;

  // Seeded for its side effect: the public route resolves it by slug.
  await seedForm(harness);
  stageIds = (await seedPipeline(harness)).stageIds;
});

after(async () => {
  await harness.close();
});

function submission(overrides: Record<string, unknown> = {}) {
  return {
    values: {
      name: 'Rahim Uddin',
      phone: '01712345678',
      email: 'rahim@example.test',
      message: 'I need a transcript.',
    },
    consent: true,
    landingPath: '/services/transcript',
    elapsedMs: 9_000,
    attribution: {
      firstTouch: {
        occurredAt: '2026-08-01T10:00:00Z',
        landingPath: '/',
        channel: 'organic_search',
        utm: { source: 'google', medium: 'organic' },
      },
      lastTouch: {
        occurredAt: '2026-08-21T10:00:00Z',
        landingPath: '/services/transcript',
        channel: 'organic_search',
        utm: { source: 'google', medium: 'organic' },
      },
    },
    ...overrides,
  };
}

const submitUrl = (harnessRef: Harness) =>
  `/v1/forms/service-request/submissions?workspace=${harnessRef.workspaceSlug}`;

describe('public submission', () => {
  it('creates a contact, a lead, an activity and an outbox event together', async () => {
    await clearRateLimits(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: submitUrl(harness),
      payload: submission(),
    });

    assert.equal(response.statusCode, 201);
    const body = response.json() as { status: string; reference: string };
    assert.equal(body.status, 'received');
    assert.ok(body.reference);

    const rows = await withoutTenantScope(harness.db, async (tx) => ({
      contacts: await tx
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.workspaceId, harness.workspaceId)),
      leads: await tx
        .select()
        .from(schema.leads)
        .where(eq(schema.leads.workspaceId, harness.workspaceId)),
      activities: await tx
        .select()
        .from(schema.activities)
        .where(eq(schema.activities.workspaceId, harness.workspaceId)),
      outbox: await tx
        .select()
        .from(schema.eventOutbox)
        .where(eq(schema.eventOutbox.workspaceId, harness.workspaceId)),
      touches: await tx
        .select()
        .from(schema.attributionTouches)
        .where(eq(schema.attributionTouches.workspaceId, harness.workspaceId)),
    }));

    assert.equal(rows.contacts.length, 1);
    assert.equal(rows.leads.length, 1);
    assert.equal(rows.activities.length, 1);
    // The event is the part that must not be able to go missing.
    assert.equal(rows.outbox.length, 1);
    assert.equal(rows.outbox[0]?.name, 'lead.created');
    assert.equal(rows.touches.length, 2, 'first and last touch are both recorded');

    // The lead landed in the first stage of the default pipeline, so it is
    // visible on the board rather than in limbo.
    assert.equal(rows.leads[0]?.stageId, stageIds[0]);

    // Local `01…` is stored as E.164, or phone-based contact deduplication
    // never matches anything.
    assert.equal(rows.contacts[0]?.phone, '+8801712345678');
    assert.equal(rows.leads[0]?.landingPath, '/services/transcript');
  });

  it('treats an identical resubmission as the same request', async () => {
    await clearRateLimits(harness);

    const again = await harness.app.inject({
      method: 'POST',
      url: submitUrl(harness),
      payload: submission(),
    });

    assert.equal(again.statusCode, 201);

    const leads = await withoutTenantScope(harness.db, (tx) =>
      tx.select().from(schema.leads).where(eq(schema.leads.workspaceId, harness.workspaceId)),
    );
    assert.equal(leads.length, 1, 'a double-click must not create a second lead');
  });

  it('creates a second lead for the same person making a different request', async () => {
    await clearRateLimits(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: submitUrl(harness),
      payload: submission({
        values: {
          name: 'Rahim Uddin',
          phone: '01712345678',
          email: 'rahim@example.test',
          message: 'Now I also need a certificate.',
        },
      }),
    });
    assert.equal(response.statusCode, 201);

    const rows = await withoutTenantScope(harness.db, async (tx) => ({
      contacts: await tx
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.workspaceId, harness.workspaceId)),
      leads: await tx
        .select()
        .from(schema.leads)
        .where(eq(schema.leads.workspaceId, harness.workspaceId)),
    }));

    // One person, two enquiries. Collapsing them would lose the second
    // request; duplicating the person would lose the history.
    assert.equal(rows.contacts.length, 1);
    assert.equal(rows.leads.length, 2);
  });

  it('silently discards a submission that filled the honeypot', async () => {
    await clearRateLimits(harness);

    const before = await withoutTenantScope(harness.db, (tx) =>
      tx.select().from(schema.leads).where(eq(schema.leads.workspaceId, harness.workspaceId)),
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: submitUrl(harness),
      payload: submission({
        values: {
          name: 'Bot',
          phone: '01799999999',
          message: 'buy things',
          company_website: 'https://spam.example',
        },
      }),
    });

    // The bot is told it succeeded. Telling it otherwise teaches whoever wrote
    // it which field to leave alone next time.
    assert.equal(response.statusCode, 201);

    const after = await withoutTenantScope(harness.db, (tx) =>
      tx.select().from(schema.leads).where(eq(schema.leads.workspaceId, harness.workspaceId)),
    );
    assert.equal(after.length, before.length, 'the honeypot submission became a lead');
  });

  it('rejects a submission with no way to reply', async () => {
    await clearRateLimits(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: submitUrl(harness),
      payload: submission({ values: { name: 'Nobody', message: 'hello' } }),
    });

    assert.equal(response.statusCode, 422);
  });

  it('rejects a submission without consent when the form requires it', async () => {
    await clearRateLimits(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: submitUrl(harness),
      payload: submission({ consent: false }),
    });

    assert.equal(response.statusCode, 400);
  });

  it('stores only the fields the form defines', async () => {
    await clearRateLimits(harness);

    await harness.app.inject({
      method: 'POST',
      url: submitUrl(harness),
      payload: submission({
        values: {
          name: 'Karim',
          phone: '01811111111',
          message: 'Hello',
          // Not in the form definition. A crafted request must not be able to
          // write arbitrary keys into the stored payload.
          smuggled_field: 'should not be stored',
        },
      }),
    });

    const submissions = await withoutTenantScope(harness.db, (tx) =>
      tx
        .select()
        .from(schema.formSubmissions)
        .where(eq(schema.formSubmissions.workspaceId, harness.workspaceId)),
    );

    const stored = JSON.stringify(submissions.map((row) => row.payload));
    assert.ok(!stored.includes('smuggled_field'), 'an undeclared field was stored');
  });

  it('rate-limits a flood from one address', async () => {
    await clearRateLimits(harness);

    let throttled = false;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const response = await harness.app.inject({
        method: 'POST',
        url: submitUrl(harness),
        payload: submission({
          values: {
            name: `Flood ${attempt}`,
            phone: `018000000${String(attempt).padStart(2, '0')}`,
            message: `Message ${attempt}`,
          },
        }),
      });
      if (response.statusCode === 429) {
        throttled = true;
        break;
      }
    }

    assert.ok(throttled, 'expected the form to rate-limit before the fifteenth submission');
    await clearRateLimits(harness);
  });

  it('404s for a form that does not exist', async () => {
    await clearRateLimits(harness);
    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/forms/no-such-form/submissions?workspace=${harness.workspaceSlug}`,
      payload: submission(),
    });
    assert.equal(response.statusCode, 404);
  });
});

describe('outbox dispatch', () => {
  it('sends each message once, however many times it is dispatched', async () => {
    const first = await harness.app.inject({
      method: 'POST',
      url: '/v1/internal/jobs/outbox.dispatch',
      headers: { 'x-bos-edge-secret': EDGE_SECRET },
    });
    assert.equal(first.statusCode, 200);

    const firstResult = first.json() as { dispatched: number };
    assert.ok(firstResult.dispatched > 0, 'expected pending events to dispatch');

    const messagesAfterFirst = await withoutTenantScope(harness.db, (tx) =>
      tx.select().from(schema.messages).where(eq(schema.messages.workspaceId, harness.workspaceId)),
    );

    // Requeue everything and dispatch again — the shape a redelivery takes.
    await withoutTenantScope(harness.db, (tx) =>
      tx
        .update(schema.eventOutbox)
        .set({ status: 'pending', attempts: 0, availableAt: new Date() })
        .where(eq(schema.eventOutbox.workspaceId, harness.workspaceId)),
    );

    await harness.app.inject({
      method: 'POST',
      url: '/v1/internal/jobs/outbox.dispatch',
      headers: { 'x-bos-edge-secret': EDGE_SECRET },
    });

    const messagesAfterSecond = await withoutTenantScope(harness.db, (tx) =>
      tx.select().from(schema.messages).where(eq(schema.messages.workspaceId, harness.workspaceId)),
    );

    // The idempotency key on `messages` is what makes at-least-once delivery
    // survivable. Without it this is where a customer gets two emails.
    assert.equal(
      messagesAfterSecond.length,
      messagesAfterFirst.length,
      'a redelivered event sent a duplicate message',
    );
  });

  it('rejects an unsigned internal call', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/internal/jobs/outbox.dispatch',
    });
    assert.equal(response.statusCode, 401);
  });

  it('rejects an internal call with the wrong secret', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/internal/jobs/outbox.dispatch',
      headers: { 'x-bos-edge-secret': 'wrong-secret-of-exactly-the-same-length!!' },
    });
    assert.equal(response.statusCode, 401);
  });
});

describe('CRM', () => {
  it('lists the leads the form created', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/crm/leads',
      headers: authHeaders(harness, ownerToken),
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as { items: { contactName: string; contactPhone: string }[] };
    assert.ok(body.items.length > 0);
    assert.ok(body.items.some((item) => item.contactName === 'Rahim Uddin'));
  });

  it('moves a lead through the pipeline and records it on the timeline', async () => {
    const list = await harness.app.inject({
      method: 'GET',
      url: '/v1/crm/leads',
      headers: authHeaders(harness, ownerToken),
    });
    const leadId = (list.json() as { items: { id: string }[] }).items[0]!.id;

    const moved = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/crm/leads/${leadId}`,
      headers: authHeaders(harness, ownerToken),
      payload: { stageId: stageIds[1] },
    });
    assert.equal(moved.statusCode, 200);

    const detail = await harness.app.inject({
      method: 'GET',
      url: `/v1/crm/leads/${leadId}`,
      headers: authHeaders(harness, ownerToken),
    });

    const body = detail.json() as {
      lead: { stageId: string };
      activities: { type: string }[];
    };

    assert.equal(body.lead.stageId, stageIds[1]);
    assert.ok(
      body.activities.some((activity) => activity.type === 'lead.stage_changed'),
      'a stage move must leave a trace on the timeline',
    );
  });

  it('refuses a stage that belongs to another workspace', async () => {
    const other = await createSecondaryWorkspace(harness);
    try {
      const foreignStage = await withoutTenantScope(harness.db, async (tx) => {
        const [pipeline] = await tx
          .insert(schema.pipelines)
          .values({ workspaceId: other.workspaceId, slug: 'sales', name: 'Other', isDefault: true })
          .returning({ id: schema.pipelines.id });
        const [stage] = await tx
          .insert(schema.pipelineStages)
          .values({
            workspaceId: other.workspaceId,
            pipelineId: pipeline!.id,
            slug: 'new',
            name: 'New',
            position: 0,
          })
          .returning({ id: schema.pipelineStages.id });
        return stage!.id;
      });

      const list = await harness.app.inject({
        method: 'GET',
        url: '/v1/crm/leads',
        headers: authHeaders(harness, ownerToken),
      });
      const leadId = (list.json() as { items: { id: string }[] }).items[0]!.id;

      const response = await harness.app.inject({
        method: 'PATCH',
        url: `/v1/crm/leads/${leadId}`,
        headers: authHeaders(harness, ownerToken),
        payload: { stageId: foreignStage },
      });

      // Row-level security means the stage lookup returns nothing, so the
      // request is refused rather than silently moving the lead somewhere the
      // board cannot show it.
      assert.equal(response.statusCode, 400);
    } finally {
      await other.drop();
    }
  });

  it('hides a lead from another workspace behind a 404', async () => {
    const other = await createSecondaryWorkspace(harness);
    try {
      const foreignLead = await withoutTenantScope(harness.db, async (tx) => {
        const [contact] = await tx
          .insert(schema.contacts)
          .values({ workspaceId: other.workspaceId, fullName: 'Other Person' })
          .returning({ id: schema.contacts.id });
        const [lead] = await tx
          .insert(schema.leads)
          .values({
            workspaceId: other.workspaceId,
            contactId: contact!.id,
            source: 'website_form',
          })
          .returning({ id: schema.leads.id });
        return lead!.id;
      });

      const response = await harness.app.inject({
        method: 'GET',
        url: `/v1/crm/leads/${foreignLead}`,
        headers: authHeaders(harness, ownerToken),
      });

      assert.equal(response.statusCode, 404, 'a cross-tenant id must not be confirmed with a 403');
    } finally {
      await other.drop();
    }
  });

  it('withholds the submitted values from a role without forms.submissions.read', async () => {
    await clearRateLimits(harness);
    const viewer = await createMember(harness, 'viewer');
    const token = (await login(harness, viewer.email)).accessToken;

    const list = await harness.app.inject({
      method: 'GET',
      url: '/v1/crm/leads',
      headers: authHeaders(harness, token),
    });
    const leadId = (list.json() as { items: { id: string }[] }).items[0]!.id;

    const detail = await harness.app.inject({
      method: 'GET',
      url: `/v1/crm/leads/${leadId}`,
      headers: authHeaders(harness, token),
    });

    assert.equal(detail.statusCode, 200);
    const body = detail.json() as { submission: unknown };
    // A registration number lives in that payload. "May work leads" and "may
    // read what people typed" are separate decisions.
    assert.equal(body.submission, null);
  });

  it('adds a note and shows it on the timeline', async () => {
    const list = await harness.app.inject({
      method: 'GET',
      url: '/v1/crm/leads',
      headers: authHeaders(harness, ownerToken),
    });
    const leadId = (list.json() as { items: { id: string }[] }).items[0]!.id;

    const created = await harness.app.inject({
      method: 'POST',
      url: `/v1/crm/leads/${leadId}/notes`,
      headers: authHeaders(harness, ownerToken),
      payload: { body: 'Called and left a voicemail.' },
    });
    assert.equal(created.statusCode, 201);

    const detail = await harness.app.inject({
      method: 'GET',
      url: `/v1/crm/leads/${leadId}`,
      headers: authHeaders(harness, ownerToken),
    });
    const body = detail.json() as { notes: { body: string }[] };
    assert.ok(body.notes.some((note) => note.body.includes('voicemail')));
  });

  it('refuses reassignment to a role without leads.assign', async () => {
    await clearRateLimits(harness);
    const staff = await createMember(harness, 'staff');
    const token = (await login(harness, staff.email)).accessToken;

    const list = await harness.app.inject({
      method: 'GET',
      url: '/v1/crm/leads',
      headers: authHeaders(harness, token),
    });
    const leadId = (list.json() as { items: { id: string }[] }).items[0]!.id;

    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/crm/leads/${leadId}`,
      headers: authHeaders(harness, token),
      payload: { assignedToUserId: staff.userId },
    });

    assert.equal(response.statusCode, 403);
  });
});

describe('documents', () => {
  it('reports 503 rather than pretending to accept an upload with no storage', async () => {
    await clearRateLimits(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/documents/upload-url',
      payload: {
        workspace: harness.workspaceSlug,
        filename: 'transcript.pdf',
        contentType: 'application/pdf',
        contentLength: 120_000,
      },
    });

    // The harness has no R2 credentials. An endpoint that returned a fake URL
    // here would appear to work and store nothing.
    assert.equal(response.statusCode, 503);
  });

  it('refuses a file type that is not on the allow-list', async () => {
    await clearRateLimits(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/documents/upload-url',
      payload: {
        workspace: harness.workspaceSlug,
        filename: 'payload.svg',
        contentType: 'image/svg+xml',
        contentLength: 1_000,
      },
    });

    // An SVG is a document that can carry script. It is rejected before the
    // storage check, so the answer is the same with or without R2 configured.
    assert.equal(response.statusCode, 400);
  });

  it('requires documents.download for a download URL', async () => {
    await clearRateLimits(harness);
    const staff = await createMember(harness, 'staff');
    const token = (await login(harness, staff.email)).accessToken;

    const document = await withoutTenantScope(harness.db, async (tx) => {
      const [row] = await tx
        .insert(schema.documents)
        .values({
          workspaceId: harness.workspaceId,
          kind: 'transcript',
          objectKey: `documents/${harness.workspaceId}/test.pdf`,
          originalFilename: 'transcript.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1_000,
          checksumSha256: 'x'.repeat(64),
          status: 'clean',
        })
        .returning({ id: schema.documents.id });
      return row!.id;
    });

    // Staff may see that a document is attached; opening it is a manager's
    // grant, so the audit log always has someone to name.
    const staffAttempt = await harness.app.inject({
      method: 'POST',
      url: `/v1/documents/${document}/download-url`,
      headers: authHeaders(harness, token),
    });
    assert.equal(staffAttempt.statusCode, 403);

    const anonymous = await harness.app.inject({
      method: 'POST',
      url: `/v1/documents/${document}/download-url`,
    });
    assert.equal(anonymous.statusCode, 401);
  });
});

describe('analytics ingestion', () => {
  it('rejects an event name that is not on the allow-list', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/internal/ingest',
      headers: { 'x-bos-edge-secret': EDGE_SECRET },
      payload: {
        kind: 'analytics.batch',
        workspace: harness.workspaceSlug,
        events: [{ name: 'arbitrary_event', path: '/', properties: {} }],
      },
    });

    assert.equal(response.statusCode, 400);
  });

  it('strips personal fields from event properties', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/internal/ingest',
      headers: { 'x-bos-edge-secret': EDGE_SECRET },
      payload: {
        kind: 'analytics.batch',
        workspace: harness.workspaceSlug,
        events: [
          {
            name: 'form_submit',
            path: '/services/transcript',
            properties: {
              formSlug: 'service-request',
              email: 'rahim@example.test',
              registration_number: '1234567',
              phone: '01712345678',
            },
          },
        ],
      },
    });

    assert.equal(response.statusCode, 202);

    const events = await withoutTenantScope(harness.db, (tx) =>
      tx
        .select()
        .from(schema.analyticsEvents)
        .where(
          and(
            eq(schema.analyticsEvents.workspaceId, harness.workspaceId),
            eq(schema.analyticsEvents.name, 'form_submit'),
          ),
        ),
    );

    const stored = JSON.stringify(events.map((row) => row.properties));
    assert.ok(stored.includes('service-request'), 'the useful property was dropped');
    assert.ok(!stored.includes('rahim@example.test'), 'an email address reached analytics');
    assert.ok(!stored.includes('1234567'), 'a registration number reached analytics');
    assert.ok(!stored.includes('01712345678'), 'a phone number reached analytics');
  });

  it('stores a keyed pseudonym rather than anything resembling an address', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/v1/internal/ingest',
      headers: { 'x-bos-edge-secret': EDGE_SECRET },
      payload: {
        kind: 'analytics.batch',
        workspace: harness.workspaceSlug,
        events: [
          { name: 'page_view', path: '/', visitorHash: 'edge-derived-value', properties: {} },
        ],
      },
    });

    const sessions = await withoutTenantScope(harness.db, (tx) =>
      tx
        .select()
        .from(schema.analyticsSessions)
        .where(eq(schema.analyticsSessions.workspaceId, harness.workspaceId)),
    );

    assert.ok(sessions.length > 0);
    for (const session of sessions) {
      assert.equal(session.visitorHash.length, 64, 'expected a SHA-256 hex digest');
      assert.notEqual(session.visitorHash, 'edge-derived-value');
    }
  });
});
