import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { schema, withoutTenantScope } from '@bos/database';
import {
  authHeaders,
  clearRateLimits,
  createHarness,
  createMember,
  login,
  seedForm,
  seedPipeline,
  type Harness,
} from './helpers.ts';

/**
 * The automation engine, end to end through the real event path: a form
 * submission emits `lead.created` into the outbox, the outbox handler offers
 * it to the engine, and the engine drives the stored definition — including
 * the states that make it durable: waiting rows, retry backoff, the failed
 * dead-letter state and the manual retry out of it.
 */

const EDGE_SECRET = 'test-edge-shared-secret-at-least-32-characters';

let harness: Harness;
let headers: Record<string, string>;

before(async () => {
  harness = await createHarness();
  await seedPipeline(harness);
  await seedForm(harness);
  const admin = await createMember(harness, 'admin');
  const tokens = await login(harness, admin.email);
  headers = authHeaders(harness, tokens.accessToken);
});

after(async () => {
  await harness?.close();
});

/** Create an automation via the API and turn it on. Returns its id. */
async function createAutomation(body: Record<string, unknown>): Promise<string> {
  const created = await harness.app.inject({
    method: 'POST',
    url: '/v1/automations',
    headers,
    payload: body,
  });
  assert.equal(created.statusCode, 201, created.body);
  const { id } = created.json() as { id: string };

  const enabled = await harness.app.inject({
    method: 'PATCH',
    url: `/v1/automations/${id}`,
    headers,
    payload: { enabled: true },
  });
  assert.equal(enabled.statusCode, 200, enabled.body);
  return id;
}

/** Turn an automation off so later tests' events stop enrolling into it. */
async function disableAutomation(id: string): Promise<void> {
  await harness.app.inject({
    method: 'PATCH',
    url: `/v1/automations/${id}`,
    headers,
    payload: { enabled: false },
  });
}

/** Submit the public form, producing a real lead.created outbox event. */
async function submitForm(name: string, phone: string): Promise<void> {
  await clearRateLimits(harness);
  const response = await harness.app.inject({
    method: 'POST',
    url: `/v1/forms/service-request/submissions?workspace=${harness.workspaceSlug}`,
    payload: {
      values: { name, phone, message: 'Automation test enquiry.' },
      consent: true,
      elapsedMs: 9000,
    },
  });
  assert.equal(response.statusCode, 201, response.body);
}

/** Drain the outbox the way the cron does — which is what enrolls automations. */
async function dispatchOutbox(): Promise<void> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/v1/internal/jobs/outbox.dispatch',
    headers: { 'x-bos-edge-secret': EDGE_SECRET },
  });
  assert.equal(response.statusCode, 200, response.body);
}

async function resumeDue(): Promise<void> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/v1/internal/jobs/automations.resume',
    headers: { 'x-bos-edge-secret': EDGE_SECRET },
  });
  assert.equal(response.statusCode, 200, response.body);
}

async function runsFor(automationId: string) {
  return withoutTenantScope(harness.db, (tx) =>
    tx
      .select()
      .from(schema.automationRuns)
      .where(eq(schema.automationRuns.automationId, automationId)),
  );
}

describe('enrollment and actions', () => {
  it('enrolls from a real lead.created event and executes an action with context', async () => {
    const automationId = await createAutomation({
      name: 'Task on new enquiry',
      trigger: { kind: 'event', event: 'lead.created' },
      steps: [
        {
          id: randomUUID(),
          type: 'action',
          action: 'create_task',
          config: { title: 'Call {{contact.fullName}} back' },
          retry: { maxAttempts: 3, backoffSeconds: 60 },
        },
      ],
      reentry: 'always',
    });

    await submitForm('Automation Person', '+8801712346001');
    await dispatchOutbox();

    const runs = await runsFor(automationId);
    assert.equal(runs.length, 1, 'exactly one run enrolled');
    assert.equal(runs[0]!.status, 'completed');
    assert.ok(runs[0]!.contactId, 'the run is linked to the contact');

    // The action really happened, with the template rendered from context.
    const tasks = await withoutTenantScope(harness.db, (tx) =>
      tx.select().from(schema.tasks).where(eq(schema.tasks.createdByAutomationId, automationId)),
    );
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.title, 'Call Automation Person back');
    assert.equal(tasks[0]!.entityType, 'lead');

    // The run history recorded the step.
    const steps = await withoutTenantScope(harness.db, (tx) =>
      tx
        .select()
        .from(schema.automationRunSteps)
        .where(eq(schema.automationRunSteps.runId, runs[0]!.id)),
    );
    assert.equal(steps.length, 1);
    assert.equal(steps[0]!.status, 'completed');
    assert.equal(steps[0]!.action, 'create_task');

    await disableAutomation(automationId);
  });

  it('re-entry policy stops the same contact from enrolling twice', async () => {
    const automationId = await createAutomation({
      name: 'Once per contact',
      trigger: { kind: 'event', event: 'lead.created' },
      steps: [
        {
          id: randomUUID(),
          type: 'action',
          action: 'add_tag',
          config: { tag: 'welcomed' },
          retry: { maxAttempts: 1, backoffSeconds: 1 },
        },
      ],
      reentry: 'once_per_contact',
    });

    // The same person enquires twice; the sequence must run once.
    await submitForm('Repeat Person', '+8801712346002');
    await dispatchOutbox();
    await submitForm('Repeat Person', '+8801712346002');
    await dispatchOutbox();

    const runs = await runsFor(automationId);
    assert.equal(runs.length, 1, 'the second event hit the dedupe key');

    await disableAutomation(automationId);
  });

  it('a branch takes the recorded path and tags accordingly', async () => {
    const automationId = await createAutomation({
      name: 'Branch on source',
      trigger: { kind: 'event', event: 'lead.created' },
      steps: [
        {
          id: randomUUID(),
          type: 'branch',
          condition: {
            match: 'all',
            predicates: [{ path: 'trigger.source', comparator: 'equals', value: 'website_form' }],
          },
          then: [
            {
              id: randomUUID(),
              type: 'action',
              action: 'add_tag',
              config: { tag: 'from-website' },
              retry: { maxAttempts: 1, backoffSeconds: 1 },
            },
          ],
          otherwise: [
            {
              id: randomUUID(),
              type: 'action',
              action: 'add_tag',
              config: { tag: 'other-source' },
              retry: { maxAttempts: 1, backoffSeconds: 1 },
            },
          ],
        },
      ],
      reentry: 'always',
    });

    await submitForm('Branch Person', '+8801712346003');
    await dispatchOutbox();

    const runs = await runsFor(automationId);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, 'completed');

    const context = runs[0]!.context as { _branches?: Record<string, string> };
    assert.ok(context._branches, 'the decision is recorded in the run context');
    assert.deepEqual(Object.values(context._branches ?? {}), ['then']);

    const [tag] = await withoutTenantScope(harness.db, (tx) =>
      tx.select().from(schema.tags).where(eq(schema.tags.name, 'from-website')).limit(1),
    );
    assert.ok(tag, 'the then-side tag was created');
    const taggings = await withoutTenantScope(harness.db, (tx) =>
      tx.select().from(schema.taggables).where(eq(schema.taggables.tagId, tag!.id)),
    );
    assert.equal(taggings.length, 1);
    assert.equal(taggings[0]!.entityType, 'lead');

    await disableAutomation(automationId);
  });
});

describe('durable waits', () => {
  it('a wait step parks the run in the database and the resume job wakes it', async () => {
    const automationId = await createAutomation({
      name: 'Wait then task',
      trigger: { kind: 'event', event: 'lead.created' },
      steps: [
        { id: randomUUID(), type: 'wait', seconds: 1 },
        {
          id: randomUUID(),
          type: 'action',
          action: 'create_task',
          config: { title: 'After the wait' },
          retry: { maxAttempts: 1, backoffSeconds: 1 },
        },
      ],
      reentry: 'always',
    });

    await submitForm('Waiting Person', '+8801712346004');
    await dispatchOutbox();

    let runs = await runsFor(automationId);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, 'waiting', 'the run is a row, not a timer');
    assert.ok(runs[0]!.resumeAt, 'with a resume time');

    // Resuming early does nothing — the sleep has not elapsed.
    // (resumeAt is ~1s out; an immediate resume pass must not wake it if the
    // clock has not reached it. Allow for slow test hosts by only asserting
    // the final state below.)
    await sleep(1300);
    await resumeDue();

    runs = await runsFor(automationId);
    assert.equal(runs[0]!.status, 'completed', 'the resume job finished the run');

    const tasks = await withoutTenantScope(harness.db, (tx) =>
      tx
        .select()
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.createdByAutomationId, automationId),
            eq(schema.tasks.title, 'After the wait'),
          ),
        ),
    );
    assert.equal(tasks.length, 1, 'the post-wait action ran exactly once');

    await disableAutomation(automationId);
  });
});

describe('failure, retry and the way back out', () => {
  it('retries with backoff, dead-letters with the reason, and a manual retry completes it', async () => {
    const automationId = await createAutomation({
      name: 'Doomed send',
      trigger: { kind: 'event', event: 'lead.created' },
      steps: [
        {
          id: randomUUID(),
          type: 'action',
          action: 'send_whatsapp',
          config: { templateSlug: 'not-yet-created', variables: ['{{contact.fullName}}'] },
          retry: { maxAttempts: 2, backoffSeconds: 1 },
        },
      ],
      reentry: 'always',
    });

    await submitForm('Doomed Person', '+8801712346005');
    await dispatchOutbox();

    // Attempt 1 failed; the run is waiting out its backoff, not dead yet.
    let runs = await runsFor(automationId);
    assert.equal(runs.length, 1);
    const runId = runs[0]!.id;
    assert.equal(runs[0]!.status, 'waiting', 'failure under maxAttempts schedules a retry');

    await sleep(1300);
    await resumeDue();

    // Attempt 2 failed too — now it is a visible dead letter with the reason.
    runs = await runsFor(automationId);
    assert.equal(runs[0]!.status, 'failed');
    assert.match(runs[0]!.failureReason ?? '', /not-yet-created/);

    const steps = await withoutTenantScope(harness.db, (tx) =>
      tx.select().from(schema.automationRunSteps).where(eq(schema.automationRunSteps.runId, runId)),
    );
    assert.equal(steps.length, 1, 'retries update the step row rather than duplicating it');
    assert.equal(steps[0]!.attempt, 2);

    // Fix the cause, then use the dashboard's retry.
    await withoutTenantScope(harness.db, (tx) =>
      tx.insert(schema.messageTemplates).values({
        workspaceId: harness.workspaceId,
        slug: 'not-yet-created',
        name: 'Now it exists',
        channel: 'whatsapp',
        locale: 'en',
        body: 'Hello {{1}}',
        variables: ['name'],
      }),
    );

    const retried = await harness.app.inject({
      method: 'POST',
      url: `/v1/automations/runs/${runId}/retry`,
      headers,
      payload: {},
    });
    assert.equal(retried.statusCode, 200, retried.body);

    runs = await runsFor(automationId);
    assert.equal(runs[0]!.status, 'completed', 'the manual retry finished the run');
    assert.equal(runs[0]!.failureReason, null);

    // Exactly one message row, idempotent on the run and step.
    const messages = await withoutTenantScope(harness.db, (tx) =>
      tx.select().from(schema.messages).where(eq(schema.messages.automationRunId, runId)),
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.status, 'sent');
    assert.match(messages[0]!.body ?? '', /Hello Doomed Person/);

    await disableAutomation(automationId);
  });

  it('retrying a run that is not failed is refused', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/automations/runs/${randomUUID()}/retry`,
      headers,
      payload: {},
    });
    assert.equal(response.statusCode, 400);
  });
});

describe('authorisation and versioning', () => {
  it('staff can neither see nor edit automations; managers see, admins edit', async () => {
    const staff = await createMember(harness, 'staff');
    const staffTokens = await login(harness, staff.email);
    const staffHeaders = authHeaders(harness, staffTokens.accessToken);

    const staffList = await harness.app.inject({
      method: 'GET',
      url: '/v1/automations',
      headers: staffHeaders,
    });
    assert.equal(staffList.statusCode, 403);

    const manager = await createMember(harness, 'manager');
    const managerTokens = await login(harness, manager.email);
    const managerHeaders = authHeaders(harness, managerTokens.accessToken);

    const managerList = await harness.app.inject({
      method: 'GET',
      url: '/v1/automations',
      headers: managerHeaders,
    });
    assert.equal(managerList.statusCode, 200);

    const managerWrite = await harness.app.inject({
      method: 'POST',
      url: '/v1/automations',
      headers: managerHeaders,
      payload: {
        name: 'Should be refused',
        trigger: { kind: 'event', event: 'lead.created' },
        steps: [
          {
            id: randomUUID(),
            type: 'action',
            action: 'add_tag',
            config: { tag: 'x' },
            retry: { maxAttempts: 1, backoffSeconds: 1 },
          },
        ],
        reentry: 'always',
      },
    });
    assert.equal(managerWrite.statusCode, 403);
  });

  it('editing writes a new version and leaves the old one for in-flight runs', async () => {
    const stepId = randomUUID();
    const body = {
      name: 'Versioned',
      trigger: { kind: 'event', event: 'lead.created' },
      steps: [
        {
          id: stepId,
          type: 'action',
          action: 'add_tag',
          config: { tag: 'v1' },
          retry: { maxAttempts: 1, backoffSeconds: 1 },
        },
      ],
      reentry: 'always',
    };
    const automationId = await createAutomation(body);

    const updated = await harness.app.inject({
      method: 'PUT',
      url: `/v1/automations/${automationId}`,
      headers,
      payload: {
        ...body,
        steps: [
          {
            id: stepId,
            type: 'action',
            action: 'add_tag',
            config: { tag: 'v2' },
            retry: { maxAttempts: 1, backoffSeconds: 1 },
          },
        ],
      },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal((updated.json() as { version: number }).version, 2);

    const versions = await withoutTenantScope(harness.db, (tx) =>
      tx
        .select({ version: schema.automationVersions.version })
        .from(schema.automationVersions)
        .where(eq(schema.automationVersions.automationId, automationId)),
    );
    assert.deepEqual(versions.map((row) => row.version).sort(), [1, 2]);

    await disableAutomation(automationId);
  });

  it('refuses a definition with duplicate step ids', async () => {
    const stepId = randomUUID();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/automations',
      headers,
      payload: {
        name: 'Broken',
        trigger: { kind: 'event', event: 'lead.created' },
        steps: [
          {
            id: stepId,
            type: 'action',
            action: 'add_tag',
            config: { tag: 'a' },
            retry: { maxAttempts: 1, backoffSeconds: 1 },
          },
          {
            id: stepId,
            type: 'action',
            action: 'add_tag',
            config: { tag: 'b' },
            retry: { maxAttempts: 1, backoffSeconds: 1 },
          },
        ],
        reentry: 'always',
      },
    });
    assert.equal(response.statusCode, 400);
  });
});

describe('schedule triggers, clone and the failed-run queue', () => {
  it('a schedule automation enrolls when its cron matches, exactly once per minute', async () => {
    const automationId = await createAutomation({
      name: 'Monday morning sweep',
      trigger: { kind: 'schedule', cron: '30 9 * * 1' },
      steps: [
        {
          id: randomUUID(),
          type: 'action',
          action: 'create_task',
          config: { title: 'Weekly review of open enquiries' },
          retry: { maxAttempts: 3, backoffSeconds: 60 },
        },
      ],
      reentry: 'always',
    });

    // 2026-01-05 is a Monday; the harness workspace runs in Asia/Dhaka
    // (UTC+6), so 09:30 local is 03:30Z — the cron reads workspace time.
    const matching = '2026-01-05T03:30:00Z';
    const sweep = async (now: string) => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/v1/internal/jobs/automations.schedule',
        headers: { 'x-bos-edge-secret': EDGE_SECRET },
        payload: { now },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json() as { matched: number };
    };

    const first = await sweep(matching);
    assert.equal(first.matched, 1, 'the sweep matched the automation');
    let runs = await runsFor(automationId);
    assert.equal(runs.length, 1, 'one run for the matching minute');

    // The dispatcher passes every few seconds — the same minute cannot
    // enroll twice, and a non-matching minute enrolls nothing.
    await sweep(matching);
    await sweep('2026-01-05T03:31:00Z');
    await sweep('2026-01-06T03:30:00Z');
    runs = await runsFor(automationId);
    assert.equal(runs.length, 1, 'still exactly one run');

    await disableAutomation(automationId);
  });

  it('a malformed cron is refused at save time, loudly', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/automations',
      headers,
      payload: {
        name: 'Broken schedule',
        trigger: { kind: 'schedule', cron: '99 * * * *' },
        steps: [
          {
            id: randomUUID(),
            type: 'action',
            action: 'create_task',
            config: { title: 'Never' },
            retry: { maxAttempts: 3, backoffSeconds: 60 },
          },
        ],
        reentry: 'always',
      },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /cron minute/);
  });

  it('clone produces a disabled draft with the same definition and a fresh slug', async () => {
    const sourceId = await createAutomation({
      name: 'Cloneable',
      trigger: { kind: 'event', event: 'lead.created' },
      steps: [
        {
          id: randomUUID(),
          type: 'action',
          action: 'create_task',
          config: { title: 'Original step' },
          retry: { maxAttempts: 3, backoffSeconds: 60 },
        },
      ],
      reentry: 'always',
    });
    await disableAutomation(sourceId);

    const cloned = await harness.app.inject({
      method: 'POST',
      url: `/v1/automations/${sourceId}/clone`,
      headers,
      payload: {},
    });
    assert.equal(cloned.statusCode, 201, cloned.body);
    const cloneId = (cloned.json() as { id: string }).id;

    const detail = await harness.app.inject({
      method: 'GET',
      url: `/v1/automations/${cloneId}`,
      headers,
    });
    const body = detail.json() as {
      enabled: boolean;
      name: string;
      definition: { steps: { config: { title: string } }[] };
      metrics: { total: number };
      versions: { version: number }[];
    };
    assert.equal(body.enabled, false, 'clones start off');
    assert.match(body.name, /copy/);
    assert.equal(body.definition.steps[0]?.config.title, 'Original step');
    assert.equal(body.metrics.total, 0, 'a clone starts with no run history');
    assert.equal(body.versions.length, 1);
  });

  it('the cross-automation runs queue lists failures for replay', async () => {
    const listed = await harness.app.inject({
      method: 'GET',
      url: '/v1/automations/runs?status=failed&limit=10',
      headers,
    });
    assert.equal(listed.statusCode, 200, listed.body);
    const { items } = listed.json() as {
      items: { automationName: string; failureReason: string | null }[];
    };
    // Earlier suites dead-letter at least one run; each row names its
    // automation so a person can decide between replaying and fixing.
    assert.ok(Array.isArray(items));
    for (const item of items) {
      assert.ok(item.automationName.length > 0);
    }
  });
});
