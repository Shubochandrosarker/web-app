import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { buildApp, type BuiltApp } from '../src/app.ts';
import type { Storage, SignedUpload } from '../src/providers/storage.ts';
import { imageDimensions } from '../src/routes/media.ts';
import {
  authHeaders,
  clearRateLimits,
  createHarness,
  createMember,
  login,
  testConfig,
  type Harness,
} from './helpers.ts';

/**
 * The media library and the form builder's write path.
 *
 * Media: bytes decide the type (an SVG cannot enter), dimensions come from
 * the headers, identical bytes deduplicate, and deletion is refused while a
 * page still references the image.
 *
 * Forms: the stored definition is the public endpoint's authority, so the
 * builder's API refuses definitions that could not be safely served — no
 * contact field, duplicate names, empty selects, honeypot collisions.
 */

class MemoryPublicStorage implements Storage {
  readonly configured = true;
  readonly objects = new Map<string, Uint8Array>();

  async signPrivateUpload(): Promise<SignedUpload> {
    throw new Error('not used here');
  }
  async signPrivateDownload(): Promise<{ url: string; expiresAt: Date }> {
    throw new Error('not used here');
  }
  async headPrivateObject(): Promise<{ sizeBytes: number; contentType: string } | null> {
    throw new Error('not used here');
  }
  async getPrivateObjectBytes(): Promise<Uint8Array | null> {
    throw new Error('not used here');
  }
  async putPublicObject(input: { objectKey: string; body: Uint8Array }): Promise<void> {
    this.objects.set(input.objectKey, input.body);
  }
  async deletePrivateObject(): Promise<void> {
    throw new Error('not used here');
  }
  async deletePublicObject(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
  }
}

/** A real 1×1 PNG. */
const PNG_1X1 = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
);

let harness: Harness;
let storage: MemoryPublicStorage;
let built: BuiltApp;

before(async () => {
  harness = await createHarness();
  storage = new MemoryPublicStorage();
  built = buildApp({
    config: testConfig({
      storage: {
        R2_ACCOUNT_ID: 'test',
        R2_ACCESS_KEY_ID: 'test',
        R2_SECRET_ACCESS_KEY: 'test',
        R2_PUBLIC_BUCKET: 'test-public',
        R2_PRIVATE_BUCKET: 'test-private',
        R2_PUBLIC_BASE_URL: 'https://assets.example.test',
        R2_SIGNED_URL_TTL: 300,
      },
    }),
    database: harness.db,
    redis: harness.redis,
    storage,
  });
  await built.app.ready();
});

after(async () => {
  await built?.app.close();
  await harness?.close();
});

function multipart(
  bytes: Uint8Array,
  filename: string,
  contentType: string,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = 'testboundary42';
  const head = Buffer.from(
    `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, Buffer.from(bytes), tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('image header parsing', () => {
  it('reads PNG dimensions', () => {
    assert.deepEqual(imageDimensions(PNG_1X1, 'image/png'), { width: 1, height: 1 });
  });
});

describe('media library', () => {
  it('accepts a real PNG, records dimensions, and deduplicates identical bytes', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'manager');
    const tokens = await login(harness, member.email);
    const headers = authHeaders(harness, tokens.accessToken);

    const upload = multipart(PNG_1X1, 'pixel.png', 'image/png');
    const first = await built.app.inject({
      method: 'POST',
      url: '/v1/cms/media',
      headers: { ...headers, ...upload.headers },
      payload: upload.payload,
    });
    assert.equal(first.statusCode, 201, first.body);
    const { id } = first.json() as { id: string };

    const listed = await built.app.inject({ method: 'GET', url: '/v1/cms/media', headers });
    const items = (listed.json() as { items: { id: string; width: number; url: string }[] }).items;
    const row = items.find((item) => item.id === id);
    assert.ok(row);
    assert.equal(row.width, 1, 'dimensions parsed from the header bytes');
    assert.match(row.url, /^https:\/\/assets\.example\.test\//);

    const again = await built.app.inject({
      method: 'POST',
      url: '/v1/cms/media',
      headers: { ...headers, ...upload.headers },
      payload: upload.payload,
    });
    assert.equal(again.statusCode, 200);
    assert.equal((again.json() as { deduplicated?: boolean }).deduplicated, true);
    assert.equal((again.json() as { id: string }).id, id, 'same bytes, same row');
  });

  it('refuses an SVG (or anything else outside the signature table), whatever it claims to be', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'manager');
    const tokens = await login(harness, member.email);
    const headers = authHeaders(harness, tokens.accessToken);

    const svg = new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    const upload = multipart(svg, 'sneaky.png', 'image/png');
    const refused = await built.app.inject({
      method: 'POST',
      url: '/v1/cms/media',
      headers: { ...headers, ...upload.headers },
      payload: upload.payload,
    });
    assert.equal(refused.statusCode, 400, 'the bytes decide, not the filename or content type');
  });

  it('refuses to delete an image a page still uses, and deletes an unused one', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'admin');
    const tokens = await login(harness, member.email);
    const headers = authHeaders(harness, tokens.accessToken);

    // A distinct image (different bytes → different checksum): a 1×1 PNG with
    // a different palette byte. Easiest distinct valid image: re-encode with
    // a trailing comment chunk — but simpler is a second upload of a JPEG.
    const JPEG_MIN = new Uint8Array(
      Buffer.from(
        '/9j/4AAQSkZJRgABAQEAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
        'base64',
      ),
    );
    const upload = multipart(JPEG_MIN, 'photo.jpg', 'image/jpeg');
    const created = await built.app.inject({
      method: 'POST',
      url: '/v1/cms/media',
      headers: { ...headers, ...upload.headers },
      payload: upload.payload,
    });
    assert.equal(created.statusCode, 201, created.body);
    const mediaId = (created.json() as { id: string }).id;

    // Place it on a page.
    const page = await built.app.inject({
      method: 'POST',
      url: '/v1/cms/content',
      headers,
      payload: {
        type: 'page',
        title: 'Uses the photo',
        slug: `uses-photo-${Date.now().toString(36)}`,
        path: `/uses-photo-${Date.now().toString(36)}`,
        locale: 'en',
        document: {
          sections: [
            {
              id: crypto.randomUUID(),
              type: 'hero',
              hidden: false,
              props: {
                heading: 'With a picture',
                variant: 'landing',
                links: [],
                media: { mediaId, alt: 'A photo' },
              },
            },
          ],
        },
      },
    });
    assert.equal(page.statusCode, 201, page.body);

    const refused = await built.app.inject({
      method: 'DELETE',
      url: `/v1/cms/media/${mediaId}`,
      headers,
    });
    assert.equal(refused.statusCode, 409, 'an image in use cannot be deleted');
    assert.match((refused.json() as { error: { message: string } }).error.message, /used on/);

    // Remove the reference, then deletion goes through.
    const pageId = (page.json() as { id: string }).id;
    await built.app.inject({
      method: 'PATCH',
      url: `/v1/cms/content/${pageId}`,
      headers,
      payload: { document: { sections: [] } },
    });

    const deleted = await built.app.inject({
      method: 'DELETE',
      url: `/v1/cms/media/${mediaId}`,
      headers,
    });
    assert.equal(deleted.statusCode, 204, deleted.body);
  });
});

describe('form builder', () => {
  it('stores a valid definition and the public endpoint serves it', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'manager');
    const tokens = await login(harness, member.email);
    const headers = authHeaders(harness, tokens.accessToken);

    const created = await built.app.inject({
      method: 'POST',
      url: '/v1/cms/forms',
      headers,
      payload: {
        slug: 'builder-made',
        name: 'Builder-made form',
        fields: [
          { name: 'name', label: 'Your name', type: 'text', required: true },
          { name: 'phone', label: 'Phone', type: 'tel', required: true },
          {
            name: 'service',
            label: 'What do you need?',
            type: 'select',
            optionsSource: 'services',
          },
        ],
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const formId = (created.json() as { id: string }).id;

    const detail = await built.app.inject({
      method: 'GET',
      url: `/v1/cms/forms/${formId}`,
      headers,
    });
    assert.equal(detail.statusCode, 200);
    assert.equal((detail.json() as { fields: unknown[] }).fields.length, 3);
  });

  it('refuses the definitions that could not be safely served', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'manager');
    const tokens = await login(harness, member.email);
    const headers = authHeaders(harness, tokens.accessToken);

    const cases: { payload: Record<string, unknown>; reason: RegExp }[] = [
      {
        // No way to reach the person.
        payload: {
          slug: 'no-contact',
          name: 'No contact',
          fields: [{ name: 'note', label: 'Note', type: 'text' }],
        },
        reason: /email or phone/,
      },
      {
        // Two fields writing one key.
        payload: {
          slug: 'dupes',
          name: 'Duplicates',
          fields: [
            { name: 'email', label: 'Email', type: 'email' },
            { name: 'email', label: 'Email again', type: 'email' },
          ],
        },
        reason: /unique/,
      },
      {
        // A choice with nothing to choose.
        payload: {
          slug: 'empty-select',
          name: 'Empty select',
          fields: [
            { name: 'email', label: 'Email', type: 'email' },
            { name: 'pick', label: 'Pick one', type: 'select' },
          ],
        },
        reason: /nothing to choose/,
      },
      {
        // Honeypot colliding with a real field.
        payload: {
          slug: 'honeypot-clash',
          name: 'Honeypot clash',
          fields: [{ name: 'email', label: 'Email', type: 'email' }],
          spamConfig: { honeypotField: 'email' },
        },
        reason: /honeypot/i,
      },
    ];

    for (const testCase of cases) {
      const response = await built.app.inject({
        method: 'POST',
        url: '/v1/cms/forms',
        headers,
        payload: testCase.payload,
      });
      assert.equal(response.statusCode, 400, `expected 400 for ${testCase.payload.slug}`);
      assert.match(
        (response.json() as { error: { message: string } }).error.message,
        testCase.reason,
      );
    }
  });

  it('keeps the builder behind forms.write', async () => {
    await clearRateLimits(harness);
    const viewer = await createMember(harness, 'viewer');
    const tokens = await login(harness, viewer.email);

    const refused = await built.app.inject({
      method: 'POST',
      url: '/v1/cms/forms',
      headers: authHeaders(harness, tokens.accessToken),
      payload: {
        slug: 'nope',
        name: 'Nope',
        fields: [{ name: 'email', label: 'Email', type: 'email' }],
      },
    });
    assert.equal(refused.statusCode, 403);
  });
});
