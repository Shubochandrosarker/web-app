import { z } from 'zod';
import { safeAbsoluteUrl, safeHref } from '@bos/sanitize/url';

/**
 * Data a page's sections refer to by id.
 *
 * A `service-grid` section stores service ids, not service names and prices;
 * a `locations` section stores location ids, not addresses. Something has to
 * turn those into renderable data, and the choice is between the renderer
 * fetching per section — fourteen round trips on a service page — or the
 * content response carrying them.
 *
 * It carries them. The provider resolves every reference on the page in one
 * pass, which keeps the render path free of I/O and means a section renderer
 * is a pure function of props plus this bag.
 *
 * Every shape here is a *projection*, not a table row: a resolved service has
 * the four fields a card needs and not the twenty a service has. What is
 * absent is as deliberate as what is present — nothing internal, nothing
 * editorial, nothing a competitor could not read off the page anyway.
 */

export const resolvedMediaSchema = z.object({
  id: z.uuid(),
  url: safeAbsoluteUrl,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  mimeType: z.string().max(140),
  /** The asset's own description; a usage's own alt text overrides it. */
  alt: z.string().max(300).optional(),
  blurDataUrl: z.string().max(4096).optional(),
});

export const resolvedServiceSchema = z.object({
  id: z.uuid(),
  slug: z.string().max(140),
  name: z.string().max(200),
  summary: z.string().max(2000).optional(),
  path: z.string().max(2048).optional(),
  priceAmount: z.number().int().nonnegative().optional(),
  priceCurrency: z.string().max(3).optional(),
  priceNote: z.string().max(200).optional(),
  turnaroundNote: z.string().max(200).optional(),
  requirements: z.array(z.string().max(300)).default([]),
});

export const resolvedPersonSchema = z.object({
  id: z.uuid(),
  name: z.string().max(200),
  role: z.string().max(200).optional(),
  bio: z.string().max(2000).optional(),
  media: resolvedMediaSchema.optional(),
});

export const resolvedLocationSchema = z.object({
  id: z.uuid(),
  slug: z.string().max(140),
  displayName: z.string().max(200),
  streetAddress: z.string().max(500),
  addressLocality: z.string().max(140),
  addressRegion: z.string().max(140).optional(),
  postalCode: z.string().max(30).optional(),
  addressCountry: z.string().max(2),
  telephone: z.string().max(20),
  whatsapp: z.string().max(20).optional(),
  email: z.string().max(320),
  openingHours: z.array(z.string().max(120)).default([]),
  latitude: z.string().max(32).optional(),
  longitude: z.string().max(32).optional(),
  mapUrl: safeAbsoluteUrl.optional(),
});

/**
 * A review as published.
 *
 * `rating` and `authorName` come from the reputation module, which sources
 * them from a real platform or a verified internal submission. There is no
 * write path from the CMS into this shape, which is what stops invented
 * ratings from becoming Review structured data.
 */
export const resolvedReviewSchema = z.object({
  id: z.uuid(),
  authorName: z.string().max(200),
  rating: z.number().min(1).max(5),
  body: z.string().max(4000),
  publishedAt: z.iso.datetime({ offset: true }),
  source: z.enum(['internal', 'google', 'facebook', 'other']),
  sourceUrl: safeAbsoluteUrl.optional(),
});

export const resolvedRelatedEntrySchema = z.object({
  id: z.uuid(),
  title: z.string().max(300),
  path: z.string().max(2048),
  type: z.string().max(64),
  excerpt: z.string().max(600).optional(),
  media: resolvedMediaSchema.optional(),
});

/**
 * A form definition as the public renderer sees it.
 *
 * Notice there is no notification address, no outcome configuration and no
 * spam settings — the honeypot's field name is the one exception, because the
 * browser has to render it to be fooled by it. Everything else about how a
 * submission is handled stays server-side.
 */
export const resolvedFormFieldSchema = z.object({
  name: z.string().max(64),
  label: z.string().max(200),
  type: z.enum([
    'text',
    'email',
    'tel',
    'textarea',
    'select',
    'checkbox',
    'number',
    'date',
    'file',
  ]),
  required: z.boolean().default(false),
  placeholder: z.string().max(200).optional(),
  helpText: z.string().max(500).optional(),
  options: z
    .array(z.object({ value: z.string().max(140), label: z.string().max(200) }))
    .default([]),
  /**
   * Where a select's options come from, when they are not written out.
   *
   * `services` fills them from the workspace's published service catalogue at
   * resolve time. Without this, a "what do you need?" field either has to be
   * kept in step with the catalogue by hand — which it will not be — or ships
   * empty, which makes a required field unanswerable and the whole form
   * impossible to submit.
   */
  optionsSource: z.enum(['services']).optional(),
  maxLength: z.number().int().positive().optional(),
  /** Accepted MIME types for a `file` field. */
  accept: z.array(z.string().max(140)).default([]),
  autocomplete: z.string().max(64).optional(),
});

export const resolvedFormSchema = z.object({
  id: z.uuid(),
  slug: z.string().max(140),
  name: z.string().max(200),
  fields: z.array(resolvedFormFieldSchema).max(40),
  submitLabel: z.string().max(100),
  successMessage: z.string().max(2000).optional(),
  requiresConsent: z.boolean(),
  consentText: z.string().max(2000).optional(),
  /** Rendered hidden and left empty by a human; filled in by most bots. */
  honeypotField: z.string().max(64),
  /** Site key only. The secret never leaves the API. */
  turnstileSiteKey: z.string().max(140).optional(),
});

export const sectionReferencesSchema = z.object({
  services: z.array(resolvedServiceSchema).default([]),
  people: z.array(resolvedPersonSchema).default([]),
  locations: z.array(resolvedLocationSchema).default([]),
  reviews: z.array(resolvedReviewSchema).default([]),
  related: z.array(resolvedRelatedEntrySchema).default([]),
  media: z.array(resolvedMediaSchema).default([]),
  forms: z.array(resolvedFormSchema).default([]),
});

export type ResolvedMedia = z.infer<typeof resolvedMediaSchema>;
export type ResolvedService = z.infer<typeof resolvedServiceSchema>;
export type ResolvedPerson = z.infer<typeof resolvedPersonSchema>;
export type ResolvedLocation = z.infer<typeof resolvedLocationSchema>;
export type ResolvedReview = z.infer<typeof resolvedReviewSchema>;
export type ResolvedRelatedEntry = z.infer<typeof resolvedRelatedEntrySchema>;
export type ResolvedFormField = z.infer<typeof resolvedFormFieldSchema>;
export type ResolvedForm = z.infer<typeof resolvedFormSchema>;
export type SectionReferences = z.infer<typeof sectionReferencesSchema>;

export const EMPTY_REFERENCES: SectionReferences = {
  services: [],
  people: [],
  locations: [],
  reviews: [],
  related: [],
  media: [],
  forms: [],
};

/** Index helper so a renderer can look up by id without an O(n) scan per item. */
export function indexById<T extends { id: string }>(items: readonly T[]): ReadonlyMap<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

/** Re-exported so section renderers validate hrefs with the same rules. */
export { safeHref };
