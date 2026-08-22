import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { schema, withoutTenantScope } from '@bos/database';
import {
  authHeaders,
  createHarness,
  createMember,
  createSecondaryWorkspace,
  login,
  type Harness,
} from './helpers.ts';

let harness: Harness;
let managerHeaders: Record<string, string>;
let viewerHeaders: Record<string, string>;

before(async () => {
  harness = await createHarness();
  const manager = await createMember(harness, 'manager');
  const viewer = await createMember(harness, 'viewer');
  managerHeaders = authHeaders(harness, (await login(harness, manager.email)).accessToken);
  viewerHeaders = authHeaders(harness, (await login(harness, viewer.email)).accessToken);
});

after(async () => {
  await harness?.close();
});

describe('services catalogue', () => {
  it('enforces permissions and supports the catalogue lifecycle', async () => {
    const denied = await harness.app.inject({
      method: 'POST',
      url: '/v1/services',
      headers: viewerHeaders,
      payload: { name: 'Denied', slug: `denied-${randomUUID().slice(0, 8)}` },
    });
    assert.equal(denied.statusCode, 403, denied.body);

    const slug = `transcript-${randomUUID().slice(0, 8)}`;
    const created = await harness.app.inject({
      method: 'POST',
      url: '/v1/services',
      headers: managerHeaders,
      payload: {
        name: 'Transcript assistance',
        slug,
        summary: 'Help preparing a transcript request.',
        requirements: ['Registration number'],
        priceAmount: 1500,
        priceCurrency: 'BDT',
        bookable: true,
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const createdId = (created.json() as { service: { id: string } }).service.id;

    const listed = await harness.app.inject({
      method: 'GET',
      url: `/v1/services?search=Transcript&limit=10`,
      headers: managerHeaders,
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal((listed.json() as { items: { slug: string }[] }).items[0]?.slug, slug);

    const updated = await harness.app.inject({
      method: 'PATCH',
      url: `/v1/services/${createdId}`,
      headers: managerHeaders,
      payload: { status: 'published', durationMinutes: 45 },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal((updated.json() as { service: { status: string } }).service.status, 'published');

    const duplicated = await harness.app.inject({
      method: 'POST',
      url: `/v1/services/${createdId}/duplicate`,
      headers: managerHeaders,
      payload: {},
    });
    assert.equal(duplicated.statusCode, 200, duplicated.body);
    assert.equal((duplicated.json() as { service: { status: string } }).service.status, 'draft');

    const archived = await harness.app.inject({
      method: 'POST',
      url: `/v1/services/${createdId}/archive`,
      headers: managerHeaders,
      payload: {},
    });
    assert.equal(archived.statusCode, 200, archived.body);
    assert.equal((archived.json() as { service: { status: string } }).service.status, 'archived');
  });

  it('refuses a duplicate slug instead of silently shadowing a service', async () => {
    const slug = `dup-${randomUUID().slice(0, 8)}`;
    const first = await harness.app.inject({
      method: 'POST',
      url: '/v1/services',
      headers: managerHeaders,
      payload: { name: 'First', slug },
    });
    assert.equal(first.statusCode, 200, first.body);

    const second = await harness.app.inject({
      method: 'POST',
      url: '/v1/services',
      headers: managerHeaders,
      payload: { name: 'Second', slug },
    });
    assert.equal(second.statusCode, 409, second.body);
  });
});

describe('service reference integrity', () => {
  /**
   * RLS hides foreign rows on read; these tests pin the write side — a
   * reference id from another tenant (or from nowhere) must be rejected at
   * save time, never stored as a dangling claim.
   */
  it('rejects a category or location belonging to another workspace', async () => {
    const other = await createSecondaryWorkspace(harness);
    try {
      const [foreignCategory] = await withoutTenantScope(harness.db, (tx) =>
        tx
          .insert(schema.serviceCategories)
          .values({ workspaceId: other.workspaceId, slug: 'foreign-cat', name: 'Foreign' })
          .returning({ id: schema.serviceCategories.id }),
      );
      const [foreignLocation] = await withoutTenantScope(harness.db, (tx) =>
        tx
          .insert(schema.locations)
          .values({
            workspaceId: other.workspaceId,
            slug: 'foreign-loc',
            legalName: 'Foreign Office Ltd',
            displayName: 'Foreign Office',
            streetAddress: '1 Elsewhere Road',
            addressLocality: 'Elsewhere',
            addressCountry: 'BD',
            telephone: '+8801811111111',
            email: 'foreign@office.example',
          })
          .returning({ id: schema.locations.id }),
      );

      const withForeignCategory = await harness.app.inject({
        method: 'POST',
        url: '/v1/services',
        headers: managerHeaders,
        payload: {
          name: 'Sneaky',
          slug: `sneaky-${randomUUID().slice(0, 8)}`,
          categoryId: foreignCategory!.id,
        },
      });
      assert.equal(withForeignCategory.statusCode, 400, withForeignCategory.body);

      const withForeignLocation = await harness.app.inject({
        method: 'POST',
        url: '/v1/services',
        headers: managerHeaders,
        payload: {
          name: 'Sneaky too',
          slug: `sneaky-${randomUUID().slice(0, 8)}`,
          locationIds: [foreignLocation!.id],
        },
      });
      assert.equal(withForeignLocation.statusCode, 400, withForeignLocation.body);

      // The patch path must apply the same check as create.
      const clean = await harness.app.inject({
        method: 'POST',
        url: '/v1/services',
        headers: managerHeaders,
        payload: { name: 'Clean', slug: `clean-${randomUUID().slice(0, 8)}` },
      });
      assert.equal(clean.statusCode, 200, clean.body);
      const cleanId = (clean.json() as { service: { id: string } }).service.id;

      const patched = await harness.app.inject({
        method: 'PATCH',
        url: `/v1/services/${cleanId}`,
        headers: managerHeaders,
        payload: { categoryId: foreignCategory!.id },
      });
      assert.equal(patched.statusCode, 400, patched.body);
    } finally {
      await other.drop();
    }
  });

  it('rejects a reference that does not exist at all', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/v1/services',
      headers: managerHeaders,
      payload: {
        name: 'Ghost ref',
        slug: `ghost-${randomUUID().slice(0, 8)}`,
        categoryId: randomUUID(),
      },
    });
    assert.equal(created.statusCode, 400, created.body);
  });

  it('accepts references that genuinely belong to this workspace', async () => {
    const [category] = await withoutTenantScope(harness.db, (tx) =>
      tx
        .insert(schema.serviceCategories)
        .values({ workspaceId: harness.workspaceId, slug: 'own-cat', name: 'Own category' })
        .returning({ id: schema.serviceCategories.id }),
    );
    const [location] = await withoutTenantScope(harness.db, (tx) =>
      tx
        .insert(schema.locations)
        .values({
          workspaceId: harness.workspaceId,
          slug: 'own-loc',
          legalName: 'Own Office Ltd',
          displayName: 'Own Office',
          streetAddress: '2 Local Avenue',
          addressLocality: 'Gazipur',
          addressCountry: 'BD',
          telephone: '+8801822222222',
          email: 'own@office.example',
        })
        .returning({ id: schema.locations.id }),
    );

    const created = await harness.app.inject({
      method: 'POST',
      url: '/v1/services',
      headers: managerHeaders,
      payload: {
        name: 'Well referenced',
        slug: `well-${randomUUID().slice(0, 8)}`,
        categoryId: category!.id,
        locationIds: [location!.id],
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const body = created.json() as { service: { categoryId: string; locationIds: string[] } };
    assert.equal(body.service.categoryId, category!.id);
    assert.deepEqual(body.service.locationIds, [location!.id]);
  });
});
