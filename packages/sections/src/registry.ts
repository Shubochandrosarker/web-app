import { z } from 'zod';

/**
 * The section registry — the contract behind the schema-driven page builder.
 *
 * A page is an ordered list of sections. Each section is `{ type, variant,
 * props }` where `props` is validated by that type's schema. Editors choose
 * sections and fill in fields; they never choose markup, spacing or colours.
 * That is what keeps a hundred client sites from each inventing their own
 * broken hero.
 *
 * Adding a section = add a schema here + a renderer in apps/site. Nothing else
 * in the platform changes.
 */

export const SECTION_TYPES = [
  'hero',
  'content',
  'service-grid',
  'features',
  'faq',
  'testimonials',
  'reviews',
  'cta',
  'pricing',
  'process',
  'stats',
  'team',
  'locations',
  'gallery',
  'logos',
  'form',
  'related-content',
] as const;

export type SectionType = (typeof SECTION_TYPES)[number];

/** A link that may point inside the site or out of it. */
const linkSchema = z.object({
  label: z.string().min(1).max(120),
  href: z.string().min(1).max(2048),
  /** Rendered as a secondary action when false. */
  primary: z.boolean().default(false),
});

/** Media is referenced by id, never by URL — the media module resolves it. */
const mediaRefSchema = z.object({
  mediaId: z.uuid(),
  /**
   * Alt text lives with the usage, not the asset: the same photograph means
   * something different on an about page than in a gallery.
   */
  alt: z.string().max(300),
});

const headingSchema = z.object({
  eyebrow: z.string().max(120).optional(),
  heading: z.string().min(1).max(200),
  description: z.string().max(1200).optional(),
});

/**
 * Per-type prop schemas. Every one is `.strict()` so a typo in stored JSON is
 * a validation failure at publish time rather than a silently missing heading
 * in production.
 */
export const sectionPropSchemas = {
  hero: headingSchema
    .extend({
      variant: z.enum(['service', 'landing', 'article', 'minimal']).default('landing'),
      media: mediaRefSchema.optional(),
      links: z.array(linkSchema).max(3).default([]),
      /**
       * The direct-answer paragraph. Present on service pages so the page
       * opens by answering the query it targets — see docs/architecture/04.
       */
      answer: z.string().max(600).optional(),
    })
    .strict(),

  content: z
    .object({
      /** Sanitised HTML produced by the editor, never raw user input. */
      html: z.string(),
      layout: z.enum(['prose', 'two-column', 'narrow']).default('prose'),
    })
    .strict(),

  'service-grid': headingSchema
    .extend({
      /** Empty means "every published service", ordered by the catalogue. */
      serviceIds: z.array(z.uuid()).default([]),
      columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
      showPricing: z.boolean().default(false),
    })
    .strict(),

  features: headingSchema
    .extend({
      items: z
        .array(
          z.object({
            icon: z.string().max(64).optional(),
            title: z.string().min(1).max(160),
            description: z.string().max(600),
          }),
        )
        .min(1)
        .max(12),
    })
    .strict(),

  faq: headingSchema
    .extend({
      items: z
        .array(
          z.object({
            question: z.string().min(1).max(300),
            answer: z.string().min(1).max(2000),
          }),
        )
        .min(1)
        .max(30),
      /**
       * Emits FAQPage JSON-LD. Only ever true when the questions are visible
       * on the page — schema that does not match rendered content is a
       * structured-data violation, not a shortcut.
       */
      emitSchema: z.boolean().default(true),
    })
    .strict(),

  testimonials: headingSchema
    .extend({
      items: z
        .array(
          z.object({
            quote: z.string().min(1).max(1000),
            authorName: z.string().min(1).max(120),
            authorRole: z.string().max(160).optional(),
            media: mediaRefSchema.optional(),
          }),
        )
        .min(1)
        .max(12),
    })
    .strict(),

  reviews: headingSchema
    .extend({
      /** Pulled from the reputation module; never hand-written. */
      source: z.enum(['internal', 'google']).default('internal'),
      limit: z.number().int().min(1).max(24).default(6),
      minRating: z.number().min(1).max(5).default(4),
    })
    .strict(),

  cta: headingSchema
    .extend({
      links: z.array(linkSchema).min(1).max(2),
      emphasis: z.enum(['default', 'strong']).default('default'),
    })
    .strict(),

  pricing: headingSchema
    .extend({
      note: z.string().max(600).optional(),
      tiers: z
        .array(
          z.object({
            name: z.string().min(1).max(120),
            /** Minor units. Absent means "on request", which is a real answer. */
            amount: z.number().int().nonnegative().optional(),
            currency: z
              .string()
              .regex(/^[A-Z]{3}$/)
              .optional(),
            period: z.string().max(60).optional(),
            features: z.array(z.string().max(240)).default([]),
            link: linkSchema.optional(),
          }),
        )
        .min(1)
        .max(6),
    })
    .strict(),

  process: headingSchema
    .extend({
      steps: z
        .array(
          z.object({
            title: z.string().min(1).max(160),
            description: z.string().max(800),
            /** Shown as an expectation, e.g. "3-5 working days". */
            duration: z.string().max(80).optional(),
          }),
        )
        .min(2)
        .max(12),
    })
    .strict(),

  stats: headingSchema
    .extend({
      items: z
        .array(z.object({ value: z.string().min(1).max(40), label: z.string().min(1).max(160) }))
        .min(1)
        .max(6),
    })
    .strict(),

  team: headingSchema
    .extend({
      /** Empty means "everyone marked public" in the people collection. */
      personIds: z.array(z.uuid()).default([]),
    })
    .strict(),

  locations: headingSchema
    .extend({
      locationIds: z.array(z.uuid()).default([]),
      showMap: z.boolean().default(true),
    })
    .strict(),

  gallery: headingSchema
    .extend({
      items: z.array(mediaRefSchema).min(1).max(48),
      layout: z.enum(['grid', 'masonry', 'carousel']).default('grid'),
    })
    .strict(),

  logos: headingSchema
    .extend({
      items: z.array(mediaRefSchema).min(1).max(24),
    })
    .strict(),

  form: headingSchema
    .extend({
      formId: z.uuid(),
      layout: z.enum(['inline', 'card', 'split']).default('card'),
    })
    .strict(),

  'related-content': headingSchema
    .extend({
      /**
       * Explicit ids beat an algorithm here: internal linking is an editorial
       * decision, and the SEO module audits which pages have none.
       */
      contentEntryIds: z.array(z.uuid()).max(12).default([]),
      contentType: z.string().max(64).optional(),
      limit: z.number().int().min(1).max(12).default(3),
    })
    .strict(),
} satisfies Record<SectionType, z.ZodType>;

export type SectionPropsFor<T extends SectionType> = z.infer<(typeof sectionPropSchemas)[T]>;

/** One stored section, before its props are narrowed to a specific type. */
export const sectionSchema = z.object({
  id: z.uuid(),
  type: z.enum(SECTION_TYPES),
  /** Hidden sections stay in the document so a draft can be toggled back on. */
  hidden: z.boolean().default(false),
  props: z.record(z.string(), z.unknown()),
});

export type StoredSection = z.infer<typeof sectionSchema>;

export const pageDocumentSchema = z.object({
  sections: z.array(sectionSchema).max(60),
});

export type PageDocument = z.infer<typeof pageDocumentSchema>;

export type ParsedSection = {
  [T in SectionType]: { id: string; type: T; hidden: boolean; props: SectionPropsFor<T> };
}[SectionType];

export type SectionParseResult =
  | { ok: true; section: ParsedSection }
  | { ok: false; sectionId: string; type: SectionType; issues: readonly z.core.$ZodIssue[] };

/**
 * Validate one stored section against its type's schema.
 *
 * Returns a result rather than throwing: one malformed section should cost the
 * page that section, not the whole render. Callers log the failure and skip it.
 */
export function parseSection(section: StoredSection): SectionParseResult {
  const schema = sectionPropSchemas[section.type];
  const result = schema.safeParse(section.props);

  if (!result.success) {
    return { ok: false, sectionId: section.id, type: section.type, issues: result.error.issues };
  }

  return {
    ok: true,
    section: {
      id: section.id,
      type: section.type,
      hidden: section.hidden,
      props: result.data,
    } as ParsedSection,
  };
}

/** Parse a whole document, dropping hidden and invalid sections. */
export function parsePageDocument(document: PageDocument): {
  sections: ParsedSection[];
  errors: Extract<SectionParseResult, { ok: false }>[];
} {
  const sections: ParsedSection[] = [];
  const errors: Extract<SectionParseResult, { ok: false }>[] = [];

  for (const stored of document.sections) {
    if (stored.hidden) continue;
    const result = parseSection(stored);
    if (result.ok) sections.push(result.section);
    else errors.push(result);
  }

  return { sections, errors };
}

export function isSectionType(value: string): value is SectionType {
  return (SECTION_TYPES as readonly string[]).includes(value);
}
