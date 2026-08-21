import type { SectionType } from './registry.ts';

/**
 * The editor manifest — what the dashboard renders instead of raw JSON.
 *
 * Co-located with the schemas on purpose: the registry defines what a section
 * *is*, this file defines how a person edits one, and a section added without
 * an editor spec is a type error rather than a silently JSON-only section.
 *
 * The manifest describes fields; the dashboard owns the widgets. Nothing here
 * names a component or a CSS class, so the contract survives a dashboard
 * redesign — and the site, which also depends on this package, pulls in no UI.
 */

export type EditorFieldSpec =
  | {
      readonly kind: 'text';
      readonly name: string;
      readonly label: string;
      readonly help?: string;
      readonly required?: boolean;
      readonly maxLength?: number;
    }
  | {
      readonly kind: 'textarea';
      readonly name: string;
      readonly label: string;
      readonly help?: string;
      readonly required?: boolean;
      readonly maxLength?: number;
      readonly rows?: number;
    }
  | {
      /** Sanitised HTML prose — the `content` section's body. */
      readonly kind: 'richtext';
      readonly name: string;
      readonly label: string;
      readonly help?: string;
    }
  | {
      readonly kind: 'select';
      readonly name: string;
      readonly label: string;
      readonly help?: string;
      readonly options: readonly { value: string; label: string }[];
    }
  | {
      readonly kind: 'number';
      readonly name: string;
      readonly label: string;
      readonly help?: string;
      readonly min?: number;
      readonly max?: number;
    }
  | {
      readonly kind: 'boolean';
      readonly name: string;
      readonly label: string;
      readonly help?: string;
    }
  | {
      /** A `{ mediaId, alt }` pair, chosen from the media library. */
      readonly kind: 'media';
      readonly name: string;
      readonly label: string;
      readonly help?: string;
      readonly required?: boolean;
    }
  | {
      /** Call-to-action links: `{ label, href, primary }[]`. */
      readonly kind: 'links';
      readonly name: string;
      readonly label: string;
      readonly help?: string;
      readonly min?: number;
      readonly max: number;
    }
  | {
      /** An ordered list of structured items, each edited with `itemFields`. */
      readonly kind: 'repeater';
      readonly name: string;
      readonly label: string;
      readonly help?: string;
      readonly itemLabel: string;
      readonly min?: number;
      readonly max: number;
      readonly itemFields: readonly EditorFieldSpec[];
    }
  | {
      /**
       * References into another collection, picked by name.
       * `entity` names the API list the dashboard fetches choices from.
       */
      readonly kind: 'references';
      readonly name: string;
      readonly label: string;
      readonly help?: string;
      readonly entity: 'services' | 'people' | 'locations' | 'content' | 'forms';
      readonly max?: number;
      /** Exactly one reference (stored as a plain id, not an array). */
      readonly single?: boolean;
    };

export interface SectionEditorSpec {
  readonly label: string;
  /** One sentence for the "add section" picker. */
  readonly description: string;
  readonly fields: readonly EditorFieldSpec[];
}

const heading: readonly EditorFieldSpec[] = [
  {
    kind: 'text',
    name: 'eyebrow',
    label: 'Eyebrow',
    help: 'Small text above the heading.',
    maxLength: 120,
  },
  { kind: 'text', name: 'heading', label: 'Heading', required: true, maxLength: 200 },
  { kind: 'textarea', name: 'description', label: 'Description', maxLength: 1200, rows: 2 },
];

export const sectionEditors: Record<SectionType, SectionEditorSpec> = {
  hero: {
    label: 'Hero',
    description: 'The opening block: heading, supporting copy, calls to action.',
    fields: [
      ...heading,
      {
        kind: 'textarea',
        name: 'answer',
        label: 'Direct answer',
        help: 'One paragraph that answers the question this page targets. Service pages should open with it.',
        maxLength: 600,
        rows: 3,
      },
      {
        kind: 'select',
        name: 'variant',
        label: 'Layout',
        options: [
          { value: 'landing', label: 'Landing' },
          { value: 'service', label: 'Service' },
          { value: 'article', label: 'Article' },
          { value: 'minimal', label: 'Minimal' },
        ],
      },
      { kind: 'media', name: 'media', label: 'Image' },
      { kind: 'links', name: 'links', label: 'Buttons', max: 3 },
    ],
  },

  content: {
    label: 'Text',
    description: 'Written content — paragraphs, lists, headings.',
    fields: [
      { kind: 'richtext', name: 'html', label: 'Body' },
      {
        kind: 'select',
        name: 'layout',
        label: 'Layout',
        options: [
          { value: 'prose', label: 'Prose' },
          { value: 'two-column', label: 'Two columns' },
          { value: 'narrow', label: 'Narrow' },
        ],
      },
    ],
  },

  'service-grid': {
    label: 'Services',
    description: 'Cards for services from the catalogue.',
    fields: [
      ...heading,
      {
        kind: 'references',
        name: 'serviceIds',
        label: 'Services',
        entity: 'services',
        help: 'Leave empty to show every published service.',
      },
      {
        kind: 'select',
        name: 'columns',
        label: 'Columns',
        options: [
          { value: '2', label: '2' },
          { value: '3', label: '3' },
          { value: '4', label: '4' },
        ],
      },
      { kind: 'boolean', name: 'showPricing', label: 'Show pricing' },
      { kind: 'number', name: 'limit', label: 'Maximum shown', min: 1, max: 24 },
    ],
  },

  features: {
    label: 'Features',
    description: 'A grid of short points, each with a title and description.',
    fields: [
      ...heading,
      {
        kind: 'repeater',
        name: 'items',
        label: 'Features',
        itemLabel: 'Feature',
        min: 1,
        max: 12,
        itemFields: [
          { kind: 'text', name: 'title', label: 'Title', required: true, maxLength: 160 },
          { kind: 'textarea', name: 'description', label: 'Description', maxLength: 600, rows: 2 },
          {
            kind: 'text',
            name: 'icon',
            label: 'Icon name',
            help: 'Optional, from the icon set.',
            maxLength: 64,
          },
        ],
      },
    ],
  },

  faq: {
    label: 'Questions & answers',
    description: 'Common questions with their answers. Can emit FAQ structured data.',
    fields: [
      ...heading,
      {
        kind: 'repeater',
        name: 'items',
        label: 'Questions',
        itemLabel: 'Question',
        min: 1,
        max: 30,
        itemFields: [
          { kind: 'text', name: 'question', label: 'Question', required: true, maxLength: 300 },
          {
            kind: 'textarea',
            name: 'answer',
            label: 'Answer',
            required: true,
            maxLength: 2000,
            rows: 3,
          },
        ],
      },
      {
        kind: 'boolean',
        name: 'emitSchema',
        label: 'Mark up for search engines',
        help: 'Emits FAQPage structured data. The questions must be visible on the page.',
      },
    ],
  },

  testimonials: {
    label: 'Testimonials',
    description: 'Quotes from clients, written here.',
    fields: [
      ...heading,
      {
        kind: 'repeater',
        name: 'items',
        label: 'Testimonials',
        itemLabel: 'Testimonial',
        min: 1,
        max: 12,
        itemFields: [
          {
            kind: 'textarea',
            name: 'quote',
            label: 'Quote',
            required: true,
            maxLength: 1000,
            rows: 3,
          },
          { kind: 'text', name: 'authorName', label: 'Name', required: true, maxLength: 120 },
          { kind: 'text', name: 'authorRole', label: 'Role or context', maxLength: 160 },
          { kind: 'media', name: 'media', label: 'Photo' },
        ],
      },
    ],
  },

  reviews: {
    label: 'Reviews',
    description: 'Verified reviews from the reputation module — never hand-written.',
    fields: [
      ...heading,
      {
        kind: 'select',
        name: 'source',
        label: 'Source',
        options: [
          { value: 'internal', label: 'Collected by us' },
          { value: 'google', label: 'Google' },
        ],
      },
      { kind: 'number', name: 'limit', label: 'Maximum shown', min: 1, max: 24 },
      { kind: 'number', name: 'minRating', label: 'Minimum rating', min: 1, max: 5 },
    ],
  },

  cta: {
    label: 'Call to action',
    description: 'A prompt to act: heading, copy, one or two buttons.',
    fields: [
      ...heading,
      { kind: 'links', name: 'links', label: 'Buttons', min: 1, max: 2 },
      {
        kind: 'select',
        name: 'emphasis',
        label: 'Emphasis',
        options: [
          { value: 'default', label: 'Default' },
          { value: 'strong', label: 'Strong' },
        ],
      },
    ],
  },

  pricing: {
    label: 'Pricing',
    description: 'Tiers with amounts or "on request".',
    fields: [
      ...heading,
      {
        kind: 'textarea',
        name: 'note',
        label: 'Note',
        help: 'Shown under the tiers — caveats, taxes.',
        maxLength: 600,
        rows: 2,
      },
      {
        kind: 'repeater',
        name: 'tiers',
        label: 'Tiers',
        itemLabel: 'Tier',
        min: 1,
        max: 6,
        itemFields: [
          { kind: 'text', name: 'name', label: 'Name', required: true, maxLength: 120 },
          {
            kind: 'number',
            name: 'amount',
            label: 'Amount (minor units)',
            help: 'E.g. 150000 for ৳1,500.00. Leave empty for "on request".',
            min: 0,
          },
          {
            kind: 'text',
            name: 'currency',
            label: 'Currency code',
            help: 'Three letters, e.g. BDT.',
            maxLength: 3,
          },
          {
            kind: 'text',
            name: 'period',
            label: 'Period',
            help: 'E.g. "per document".',
            maxLength: 60,
          },
          { kind: 'boolean', name: 'highlighted', label: 'Highlight this tier' },
        ],
      },
    ],
  },

  process: {
    label: 'Process',
    description: 'Numbered steps with optional durations.',
    fields: [
      ...heading,
      {
        kind: 'repeater',
        name: 'steps',
        label: 'Steps',
        itemLabel: 'Step',
        min: 2,
        max: 12,
        itemFields: [
          { kind: 'text', name: 'title', label: 'Title', required: true, maxLength: 160 },
          { kind: 'textarea', name: 'description', label: 'Description', maxLength: 800, rows: 2 },
          {
            kind: 'text',
            name: 'duration',
            label: 'Expected duration',
            help: 'E.g. "3–5 working days". Only if verified.',
            maxLength: 80,
          },
        ],
      },
    ],
  },

  stats: {
    label: 'Numbers',
    description: 'Headline figures with labels.',
    fields: [
      ...heading,
      {
        kind: 'repeater',
        name: 'items',
        label: 'Figures',
        itemLabel: 'Figure',
        min: 1,
        max: 6,
        itemFields: [
          { kind: 'text', name: 'value', label: 'Value', required: true, maxLength: 40 },
          { kind: 'text', name: 'label', label: 'Label', required: true, maxLength: 160 },
        ],
      },
    ],
  },

  team: {
    label: 'Team',
    description: 'People from the staff directory.',
    fields: [
      ...heading,
      {
        kind: 'references',
        name: 'personIds',
        label: 'People',
        entity: 'people',
        help: 'Leave empty to show everyone marked public.',
      },
      { kind: 'number', name: 'limit', label: 'Maximum shown', min: 1, max: 24 },
    ],
  },

  locations: {
    label: 'Locations',
    description: 'Offices or branches, with address and hours.',
    fields: [
      ...heading,
      {
        kind: 'references',
        name: 'locationIds',
        label: 'Locations',
        entity: 'locations',
        help: 'Leave empty to show all.',
      },
      { kind: 'boolean', name: 'showMap', label: 'Show map link' },
    ],
  },

  gallery: {
    label: 'Gallery',
    description: 'A set of images.',
    fields: [
      ...heading,
      {
        kind: 'repeater',
        name: 'items',
        label: 'Images',
        itemLabel: 'Image',
        min: 1,
        max: 48,
        itemFields: [{ kind: 'media', name: '', label: 'Image', required: true }],
      },
      {
        kind: 'select',
        name: 'layout',
        label: 'Layout',
        options: [
          { value: 'grid', label: 'Grid' },
          { value: 'masonry', label: 'Masonry' },
          { value: 'carousel', label: 'Carousel' },
        ],
      },
    ],
  },

  logos: {
    label: 'Logos',
    description: 'A row of partner or client logos.',
    fields: [
      ...heading,
      {
        kind: 'repeater',
        name: 'items',
        label: 'Logos',
        itemLabel: 'Logo',
        min: 1,
        max: 24,
        itemFields: [{ kind: 'media', name: '', label: 'Logo', required: true }],
      },
    ],
  },

  form: {
    label: 'Form',
    description: 'A form from the form builder — usually the service request.',
    fields: [
      ...heading,
      {
        kind: 'references',
        name: 'formId',
        label: 'Form',
        entity: 'forms',
        single: true,
      },
      {
        kind: 'select',
        name: 'layout',
        label: 'Layout',
        options: [
          { value: 'card', label: 'Card' },
          { value: 'inline', label: 'Inline' },
          { value: 'split', label: 'Split' },
        ],
      },
    ],
  },

  'related-content': {
    label: 'Related pages',
    description: 'Links to other pages — internal linking is an editorial decision.',
    fields: [
      ...heading,
      {
        kind: 'references',
        name: 'contentEntryIds',
        label: 'Pages',
        entity: 'content',
        max: 12,
      },
      { kind: 'number', name: 'limit', label: 'Maximum shown', min: 1, max: 12 },
    ],
  },
};

/**
 * A fresh section of the given type, with the minimum valid shape.
 *
 * The defaults here must satisfy the type's schema (or be completable by an
 * editor before saving) — the "add section" flow inserts this and opens the
 * form.
 */
export function emptySectionProps(type: SectionType): Record<string, unknown> {
  switch (type) {
    case 'hero':
      return { heading: '', variant: 'landing', links: [] };
    case 'content':
      return { html: '', layout: 'prose' };
    case 'service-grid':
      return { heading: '', serviceIds: [], columns: 3, showPricing: false, limit: 12 };
    case 'features':
      return { heading: '', items: [{ title: '', description: '' }] };
    case 'faq':
      return { heading: '', items: [{ question: '', answer: '' }], emitSchema: true };
    case 'testimonials':
      return { heading: '', items: [{ quote: '', authorName: '' }] };
    case 'reviews':
      return { heading: '', source: 'internal', limit: 6, minRating: 4 };
    case 'cta':
      return { heading: '', links: [{ label: '', href: '/', primary: true }], emphasis: 'default' };
    case 'pricing':
      return { heading: '', tiers: [{ name: '', features: [] }] };
    case 'process':
      return {
        heading: '',
        steps: [
          { title: '', description: '' },
          { title: '', description: '' },
        ],
      };
    case 'stats':
      return { heading: '', items: [{ value: '', label: '' }] };
    case 'team':
      return { heading: '', personIds: [], limit: 12 };
    case 'locations':
      return { heading: '', locationIds: [], showMap: true };
    case 'gallery':
      return { heading: '', items: [], layout: 'grid' };
    case 'logos':
      return { heading: '', items: [] };
    case 'form':
      return { heading: '', formId: '', layout: 'card' };
    case 'related-content':
      return { heading: '', contentEntryIds: [], limit: 3 };
  }
}
