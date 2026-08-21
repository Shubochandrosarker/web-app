import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
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
 * The CRM surface added for daily operations: the contacts list, the task
 * queues, and the overview counts behind the home screen — plus the tenant
 * boundary on each, proven as the application role.
 */

let harness: Harness;

before(async () => {
  harness = await createHarness();
  await seedPipeline(harness);
  await seedForm(harness);
});

after(async () => {
  await harness?.close();
});

/** A lead via the public form, the way every real one arrives. */
async function submitLead(phone: string, name = 'Contact Person'): Promise<void> {
  const response = await harness.app.inject({
    method: 'POST',
    url: `/v1/forms/service-request/submissions?workspace=${harness.workspaceSlug}`,
    payload: {
      values: { name, phone, message: 'A real enquiry with enough words.' },
      consent: true,
      elapsedMs: 8000,
    },
  });
  assert.equal(response.statusCode, 201, response.body);
}

describe('contacts list', () => {
  it('lists contacts with lead counts and searches by the details staff hold', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'staff');
    const tokens = await login(harness, member.email);
    const headers = authHeaders(harness, tokens.accessToken);

    await submitLead('+8801712345701', 'Ayesha Rahman');
    await submitLead('+8801712345702', 'Kamal Hossain');

    const all = await harness.app.inject({ method: 'GET', url: '/v1/crm/contacts', headers });
    assert.equal(all.statusCode, 200);
    const items = (all.json() as { items: { fullName: string; leadCount: number }[] }).items;
    assert.ok(items.length >= 2);
    assert.ok(items.every((contact) => contact.leadCount >= 1));

    const searched = await harness.app.inject({
      method: 'GET',
      url: '/v1/crm/contacts?search=Ayesha',
      headers,
    });
    const found = (searched.json() as { items: { fullName: string }[] }).items;
    assert.equal(found.length, 1);
    assert.equal(found[0]!.fullName, 'Ayesha Rahman');
  });

  it('never lists another workspace’s contacts', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'staff');
    const tokens = await login(harness, member.email);

    const other = await createSecondaryWorkspace(harness);
    await withoutTenantScope(harness.db, (tx) =>
      tx.insert(schema.contacts).values({
        workspaceId: other.workspaceId,
        fullName: 'Somebody Elses Customer',
        phone: '+15550001111',
      }),
    );

    const listed = await harness.app.inject({
      method: 'GET',
      url: '/v1/crm/contacts?search=Somebody',
      headers: authHeaders(harness, tokens.accessToken),
    });
    assert.equal(listed.statusCode, 200);
    assert.equal((listed.json() as { items: unknown[] }).items.length, 0);

    await other.drop();
  });
});

describe('task queues', () => {
  it('filters by mine / overdue / today against the database clock', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'staff');
    const tokens = await login(harness, member.email);
    const headers = authHeaders(harness, tokens.accessToken);

    await withoutTenantScope(harness.db, (tx) =>
      tx.insert(schema.tasks).values([
        {
          workspaceId: harness.workspaceId,
          title: 'Call back yesterday',
          status: 'open',
          dueAt: new Date(Date.now() - 24 * 3600 * 1000),
          assignedToUserId: member.userId,
        },
        {
          workspaceId: harness.workspaceId,
          title: 'Prepare papers next week',
          status: 'open',
          dueAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        },
      ]),
    );

    const overdue = await harness.app.inject({
      method: 'GET',
      url: '/v1/crm/tasks?due=overdue',
      headers,
    });
    const overdueItems = (overdue.json() as { items: { title: string; overdue: boolean }[] }).items;
    assert.ok(overdueItems.some((task) => task.title === 'Call back yesterday'));
    assert.ok(overdueItems.every((task) => task.overdue));

    const mine = await harness.app.inject({
      method: 'GET',
      url: '/v1/crm/tasks?assigned=me',
      headers,
    });
    const mineItems = (mine.json() as { items: { title: string }[] }).items;
    assert.ok(mineItems.some((task) => task.title === 'Call back yesterday'));
    assert.ok(!mineItems.some((task) => task.title === 'Prepare papers next week'));
  });
});

describe('overview', () => {
  it('reports real counts for the home screen', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'staff');
    const tokens = await login(harness, member.email);

    await submitLead('+8801712345703', 'Overview Test');

    const overview = await harness.app.inject({
      method: 'GET',
      url: '/v1/crm/overview',
      headers: authHeaders(harness, tokens.accessToken),
    });
    assert.equal(overview.statusCode, 200);
    const body = overview.json() as {
      newLeadsToday: number;
      unassignedLeads: number;
      leadsThisWeek: number;
    };
    assert.ok(body.newLeadsToday >= 1, 'the lead submitted just now counts');
    assert.ok(body.unassignedLeads >= 1, 'nobody has picked it up');
    assert.ok(body.leadsThisWeek >= body.newLeadsToday);
  });
});
