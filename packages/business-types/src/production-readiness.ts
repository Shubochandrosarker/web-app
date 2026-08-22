import type { ResolvedWorkspaceConfig } from './workspace-config.ts';

/**
 * Production readiness of a tenant configuration.
 *
 * The problem this exists for: `configs/nuesheba/business.json` shipped with
 * `+8801700000000`, `hello@nuesheba.com` and an empty `sameAs`. Every one of
 * those would have gone straight into LocalBusiness structured data and the
 * site footer — and a phone number that does not ring, published as the
 * business's NAP, is worse than no structured data at all. Search engines
 * cross-reference NAP against directories and a Google Business Profile;
 * publishing a placeholder actively damages the entity consistency the whole
 * SEO architecture depends on.
 *
 * So placeholders are detected rather than trusted, and the launch gate fails
 * on them. This does **not** invent replacements: the correct values are facts
 * about a business that only the business knows.
 */

export type Severity = 'blocker' | 'warning';

export interface ReadinessFinding {
  readonly severity: Severity;
  /** Dotted path into the config, e.g. `nap.telephone`. */
  readonly path: string;
  readonly message: string;
  readonly remedy: string;
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly findings: readonly ReadinessFinding[];
  readonly blockers: number;
  readonly warnings: number;
}

/**
 * Values that are obviously not real.
 *
 * Patterns rather than an exact list, because the next placeholder somebody
 * types will not be one of the ones already written down. A run of repeated
 * digits, an example domain, and the words people reach for when filling a
 * form they intend to come back to.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\b(example|test|sample|placeholder|dummy|changeme|todo|tbd|xxx+)\b/i,
  /example\.(com|org|net)$/i,
  /@(example|test|localhost)\./i,
  // +8801700000000, +12345678901, 000-000-0000 — a run of five or more of the
  // same digit is not a phone number anybody answers.
  /(\d)\1{4,}/,
  /^\+?1?234567/,
  /\byour[-_ ]?(business|company|name|email|phone)\b/i,
  /lorem ipsum/i,
];

/**
 * The exact values the scaffold shipped with.
 *
 * A pattern cannot catch every placeholder: `hello@nuesheba.com` is a
 * perfectly plausible address, and the only reason to distrust it is that it
 * was typed as a stand-in rather than taken from the business. Listing the
 * committed scaffold values by hand covers that case precisely, without
 * inventing a heuristic that would reject real addresses.
 *
 * A value leaves this list when the business confirms it is real — which is a
 * one-line change somebody makes deliberately, and a line a reviewer sees.
 */
const SCAFFOLD_VALUES: readonly string[] = [
  '+8801700000000',
  'hello@nuesheba.com',
  'National University Gate',
];

function looksLikePlaceholder(value: string): boolean {
  if (SCAFFOLD_VALUES.some((scaffold) => scaffold.toLowerCase() === value.trim().toLowerCase())) {
    return true;
  }
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Check a resolved tenant configuration.
 *
 * A **blocker** is something that would publish a falsehood or break a
 * conversion path: a phone number nobody answers, an address that is not the
 * business's. A **warning** is something absent that should be present before
 * launch but harms nothing by being missing.
 */
export function checkProductionReadiness(config: ResolvedWorkspaceConfig): ReadinessReport {
  const findings: ReadinessFinding[] = [];

  const blocker = (path: string, message: string, remedy: string): void => {
    findings.push({ severity: 'blocker', path, message, remedy });
  };
  const warning = (path: string, message: string, remedy: string): void => {
    findings.push({ severity: 'warning', path, message, remedy });
  };

  const { nap, brand, siteUrl, legal } = config;

  /* ------------------------------------------------------------------ NAP */

  /*
   * Name, address and phone are the three facts every local-SEO signal is
   * keyed on, and they must match the Google Business Profile character for
   * character. A placeholder here is not a cosmetic problem.
   */
  if (looksLikePlaceholder(nap.telephone)) {
    blocker(
      'nap.telephone',
      `The telephone number "${nap.telephone}" looks like a placeholder.`,
      'Set the number the business actually answers, in E.164 form (+880…).',
    );
  }

  if (nap.whatsapp && looksLikePlaceholder(nap.whatsapp)) {
    blocker(
      'nap.whatsapp',
      `The WhatsApp number "${nap.whatsapp}" looks like a placeholder.`,
      'Set the WhatsApp Business number, or remove the field if there is none.',
    );
  }

  if (config.features.whatsappAcknowledgement === true && !nap.whatsapp) {
    blocker(
      'nap.whatsapp',
      'WhatsApp acknowledgements are enabled but no WhatsApp number is configured.',
      'Set nap.whatsapp, or turn features.whatsappAcknowledgement off explicitly.',
    );
  }

  if (looksLikePlaceholder(nap.email)) {
    blocker(
      'nap.email',
      `The email address "${nap.email}" looks like a placeholder.`,
      'Set a monitored address. It appears in the footer and receives lead notifications.',
    );
  }

  if (looksLikePlaceholder(nap.streetAddress) || nap.streetAddress.length < 8) {
    blocker(
      'nap.streetAddress',
      `The street address "${nap.streetAddress}" is not a deliverable address.`,
      'Set the address exactly as it appears on the Google Business Profile.',
    );
  }

  if (looksLikePlaceholder(nap.legalName) || looksLikePlaceholder(nap.displayName)) {
    blocker(
      'nap.legalName',
      'The business name looks like a placeholder.',
      'Set the registered name and the trading name. They are often different.',
    );
  }

  if (nap.openingHours.length === 0) {
    blocker(
      'nap.openingHours',
      'No opening hours are set.',
      'Add schema.org opening-hours strings, e.g. "Sa-Th 09:00-18:00". Visitors ' +
        'and LocalBusiness structured data both need them.',
    );
  }

  /*
   * Coordinates are a warning rather than a blocker: a LocalBusiness node is
   * valid without them, and a *wrong* pin is worse than no pin.
   */
  if (nap.latitude === undefined || nap.longitude === undefined) {
    warning(
      'nap.latitude',
      'No coordinates are set, so the location sections cannot link to a map.',
      'Take them from the Google Business Profile listing rather than a geocoder.',
    );
  }

  if (nap.sameAs.length === 0) {
    blocker(
      'nap.sameAs',
      'No `sameAs` entries. The Organization node claims an entity with no ' +
        'corroborating profiles anywhere.',
      'Add the verified Facebook page, the Google Business Profile and any other ' +
        'profile the business actually controls. Never a profile it does not.',
    );
  }

  if (!nap.googleBusinessProfileUrl) {
    warning(
      'nap.googleBusinessProfileUrl',
      'No Google Business Profile URL.',
      'Local search visibility for a service business is mostly this. Claim the ' +
        'profile before launch.',
    );
  }

  /* ---------------------------------------------------------------- brand */

  if (looksLikePlaceholder(brand.name)) {
    blocker('brand.name', 'The brand name looks like a placeholder.', 'Set the trading name.');
  }

  if (!brand.logoUrl) {
    warning(
      'brand.logoUrl',
      'No logo. The Organization node has no `logo`, and social shares have no image.',
      'Upload a square logo of at least 112×112 and set its URL.',
    );
  }

  if (!brand.tagline) {
    warning(
      'brand.tagline',
      'No tagline, so pages with no meta description of their own have no fallback.',
      'One sentence saying what the business does.',
    );
  }

  /* ------------------------------------------------------------------ URL */

  if (looksLikePlaceholder(siteUrl)) {
    blocker(
      'siteUrl',
      `The site URL "${siteUrl}" looks like a fixture domain.`,
      'Set the real production origin. Canonicals, sitemaps and structured data are built from it.',
    );
  }

  if (siteUrl.startsWith('http://')) {
    blocker(
      'siteUrl',
      'The canonical site URL is not HTTPS.',
      'Every canonical, sitemap entry and structured-data id is built from this.',
    );
  }

  if (siteUrl.endsWith('/')) {
    blocker(
      'siteUrl',
      'The canonical site URL has a trailing slash, which produces double slashes ' +
        'in every generated URL.',
      'Remove it.',
    );
  }

  /* ---------------------------------------------------------------- legal */

  /*
   * An education service that helps people obtain documents from a university
   * must not be mistakable for that university. For this business type the
   * disclaimer is a launch blocker, not a nicety: publishing without it is a
   * legal-identity risk the platform must not take on the owner's behalf.
   * The wording itself is the owner's — the gate only requires that it exists.
   */
  if (config.businessType === 'education_service' && !legal.independenceDisclaimer) {
    blocker(
      'legal.independenceDisclaimer',
      'No independence disclaimer, on a business type that assists with an ' +
        "institution's documents.",
      'State plainly that the business is an independent service provider and not ' +
        'affiliated with the institution. It goes in the footer of every page.',
    );
  }

  /*
   * A business that invites people to upload personal documents owes them a
   * privacy/data-handling policy before it goes live.
   */
  if (config.features.documentUpload === true && !legal.privacyPolicyPath) {
    blocker(
      'legal.privacyPolicyPath',
      'Document upload is enabled but no privacy/data-handling policy page is configured.',
      'Publish the policy page and set legal.privacyPolicyPath to its path.',
    );
  }

  const blockers = findings.filter((finding) => finding.severity === 'blocker').length;
  const warnings = findings.length - blockers;

  return { ready: blockers === 0, findings, blockers, warnings };
}

/** Render a report for a terminal. */
export function formatReadinessReport(report: ReadinessReport, slug: string): string {
  const lines: string[] = [];

  lines.push(`Production readiness — ${slug}`);
  lines.push('');

  if (report.findings.length === 0) {
    lines.push('  No findings. The configuration carries no placeholder values.');
    return lines.join('\n');
  }

  for (const severity of ['blocker', 'warning'] as const) {
    const matching = report.findings.filter((finding) => finding.severity === severity);
    if (matching.length === 0) continue;

    lines.push(severity === 'blocker' ? 'BLOCKERS' : 'WARNINGS');
    for (const finding of matching) {
      lines.push(`  ${finding.path}`);
      lines.push(`    ${finding.message}`);
      lines.push(`    → ${finding.remedy}`);
      lines.push('');
    }
  }

  lines.push(
    report.ready
      ? `Ready to launch, with ${report.warnings} warning(s) to review.`
      : `Not ready: ${report.blockers} blocker(s) must be resolved before this ` +
          'configuration reaches production.',
  );

  return lines.join('\n');
}
