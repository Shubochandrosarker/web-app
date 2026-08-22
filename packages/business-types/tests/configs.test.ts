/**
 * Validates every tenant config in `configs/`.
 *
 * A malformed config is a deploy-time failure at best and a wrong phone number
 * in LocalBusiness schema at worst, so it is checked in CI rather than
 * discovered by whoever boots the site next. Adding a client adds a directory;
 * this test picks it up with no change here.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  checkProductionReadiness,
  resolveWorkspaceConfig,
  selectReadinessTenants,
  workspaceConfigSchema,
} from '../src/index.ts';

const configsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../configs');

const entries = await readdir(configsDir, { withFileTypes: true });
const tenants = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

describe('tenant configs', () => {
  it('finds at least one tenant', () => {
    assert.ok(tenants.length > 0, `no tenant directories in ${configsDir}`);
  });

  it('marks only the real production tenant as release eligible', async () => {
    const configs = await Promise.all(
      tenants.map(async (tenant) => {
        const raw = await readFile(join(configsDir, tenant, 'business.json'), 'utf8');
        const parsed = workspaceConfigSchema.parse(JSON.parse(raw));
        return { slug: tenant, releaseEligible: parsed.environment.releaseEligible };
      }),
    );

    assert.deepEqual(selectReadinessTenants(configs, undefined, true), ['nuesheba']);
    assert.deepEqual(selectReadinessTenants(configs, 'demo-consultancy', false), [
      'demo-consultancy',
    ]);
  });

  it('rejects an unknown explicit tenant instead of silently checking another one', () => {
    assert.throws(
      () => selectReadinessTenants([{ slug: 'nuesheba', releaseEligible: true }], 'missing', false),
      /Unknown tenant "missing"/,
    );
  });

  it('keeps placeholder production facts blocked', async () => {
    const raw = await readFile(join(configsDir, 'nuesheba', 'business.json'), 'utf8');
    const parsed = workspaceConfigSchema.parse(JSON.parse(raw));
    const report = checkProductionReadiness(resolveWorkspaceConfig(parsed));

    assert.equal(report.ready, false);
    assert.ok(report.findings.some((finding) => finding.path === 'nap.telephone'));
  });

  it('allows a release-eligible tenant once verified facts replace scaffolding', async () => {
    const raw = await readFile(join(configsDir, 'nuesheba', 'business.json'), 'utf8');
    const parsed = workspaceConfigSchema.parse(JSON.parse(raw));
    const verified = {
      ...parsed,
      nap: {
        ...parsed.nap,
        telephone: '+8801812345678',
        whatsapp: '+8801812345678',
        email: 'operations@nuesheba.bd',
        streetAddress: '12 Verified Road',
        sameAs: ['https://www.facebook.com/nuesheba'],
      },
      legal: {
        independenceDisclaimer:
          'NuESheba is an independent service provider and is not affiliated with National University.',
      },
    };
    const report = checkProductionReadiness(resolveWorkspaceConfig(verified));

    assert.equal(report.ready, true);
    assert.equal(report.blockers, 0);
  });

  for (const tenant of tenants) {
    it(`${tenant} is valid and resolves its modules`, async () => {
      const raw = await readFile(join(configsDir, tenant, 'business.json'), 'utf8');
      const parsed = workspaceConfigSchema.safeParse(JSON.parse(raw));

      assert.ok(
        parsed.success,
        parsed.success
          ? ''
          : parsed.error.issues
              .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
              .join('; '),
      );

      // The directory name is the slug the site loads by, so a mismatch would
      // mean BOS_WORKSPACE_SLUG resolves to a config describing someone else.
      assert.equal(parsed.data.slug, tenant, 'slug must match its directory name');

      const resolved = resolveWorkspaceConfig(parsed.data);
      assert.ok(
        resolved.enabledModules.includes('core.workspace'),
        'core modules must always resolve',
      );
      assert.ok(resolved.enabledModules.length > 0);
    });
  }
});
