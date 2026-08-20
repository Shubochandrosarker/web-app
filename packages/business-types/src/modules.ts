import { z } from 'zod';

/**
 * Modules are the unit of capability. A workspace enables a set of them; the
 * dashboard navigation, the API route table and the site's available sections
 * are all derived from that set rather than hard-coded per client.
 */
export const MODULE_IDS = [
  // Core — always on, not selectable.
  'core.auth',
  'core.workspace',
  'core.users',
  'core.settings',

  // Marketing
  'marketing.cms',
  'marketing.landing_pages',
  'marketing.forms',
  'marketing.seo',
  'marketing.campaigns',

  // CRM
  'crm.contacts',
  'crm.leads',
  'crm.pipeline',
  'crm.tasks',

  // Communications
  'comms.email',
  'comms.whatsapp',
  'comms.sms',
  'comms.notifications',

  // Operations
  'ops.services',
  'ops.scheduling',
  'ops.documents',
  'ops.orders',
  'ops.workflows',

  // Analytics
  'analytics.traffic',
  'analytics.search',
  'analytics.conversion',
  'analytics.revenue',

  // Reputation
  'reputation.reviews',
  'reputation.local_seo',
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

export const CORE_MODULE_IDS = [
  'core.auth',
  'core.workspace',
  'core.users',
  'core.settings',
] as const satisfies readonly ModuleId[];

export const moduleDefinitionSchema = z.object({
  id: z.enum(MODULE_IDS),
  label: z.string().min(1),
  description: z.string().min(1),
  /** Modules that must also be enabled for this one to function. */
  requires: z.array(z.enum(MODULE_IDS)).default([]),
});

export type ModuleDefinition = z.infer<typeof moduleDefinitionSchema>;

/**
 * Dependencies are declared, not assumed. `ops.scheduling` without
 * `crm.contacts` would have nobody to book, so enabling one pulls in the other
 * at config-resolution time instead of failing at runtime.
 */
export const MODULE_REGISTRY: Record<ModuleId, ModuleDefinition> = {
  'core.auth': {
    id: 'core.auth',
    label: 'Authentication',
    description: 'Sessions, MFA, password and invite flows.',
    requires: [],
  },
  'core.workspace': {
    id: 'core.workspace',
    label: 'Workspace',
    description: 'Tenant, business, brand and location records.',
    requires: [],
  },
  'core.users': {
    id: 'core.users',
    label: 'Users & roles',
    description: 'Membership, RBAC and permission checks.',
    requires: ['core.auth', 'core.workspace'],
  },
  'core.settings': {
    id: 'core.settings',
    label: 'Settings',
    description: 'Workspace configuration and integration credentials.',
    requires: ['core.workspace'],
  },

  'marketing.cms': {
    id: 'marketing.cms',
    label: 'Content',
    description: 'Structured content entries, sections, media and navigation.',
    requires: ['core.workspace'],
  },
  'marketing.landing_pages': {
    id: 'marketing.landing_pages',
    label: 'Landing pages',
    description: 'Campaign-scoped pages with their own conversion goals.',
    requires: ['marketing.cms'],
  },
  'marketing.forms': {
    id: 'marketing.forms',
    label: 'Forms',
    description: 'Form builder, submissions and spam controls.',
    requires: ['marketing.cms'],
  },
  'marketing.seo': {
    id: 'marketing.seo',
    label: 'SEO engine',
    description: 'Metadata, entity graph, schema, sitemaps and indexing.',
    requires: ['marketing.cms'],
  },
  'marketing.campaigns': {
    id: 'marketing.campaigns',
    label: 'Campaigns',
    description: 'Campaign records and UTM attribution.',
    requires: ['analytics.traffic'],
  },

  'crm.contacts': {
    id: 'crm.contacts',
    label: 'Contacts',
    description: 'People and companies with a merged activity timeline.',
    requires: ['core.workspace'],
  },
  'crm.leads': {
    id: 'crm.leads',
    label: 'Leads',
    description: 'Inbound enquiries with source and attribution.',
    requires: ['crm.contacts'],
  },
  'crm.pipeline': {
    id: 'crm.pipeline',
    label: 'Pipeline',
    description: 'Configurable stages and conversion reporting.',
    requires: ['crm.leads'],
  },
  'crm.tasks': {
    id: 'crm.tasks',
    label: 'Tasks',
    description: 'Assigned follow-ups with due dates and reminders.',
    requires: ['crm.contacts'],
  },

  'comms.email': {
    id: 'comms.email',
    label: 'Email',
    description: 'Templates, sequences, sending and delivery events.',
    requires: ['crm.contacts'],
  },
  'comms.whatsapp': {
    id: 'comms.whatsapp',
    label: 'WhatsApp',
    description: 'Template messaging and reply capture.',
    requires: ['crm.contacts'],
  },
  'comms.sms': {
    id: 'comms.sms',
    label: 'SMS',
    description: 'Transactional and reminder SMS.',
    requires: ['crm.contacts'],
  },
  'comms.notifications': {
    id: 'comms.notifications',
    label: 'Notifications',
    description: 'In-app and push notifications for staff.',
    requires: ['core.users'],
  },

  'ops.services': {
    id: 'ops.services',
    label: 'Services',
    description: 'The catalogue of what the business actually sells.',
    requires: ['core.workspace'],
  },
  'ops.scheduling': {
    id: 'ops.scheduling',
    label: 'Scheduling',
    description: 'Availability, bookings, reminders and rescheduling.',
    requires: ['ops.services', 'crm.contacts'],
  },
  'ops.documents': {
    id: 'ops.documents',
    label: 'Documents',
    description: 'Private uploads with signed access and retention.',
    requires: ['crm.contacts'],
  },
  'ops.orders': {
    id: 'ops.orders',
    label: 'Orders',
    description: 'Order records, fulfilment status and payments.',
    requires: ['crm.contacts'],
  },
  'ops.workflows': {
    id: 'ops.workflows',
    label: 'Automations',
    description: 'Trigger / condition / action sequences.',
    requires: ['core.workspace'],
  },

  'analytics.traffic': {
    id: 'analytics.traffic',
    label: 'Traffic',
    description: 'First-party sessions, sources and landing pages.',
    requires: ['core.workspace'],
  },
  'analytics.search': {
    id: 'analytics.search',
    label: 'Search',
    description: 'Search Console and AI-referral performance.',
    requires: ['analytics.traffic'],
  },
  'analytics.conversion': {
    id: 'analytics.conversion',
    label: 'Conversion',
    description: 'Goal tracking and multi-touch attribution.',
    requires: ['analytics.traffic'],
  },
  'analytics.revenue': {
    id: 'analytics.revenue',
    label: 'Revenue',
    description: 'Revenue attribution by source and campaign.',
    requires: ['analytics.conversion'],
  },

  'reputation.reviews': {
    id: 'reputation.reviews',
    label: 'Reviews',
    description: 'Review capture, moderation and display.',
    requires: ['crm.contacts'],
  },
  'reputation.local_seo': {
    id: 'reputation.local_seo',
    label: 'Local SEO',
    description: 'NAP consistency, locations and Business Profile signals.',
    requires: ['marketing.seo'],
  },
};

/**
 * Expand an enabled-module list to include core modules and every transitive
 * dependency. Returns a stable, de-duplicated list.
 */
export function resolveEnabledModules(requested: readonly ModuleId[]): ModuleId[] {
  const resolved = new Set<ModuleId>(CORE_MODULE_IDS);

  const visit = (id: ModuleId): void => {
    if (resolved.has(id)) return;
    resolved.add(id);
    for (const dependency of MODULE_REGISTRY[id].requires) visit(dependency);
  };

  for (const id of requested) visit(id);

  // Preserve registry order so navigation and route tables are deterministic.
  return MODULE_IDS.filter((id) => resolved.has(id));
}

export function isModuleId(value: string): value is ModuleId {
  return (MODULE_IDS as readonly string[]).includes(value);
}
