import { z } from 'zod';
import { MODULE_IDS, type ModuleId } from './modules.ts';

/**
 * A business type is a preset, not a subclass. It decides which modules a new
 * workspace starts with and what the domain vocabulary is called in the UI —
 * a tour operator sees "Bookings", a consultancy sees "Appointments", and both
 * are the same `ops.scheduling` module underneath.
 *
 * Nothing in the platform may branch on business type at runtime. If a feature
 * needs a conditional, that conditional belongs in a module or a setting.
 */
export const BUSINESS_TYPES = [
  'education_service',
  'restaurant',
  'tour_operator',
  'healthcare',
  'agency',
  'local_service',
  'professional_service',
  'ecommerce',
  'membership',
  'training',
  'real_estate',
] as const;

export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const businessTypePresetSchema = z.object({
  type: z.enum(BUSINESS_TYPES),
  label: z.string().min(1),
  /** Modules switched on when a workspace of this type is created. */
  defaultModules: z.array(z.enum(MODULE_IDS)),
  /** UI vocabulary overrides, keyed by the platform's neutral term. */
  vocabulary: z.record(z.string(), z.string()).default({}),
});

export type BusinessTypePreset = z.infer<typeof businessTypePresetSchema>;

const commonMarketing = [
  'marketing.cms',
  'marketing.forms',
  'marketing.seo',
  'analytics.traffic',
  'analytics.conversion',
] as const satisfies readonly ModuleId[];

export const BUSINESS_TYPE_PRESETS: Record<BusinessType, BusinessTypePreset> = {
  education_service: {
    type: 'education_service',
    label: 'Education service',
    defaultModules: [
      ...commonMarketing,
      'ops.services',
      'ops.documents',
      'ops.scheduling',
      'ops.workflows',
      'crm.contacts',
      'crm.leads',
      'crm.pipeline',
      'crm.tasks',
      'comms.email',
      'comms.whatsapp',
      'reputation.reviews',
      'reputation.local_seo',
    ],
    vocabulary: {
      lead: 'Enquiry',
      service: 'Service',
      appointment: 'Consultation',
      order: 'Request',
    },
  },
  tour_operator: {
    type: 'tour_operator',
    label: 'Tour operator',
    defaultModules: [
      ...commonMarketing,
      'ops.services',
      'ops.scheduling',
      'ops.orders',
      'ops.workflows',
      'crm.contacts',
      'crm.leads',
      'crm.pipeline',
      'comms.email',
      'comms.whatsapp',
      'reputation.reviews',
      'analytics.revenue',
    ],
    vocabulary: {
      service: 'Tour',
      appointment: 'Departure',
      order: 'Booking',
      contact: 'Traveller',
    },
  },
  restaurant: {
    type: 'restaurant',
    label: 'Restaurant',
    defaultModules: [
      ...commonMarketing,
      'ops.services',
      'ops.scheduling',
      'crm.contacts',
      'reputation.reviews',
      'reputation.local_seo',
    ],
    vocabulary: { service: 'Menu item', appointment: 'Reservation' },
  },
  healthcare: {
    type: 'healthcare',
    label: 'Healthcare practice',
    defaultModules: [
      ...commonMarketing,
      'ops.services',
      'ops.scheduling',
      'ops.documents',
      'crm.contacts',
      'crm.tasks',
      'comms.email',
      'comms.sms',
      'reputation.local_seo',
    ],
    vocabulary: { contact: 'Patient', appointment: 'Appointment', service: 'Treatment' },
  },
  agency: {
    type: 'agency',
    label: 'Agency',
    defaultModules: [
      ...commonMarketing,
      'crm.contacts',
      'crm.leads',
      'crm.pipeline',
      'crm.tasks',
      'comms.email',
      'ops.workflows',
      'marketing.campaigns',
      'analytics.revenue',
    ],
    vocabulary: { contact: 'Client', order: 'Project' },
  },
  local_service: {
    type: 'local_service',
    label: 'Local service business',
    defaultModules: [
      ...commonMarketing,
      'ops.services',
      'ops.scheduling',
      'crm.contacts',
      'crm.leads',
      'comms.sms',
      'reputation.local_seo',
      'reputation.reviews',
    ],
    vocabulary: { appointment: 'Job', service: 'Service' },
  },
  professional_service: {
    type: 'professional_service',
    label: 'Professional service',
    defaultModules: [
      ...commonMarketing,
      'ops.services',
      'ops.scheduling',
      'ops.documents',
      'crm.contacts',
      'crm.leads',
      'crm.pipeline',
      'comms.email',
    ],
    vocabulary: { contact: 'Client', appointment: 'Consultation' },
  },
  ecommerce: {
    type: 'ecommerce',
    label: 'E-commerce',
    defaultModules: [
      ...commonMarketing,
      'ops.orders',
      'crm.contacts',
      'comms.email',
      'analytics.revenue',
      'reputation.reviews',
    ],
    vocabulary: { service: 'Product', order: 'Order' },
  },
  membership: {
    type: 'membership',
    label: 'Membership',
    defaultModules: [
      ...commonMarketing,
      'ops.orders',
      'crm.contacts',
      'comms.email',
      'ops.workflows',
      'analytics.revenue',
    ],
    vocabulary: { contact: 'Member', order: 'Subscription' },
  },
  training: {
    type: 'training',
    label: 'Training provider',
    defaultModules: [
      ...commonMarketing,
      'ops.services',
      'ops.scheduling',
      'ops.orders',
      'crm.contacts',
      'crm.leads',
      'comms.email',
      'ops.workflows',
    ],
    vocabulary: { service: 'Course', appointment: 'Session', contact: 'Learner' },
  },
  real_estate: {
    type: 'real_estate',
    label: 'Real estate',
    defaultModules: [
      ...commonMarketing,
      'ops.services',
      'ops.scheduling',
      'crm.contacts',
      'crm.leads',
      'crm.pipeline',
      'comms.whatsapp',
      'reputation.local_seo',
    ],
    vocabulary: { service: 'Listing', appointment: 'Viewing' },
  },
};

/** Resolve the UI label for a neutral platform term under a given business type. */
export function vocabularyFor(type: BusinessType, term: string, fallback: string): string {
  return BUSINESS_TYPE_PRESETS[type].vocabulary[term] ?? fallback;
}

export function isBusinessType(value: string): value is BusinessType {
  return (BUSINESS_TYPES as readonly string[]).includes(value);
}
