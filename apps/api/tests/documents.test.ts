import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import { schema, withoutTenantScope } from '@bos/database';
import { buildApp, type BuiltApp } from '../src/app.ts';
import type { Storage, SignedUpload } from '../src/providers/storage.ts';
import type { DocumentScanner, ScanVerdict } from '../src/providers/scanner.ts';
import { sweepExpiredDocuments } from '../src/routes/documents.ts';
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
 * The private-document lifecycle, end to end, against a real database and an
 * in-memory storage double that honours the Storage contract:
 *
 *   authorise → PUT → confirm (verify + scan) → attach by claim → download
 *
 * The double exists because the properties under test — claim-token
 * ownership, magic-byte verification, scan gating, retention — are
 * *platform* properties, not R2 properties. The R2 client is four SDK calls
 * that the deploy smoke test exercises.
 */

/** Storage double: a bucket in a Map. */
class MemoryStorage implements Storage {
  readonly configured = true;
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async signPrivateUpload(input: {
    objectKey: string;
    contentType: string;
    contentLength: number;
  }): Promise<SignedUpload> {
    return {
      url: `memory://upload/${input.objectKey}`,
      objectKey: input.objectKey,
      expiresInSeconds: 300,
      requiredHeaders: { 'content-type': input.contentType },
    };
  }

  /** The test's stand-in for the browser's PUT. */
  put(objectKey: string, bytes: Uint8Array, contentType: string): void {
    this.objects.set(objectKey, { bytes, contentType });
  }

  async signPrivateDownload(input: {
    objectKey: string;
    filename: string;
  }): Promise<{ url: string; expiresAt: Date }> {
    return {
      url: `memory://download/${input.objectKey}`,
      expiresAt: new Date(Date.now() + 300_000),
    };
  }

  async headPrivateObject(
    objectKey: string,
  ): Promise<{ sizeBytes: number; contentType: string } | null> {
    const object = this.objects.get(objectKey);
    return object ? { sizeBytes: object.bytes.length, contentType: object.contentType } : null;
  }

  async getPrivateObjectBytes(objectKey: string, maxBytes: number): Promise<Uint8Array | null> {
    const object = this.objects.get(objectKey);
    return object ? object.bytes.subarray(0, maxBytes) : null;
  }

  async putPublicObject(): Promise<void> {
    throw new Error('not used here');
  }

  async deletePrivateObject(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
  }

  async deletePublicObject(): Promise<void> {
    throw new Error('not used here');
  }
}

/** Scanner double whose next verdict the test chooses. */
class ScriptedScanner implements DocumentScanner {
  readonly kind = 'stub' as const;
  next: ScanVerdict = { outcome: 'clean', scanner: 'stub' };

  async scan(): Promise<ScanVerdict> {
    return this.next;
  }
}

/** A tiny but genuine PDF header, enough to pass signature checks. */
const PDF_BYTES = new Uint8Array(Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n'));
/** Marked with a Windows-executable signature. */
const EXE_BYTES = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

let harness: Harness;
let storage: MemoryStorage;
let scanner: ScriptedScanner;
let built: BuiltApp;

before(async () => {
  harness = await createHarness();
  storage = new MemoryStorage();
  scanner = new ScriptedScanner();
  built = buildApp({
    config: testConfig({
      // Present so `storage.configured` gates open; the double replaces it.
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
    scanner,
  });
  await built.app.ready();
  await seedPipeline(harness);
  await seedForm(harness);
});

after(async () => {
  await built?.app.close();
  await harness?.close();
});

interface UploadGrant {
  documentId: string;
  claimToken: string;
  uploadUrl: string;
}

async function authoriseUpload(
  overrides: Partial<{ filename: string; contentType: string; contentLength: number }> = {},
): Promise<UploadGrant> {
  const response = await built.app.inject({
    method: 'POST',
    url: '/v1/documents/upload-url',
    payload: {
      workspace: harness.workspaceSlug,
      filename: overrides.filename ?? 'transcript.pdf',
      contentType: overrides.contentType ?? 'application/pdf',
      contentLength: overrides.contentLength ?? PDF_BYTES.length,
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json() as UploadGrant;
}

function objectKeyOf(grant: UploadGrant): string {
  return grant.uploadUrl.replace('memory://upload/', '');
}

async function confirm(grant: UploadGrant, claimToken = grant.claimToken) {
  return built.app.inject({
    method: 'POST',
    url: `/v1/documents/${grant.documentId}/confirm`,
    payload: { workspace: harness.workspaceSlug, claimToken },
  });
}

async function documentRow(id: string) {
  return withoutTenantScope(harness.db, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.id, id))
      .limit(1);
    return row;
  });
}

describe('upload authorisation', () => {
  it('issues a one-shot claim token and starts the document at pending_upload', async () => {
    await clearRateLimits(harness);
    const grant = await authoriseUpload();

    assert.ok(grant.claimToken.length > 20, 'a claim token is returned once');
    const row = await documentRow(grant.documentId);
    assert.equal(row?.status, 'pending_upload');
    assert.ok(row?.claimTokenHash, 'only the hash is stored');
    assert.notEqual(row?.claimTokenHash, grant.claimToken);
  });

  it('refuses a type outside the allow-list, SVG included', async () => {
    await clearRateLimits(harness);
    const response = await built.app.inject({
      method: 'POST',
      url: '/v1/documents/upload-url',
      payload: {
        workspace: harness.workspaceSlug,
        filename: 'sneaky.svg',
        contentType: 'image/svg+xml',
        contentLength: 512,
      },
    });
    assert.equal(response.statusCode, 400);
  });
});

describe('confirm: verification and scanning', () => {
  it('accepts a genuine PDF and marks it clean', async () => {
    await clearRateLimits(harness);
    scanner.next = { outcome: 'clean', scanner: 'stub' };

    const grant = await authoriseUpload();
    storage.put(objectKeyOf(grant), PDF_BYTES, 'application/pdf');

    const response = await confirm(grant);
    assert.equal(response.statusCode, 200);
    assert.equal((response.json() as { status: string }).status, 'clean');

    const row = await documentRow(grant.documentId);
    assert.equal(row?.status, 'clean');
    assert.ok(row?.verifiedAt, 'verification is stamped');
    assert.ok(row?.scannedAt, 'the scan is stamped');
    assert.equal(row?.checksumSha256.length, 64, 'the real checksum is recorded');
  });

  it('rejects an executable wearing a PDF content type, and deletes the object', async () => {
    await clearRateLimits(harness);
    const grant = await authoriseUpload({ contentLength: EXE_BYTES.length });
    storage.put(objectKeyOf(grant), EXE_BYTES, 'application/pdf');

    const response = await confirm(grant);
    assert.equal(response.statusCode, 422);
    const body = response.json() as { status: string; reason: string };
    assert.equal(body.status, 'rejected');
    assert.equal(body.reason, 'type_mismatch');

    const row = await documentRow(grant.documentId);
    assert.equal(row?.status, 'rejected');
    assert.equal(storage.objects.has(objectKeyOf(grant)), false, 'the object is gone from storage');
    assert.equal(
      (row?.scanResult as { detected?: string }).detected,
      'application/x-msdownload',
      'the rejection records what the bytes actually were',
    );
  });

  it('rejects an object whose real size disagrees with the declaration', async () => {
    await clearRateLimits(harness);
    const grant = await authoriseUpload({ contentLength: 4096 });
    storage.put(objectKeyOf(grant), PDF_BYTES, 'application/pdf');

    const response = await confirm(grant);
    assert.equal(response.statusCode, 422);
    assert.equal((response.json() as { reason: string }).reason, 'size_mismatch');
  });

  it('rejects an infected file on the scanner’s verdict and deletes the object', async () => {
    await clearRateLimits(harness);
    scanner.next = { outcome: 'infected', scanner: 'stub', signature: 'Eicar-Test-Signature' };

    const grant = await authoriseUpload();
    storage.put(objectKeyOf(grant), PDF_BYTES, 'application/pdf');

    const response = await confirm(grant);
    assert.equal(response.statusCode, 422);
    assert.equal((response.json() as { reason: string }).reason, 'infected');

    const row = await documentRow(grant.documentId);
    assert.equal(row?.status, 'rejected');
    assert.equal(storage.objects.has(objectKeyOf(grant)), false);
    assert.equal((row?.scanResult as { signature?: string }).signature, 'Eicar-Test-Signature');
    scanner.next = { outcome: 'clean', scanner: 'stub' };
  });

  it('leaves the document in scanning — undownloadable — when the scanner errors', async () => {
    await clearRateLimits(harness);
    scanner.next = { outcome: 'error', scanner: 'stub', reason: 'daemon unreachable' };

    const grant = await authoriseUpload();
    storage.put(objectKeyOf(grant), PDF_BYTES, 'application/pdf');

    const response = await confirm(grant);
    assert.equal(response.statusCode, 200);
    assert.equal((response.json() as { status: string }).status, 'scanning');

    const row = await documentRow(grant.documentId);
    assert.equal(row?.status, 'scanning');
    scanner.next = { outcome: 'clean', scanner: 'stub' };
  });

  it('refuses a wrong claim token with the same not-found as a wrong id', async () => {
    await clearRateLimits(harness);
    const grant = await authoriseUpload();
    storage.put(objectKeyOf(grant), PDF_BYTES, 'application/pdf');

    const wrongToken = await confirm(grant, 'not-the-claim-token-at-all');
    assert.equal(wrongToken.statusCode, 404);

    // The right token still works afterwards — a failed guess spends nothing.
    const rightToken = await confirm(grant);
    assert.equal(rightToken.statusCode, 200);
  });
});

describe('attachment by claim', () => {
  async function submitWithClaims(
    claims: { documentId: string; claimToken: string }[],
    phone: string,
  ) {
    return built.app.inject({
      method: 'POST',
      url: `/v1/forms/service-request/submissions?workspace=${harness.workspaceSlug}`,
      payload: {
        values: {
          name: 'Document Uploader',
          phone,
          message: 'Attaching my transcript to this request.',
        },
        consent: true,
        elapsedMs: 8000,
        documentClaims: claims,
      },
    });
  }

  it('attaches a clean document to the lead created by the submission', async () => {
    await clearRateLimits(harness);
    scanner.next = { outcome: 'clean', scanner: 'stub' };

    const grant = await authoriseUpload();
    storage.put(objectKeyOf(grant), PDF_BYTES, 'application/pdf');
    await confirm(grant);

    const submitted = await submitWithClaims(
      [{ documentId: grant.documentId, claimToken: grant.claimToken }],
      '+8801712345610',
    );
    assert.equal(submitted.statusCode, 201, submitted.body);

    const row = await documentRow(grant.documentId);
    assert.ok(row?.leadId, 'the document belongs to the lead');
    assert.ok(row?.contactId, 'and to the contact');
    assert.equal(row?.claimTokenHash, null, 'the claim token is spent by the attachment');
  });

  it('will not attach with a bare document id and the wrong token', async () => {
    await clearRateLimits(harness);
    const grant = await authoriseUpload();
    storage.put(objectKeyOf(grant), PDF_BYTES, 'application/pdf');
    await confirm(grant);

    const submitted = await submitWithClaims(
      [{ documentId: grant.documentId, claimToken: 'a-guessed-token' }],
      '+8801712345611',
    );
    // The submission itself succeeds — the enquiry is real — but nothing
    // attaches.
    assert.equal(submitted.statusCode, 201);

    const row = await documentRow(grant.documentId);
    assert.equal(row?.leadId, null, 'a guessed token attaches nothing');
  });

  it('will not let a second submission steal an already-attached document', async () => {
    await clearRateLimits(harness);
    const grant = await authoriseUpload();
    storage.put(objectKeyOf(grant), PDF_BYTES, 'application/pdf');
    await confirm(grant);

    const first = await submitWithClaims(
      [{ documentId: grant.documentId, claimToken: grant.claimToken }],
      '+8801712345612',
    );
    assert.equal(first.statusCode, 201);
    const attachedTo = (await documentRow(grant.documentId))?.leadId;
    assert.ok(attachedTo);

    const second = await submitWithClaims(
      [{ documentId: grant.documentId, claimToken: grant.claimToken }],
      '+8801712345613',
    );
    assert.equal(second.statusCode, 201);

    const row = await documentRow(grant.documentId);
    assert.equal(row?.leadId, attachedTo, 'the document stays with its first lead');
  });
});

describe('download gating', () => {
  it('mints a URL only for clean documents, audits it, and refuses the rest', async () => {
    await clearRateLimits(harness);
    const member = await createMember(harness, 'manager');
    const tokens = await login(harness, member.email);
    const headers = authHeaders(harness, tokens.accessToken);

    // A clean document downloads, and the access log gets the row first.
    scanner.next = { outcome: 'clean', scanner: 'stub' };
    const cleanGrant = await authoriseUpload();
    storage.put(objectKeyOf(cleanGrant), PDF_BYTES, 'application/pdf');
    await confirm(cleanGrant);

    const allowed = await built.app.inject({
      method: 'POST',
      url: `/v1/documents/${cleanGrant.documentId}/download-url`,
      headers,
    });
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.ok((allowed.json() as { url: string }).url);

    const audits = await withoutTenantScope(harness.db, (tx) =>
      tx
        .select()
        .from(schema.documentAccessLog)
        .where(eq(schema.documentAccessLog.documentId, cleanGrant.documentId)),
    );
    assert.ok(
      audits.some((entry) => entry.action === 'url_issued'),
      'the issuance is logged',
    );

    // A document still in scanning is refused, and the refusal is logged too.
    scanner.next = { outcome: 'error', scanner: 'stub', reason: 'down' };
    const scanningGrant = await authoriseUpload();
    storage.put(objectKeyOf(scanningGrant), PDF_BYTES, 'application/pdf');
    await confirm(scanningGrant);
    scanner.next = { outcome: 'clean', scanner: 'stub' };

    const denied = await built.app.inject({
      method: 'POST',
      url: `/v1/documents/${scanningGrant.documentId}/download-url`,
      headers,
    });
    assert.equal(denied.statusCode, 409);

    const denialAudits = await withoutTenantScope(harness.db, (tx) =>
      tx
        .select()
        .from(schema.documentAccessLog)
        .where(eq(schema.documentAccessLog.documentId, scanningGrant.documentId)),
    );
    assert.ok(
      denialAudits.some((entry) => entry.action === 'denied'),
      'the denial is logged',
    );
  });

  it('staff without documents.download cannot mint a URL at all', async () => {
    await clearRateLimits(harness);
    const staff = await createMember(harness, 'staff');
    const tokens = await login(harness, staff.email);

    scanner.next = { outcome: 'clean', scanner: 'stub' };
    const grant = await authoriseUpload();
    storage.put(objectKeyOf(grant), PDF_BYTES, 'application/pdf');
    await confirm(grant);

    const refused = await built.app.inject({
      method: 'POST',
      url: `/v1/documents/${grant.documentId}/download-url`,
      headers: authHeaders(harness, tokens.accessToken),
    });
    assert.equal(refused.statusCode, 403, 'seeing a document and opening it are separate grants');
  });
});

describe('retention', () => {
  it('sweeps expired documents: object first, then the row', async () => {
    await clearRateLimits(harness);
    const grant = await authoriseUpload();
    storage.put(objectKeyOf(grant), PDF_BYTES, 'application/pdf');

    // Backdate the retention deadline: an abandoned pending upload.
    await withoutTenantScope(harness.db, (tx) =>
      tx
        .update(schema.documents)
        .set({ retainUntil: new Date(Date.now() - 3600_000) })
        .where(eq(schema.documents.id, grant.documentId)),
    );

    const result = await sweepExpiredDocuments(built.context);
    assert.ok(result.swept >= 1);

    const row = await documentRow(grant.documentId);
    assert.equal(row?.status, 'expired');
    assert.equal(storage.objects.has(objectKeyOf(grant)), false, 'the object is deleted');

    // And an expired document can never be downloaded again. The sweep
    // soft-deletes the row, so it is absent (404) rather than described
    // (410) — rejected documents keep their 410 because staff still see
    // them in the dashboard with the rejection reason.
    const member = await createMember(harness, 'manager');
    const tokens = await login(harness, member.email);
    const gone = await built.app.inject({
      method: 'POST',
      url: `/v1/documents/${grant.documentId}/download-url`,
      headers: authHeaders(harness, tokens.accessToken),
    });
    assert.equal(gone.statusCode, 404);
  });
});
