import {
  MODULE_REGISTRY,
  vocabularyFor,
  type BusinessType,
  type ModuleId,
} from '@bos/business-types';

/**
 * Navigation is derived from the workspace's enabled modules, never hard-coded.
 *
 * This is the reusability claim made concrete: a tour operator and a
 * consultancy get different sidebars from the same build, because the sidebar
 * is a projection of configuration rather than a component someone edits per
 * client.
 */
export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly moduleId: ModuleId;
}

export interface NavGroup {
  readonly title: string;
  readonly items: readonly NavItem[];
}

const NAV_MAP: Partial<Record<ModuleId, { group: string; href: string; term?: string }>> = {
  'crm.leads': { group: 'CRM', href: '/leads', term: 'lead' },
  'crm.contacts': { group: 'CRM', href: '/contacts', term: 'contact' },
  'crm.pipeline': { group: 'CRM', href: '/pipeline' },
  'crm.tasks': { group: 'CRM', href: '/tasks' },
  'marketing.cms': { group: 'Content', href: '/content' },
  'marketing.landing_pages': { group: 'Content', href: '/landing-pages' },
  'marketing.forms': { group: 'Content', href: '/forms' },
  'marketing.seo': { group: 'Content', href: '/seo' },
  'ops.services': { group: 'Operations', href: '/services', term: 'service' },
  'ops.scheduling': { group: 'Operations', href: '/appointments', term: 'appointment' },
  'ops.documents': { group: 'Operations', href: '/documents' },
  'ops.orders': { group: 'Operations', href: '/orders', term: 'order' },
  'ops.workflows': { group: 'Operations', href: '/automations' },
  'comms.email': { group: 'Communications', href: '/email' },
  'comms.whatsapp': { group: 'Communications', href: '/whatsapp' },
  'analytics.traffic': { group: 'Analytics', href: '/analytics' },
  'analytics.search': { group: 'Analytics', href: '/analytics/search' },
  'analytics.conversion': { group: 'Analytics', href: '/analytics/conversion' },
  'reputation.reviews': { group: 'Reputation', href: '/reviews' },
  'reputation.local_seo': { group: 'Reputation', href: '/local-seo' },
};

const GROUP_ORDER = ['CRM', 'Content', 'Operations', 'Communications', 'Analytics', 'Reputation'];

export function buildNavigation(
  enabledModules: readonly ModuleId[],
  businessType: BusinessType,
): NavGroup[] {
  const groups = new Map<string, NavItem[]>();

  for (const moduleId of enabledModules) {
    const entry = NAV_MAP[moduleId];
    if (!entry) continue;

    // The label follows the business type's vocabulary: the same
    // ops.scheduling module reads "Departures" for a tour operator and
    // "Consultations" for an education service.
    const base = MODULE_REGISTRY[moduleId].label;
    const label = entry.term ? `${vocabularyFor(businessType, entry.term, base)}s` : base;

    const items = groups.get(entry.group) ?? [];
    items.push({ href: entry.href, label, moduleId });
    groups.set(entry.group, items);
  }

  return GROUP_ORDER.filter((title) => groups.has(title)).map((title) => ({
    title,
    items: groups.get(title) ?? [],
  }));
}
