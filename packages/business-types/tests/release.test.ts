import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  checkProductionReadiness,
  resolveWorkspaceConfig,
  selectReleaseTargets,
  workspaceConfigSchema,
  type WorkspaceConfig,
} from '../src/index.ts';

/**
 * The release-gate selection and the readiness policy, together: which
 * tenants gate a release, and what stops an eligible one from shipping.
 */

const configsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../configs');

async function loadConfig(slug: string): Promise<WorkspaceConfig> {
  const raw = await readFile(join(configsDir, slug, 'business.json'), 'utf8');
  return workspaceConfigSchema.parse(JSON.parse(raw));
}

/** A fully-valid production config, constructed in memory — no real facts. */
function validProductionConfig(): WorkspaceConfig {
  return workspaceConfigSchema.parse({
    slug: 'valid-tenant',
    businessType: 'education_service',
    siteUrl: 'https://valid-tenant.bd',
    brand: { name: 'Valid Tenant', tagline: 'A tagline', logoUrl: '/logo.svg' },
    nap: {
      legalName: 'Valid Tenant Ltd',
      displayName: 'Valid Tenant',
      streetAddress: '12 Real Street, Block C',
      addressLocality: 'Gazipur',
      addressCountry: 'BD',
      latitude: 23.99,
      longitude: 90.42,
      telephone: '+8801812345679',
      whatsapp: '+8801812345679',
      email: 'office@valid-tenant.bd',
      openingHours: ['Sa-Th 09:00-18:00'],
      sameAs: ['https://www.facebook.com/valid-tenant'],
      googleBusinessProfileUrl: 'https://maps.google.com/?cid=1',
    },
    locale: {
      defaultLocale: 'en',
      supportedLocales: ['en'],
      timeZone: 'Asia/Dhaka',
      currency: 'BDT',
      phoneCountryCode: '+880',
    },
    legal: {
      independenceDisclaimer:
        'Valid Tenant is an independent service provider and is not affiliated with any university.',
      privacyPolicyPath: '/privacy',
      termsPath: '/terms',
    },
    environment: { releaseEligible: true },
    features: { documentUpload: true, whatsappAcknowledgement: true },
  });
}

describe('release-target selection', () => {
  const tenants = [
    { slug: 'nuesheba', releaseEligible: true },
    { slug: 'demo-consultancy', releaseEligible: false },
  ];

  it('a fixture tenant is excluded from a platform release', () => {
    const selection = selectReleaseTargets(tenants, [], true);
    assert.deepEqual(selection.targets, ['nuesheba']);
    assert.deepEqual(selection.errors, []);
  });

  it('the production tenant is included', () => {
    const selection = selectReleaseTargets(tenants, ['nuesheba'], false);
    assert.deepEqual(selection.targets, ['nuesheba']);
    assert.deepEqual(selection.errors, []);
  });

  it('naming an unknown tenant fails loudly', () => {
    const selection = selectReleaseTargets(tenants, ['nuseheba-typo'], false);
    assert.deepEqual(selection.targets, []);
    assert.match(selection.errors[0] ?? '', /Unknown tenant/);
  });

  it('naming a fixture tenant for release fails loudly instead of skipping', () => {
    const selection = selectReleaseTargets(tenants, ['demo-consultancy'], false);
    assert.deepEqual(selection.targets, []);
    assert.match(selection.errors[0] ?? '', /not marked environment.releaseEligible/);
  });

  it('a bare sweep gates eligible tenants and only reports fixtures', () => {
    const selection = selectReleaseTargets(tenants, [], false);
    assert.deepEqual(selection.targets, ['nuesheba']);
    assert.deepEqual(selection.informational, ['demo-consultancy']);
  });

  it('a platform release with no eligible tenant is an error, not a green run', () => {
    const selection = selectReleaseTargets(
      [{ slug: 'demo-consultancy', releaseEligible: false }],
      [],
      true,
    );
    assert.ok(selection.errors.length > 0);
  });
});

describe('readiness policy', () => {
  it('the committed NuESheba config (placeholders) is blocked from release', async () => {
    const config = await loadConfig('nuesheba');
    assert.equal(config.environment.releaseEligible, true, 'nuesheba is the production tenant');
    const report = checkProductionReadiness(resolveWorkspaceConfig(config));
    assert.equal(report.ready, false);
    assert.ok(report.blockers > 0, 'placeholder facts block the launch');
    const paths = report.findings.map((finding) => finding.path);
    assert.ok(paths.includes('nap.telephone'));
    assert.ok(paths.includes('legal.independenceDisclaimer'), 'the disclaimer is a blocker');
    assert.ok(paths.includes('legal.privacyPolicyPath'), 'document upload demands a policy');
  });

  it('the demo fixture is marked ineligible so its placeholders cannot gate anything', async () => {
    const config = await loadConfig('demo-consultancy');
    assert.equal(config.environment.releaseEligible, false);
    const report = checkProductionReadiness(resolveWorkspaceConfig(config));
    assert.ok(report.blockers > 0, 'the fixture is (deliberately) full of placeholders');
    const paths = report.findings.map((finding) => finding.path);
    assert.ok(paths.includes('siteUrl'), 'the example.com fixture domain is detected');
  });

  it('a production tenant with fully valid configuration passes with zero blockers', () => {
    const report = checkProductionReadiness(resolveWorkspaceConfig(validProductionConfig()));
    assert.equal(report.blockers, 0, JSON.stringify(report.findings, null, 2));
    assert.equal(report.ready, true);
  });

  it('enabling WhatsApp acknowledgements without a number is a blocker', () => {
    const config = validProductionConfig();
    const broken = workspaceConfigSchema.parse({
      ...config,
      nap: { ...config.nap, whatsapp: undefined },
    });
    const report = checkProductionReadiness(resolveWorkspaceConfig(broken));
    assert.ok(report.findings.some((finding) => finding.path === 'nap.whatsapp'));
    assert.equal(report.ready, false);
  });
});
