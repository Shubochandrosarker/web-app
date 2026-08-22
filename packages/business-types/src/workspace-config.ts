import { z } from 'zod';
import { email, localeCode, phoneE164, slug, timeZone, url, currencyCode } from '@bos/validation';
import { MODULE_IDS, resolveEnabledModules, type ModuleId } from './modules.ts';
import { BUSINESS_TYPES, BUSINESS_TYPE_PRESETS, type BusinessType } from './business-types.ts';

/**
 * The tenant configuration file. One of these per business, checked into
 * `configs/<slug>/`. It is the only place a business name, address or phone
 * number is written down — the footer, the contact page, LocalBusiness schema
 * and email signatures all read from here, so they cannot disagree.
 */

export const napSchema = z.object({
  legalName: z.string().min(1),
  displayName: z.string().min(1),
  streetAddress: z.string().min(1),
  addressLocality: z.string().min(1),
  addressRegion: z.string().optional(),
  postalCode: z.string().optional(),
  /** ISO 3166-1 alpha-2. */
  addressCountry: z.string().regex(/^[A-Z]{2}$/),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  telephone: phoneE164,
  whatsapp: phoneE164.optional(),
  email,
  /** Machine-readable opening hours, e.g. "Sa-Th 09:00-18:00". */
  openingHours: z.array(z.string()).default([]),
  /** Named service areas when the business serves beyond its address. */
  areaServed: z.array(z.string()).default([]),
  sameAs: z.array(url).default([]),
  googleBusinessProfileUrl: url.optional(),
});

export const brandSchema = z.object({
  name: z.string().min(1),
  tagline: z.string().optional(),
  logoUrl: z.string().optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});

/**
 * Legal and disclosure text.
 *
 * Separate from `features` because it is not a switch. A service that helps
 * people obtain documents from an institution must not be mistakable for that
 * institution, and the wording of that disclaimer is a legal decision the
 * business makes — so it is text they own, rendered verbatim, not a boolean
 * that selects between phrasings the platform invented.
 */
export const legalSchema = z.object({
  /** Rendered in the footer of every page when present. */
  independenceDisclaimer: z.string().max(600).optional(),
  /** Shown alongside the copyright line. */
  registrationNumber: z.string().max(120).optional(),
  privacyPolicyPath: z.string().max(2048).optional(),
  termsPath: z.string().max(2048).optional(),
});

export const localeSettingsSchema = z.object({
  defaultLocale: localeCode,
  supportedLocales: z.array(localeCode).min(1),
  timeZone,
  currency: currencyCode,
  /**
   * E.164 dialing prefix applied to locally-formatted phone numbers on this
   * tenant's public forms (e.g. `+880` turns `01712…` into `+8801712…`).
   * Without it, only full international numbers are accepted — core code
   * carries no country assumption of its own.
   */
  phoneCountryCode: z
    .string()
    .regex(/^\+\d{1,4}$/)
    .optional(),
});

export const workspaceConfigSchema = z
  .object({
    slug,
    businessType: z.enum(BUSINESS_TYPES),
    /** Canonical origin, no trailing slash. Drives canonicals and sitemaps. */
    siteUrl: url,
    brand: brandSchema,
    nap: napSchema,
    locale: localeSettingsSchema,
    legal: legalSchema.default({}),
    /**
     * Modules on top of the business-type preset. Dependencies are resolved
     * automatically — listing `ops.scheduling` also enables `ops.services`.
     */
    modules: z.array(z.enum(MODULE_IDS)).default([]),
    /** Modules from the preset to switch off for this specific business. */
    disabledModules: z.array(z.enum(MODULE_IDS)).default([]),
    features: z.record(z.string(), z.boolean()).default({}),
  })
  .strict();

export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;
export type Nap = z.infer<typeof napSchema>;
export type Legal = z.infer<typeof legalSchema>;

export interface ResolvedWorkspaceConfig extends WorkspaceConfig {
  readonly enabledModules: readonly ModuleId[];
}

/**
 * Merge the business-type preset with per-workspace overrides and expand
 * dependencies. `disabledModules` is applied last and wins over the preset,
 * but cannot remove a module another enabled module depends on.
 */
export function resolveWorkspaceConfig(config: WorkspaceConfig): ResolvedWorkspaceConfig {
  const preset = BUSINESS_TYPE_PRESETS[config.businessType as BusinessType];
  const disabled = new Set<ModuleId>(config.disabledModules);

  const requested = [...preset.defaultModules, ...config.modules].filter((id) => !disabled.has(id));
  const enabledModules = resolveEnabledModules(requested);

  const reAdded = enabledModules.filter((id) => disabled.has(id));
  if (reAdded.length > 0) {
    throw new Error(
      `Workspace "${config.slug}" disables ${reAdded.join(', ')}, but ${reAdded.length === 1 ? 'it is' : 'they are'} required by another enabled module.`,
    );
  }

  return { ...config, enabledModules };
}

export function hasModule(config: ResolvedWorkspaceConfig, moduleId: ModuleId): boolean {
  return config.enabledModules.includes(moduleId);
}
