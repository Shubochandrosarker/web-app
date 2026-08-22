import {
  MODULE_REGISTRY,
  vocabularyFor,
  type BusinessType,
  type ModuleId,
} from '@bos/business-types';

/**
 * Navigation is derived from the workspace's enabled modules and the signed-in
 * person's permissions, never hard-coded.
 *
 * This is the reusability claim made concrete: a tour operator and a
 * consultancy get different sidebars from the same build, because the sidebar
 * is a projection of configuration rather than a component someone edits per
 * client.
 *
 * The permission filter is a **courtesy**, not a control. It stops a viewer
 * from clicking into a screen that would refuse them, which is a better
 * experience than a 403 — but the refusal is the API's, and it happens whether
 * or not the link was ever rendered.
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

interface NavEntry {
  readonly group: string;
  readonly href: string;
  /** Vocabulary key, so the label follows the business type's language. */
  readonly term?: string;
  /** Fixed label, for a screen the module registry has no name for. */
  readonly label?: string;
  /** The permission a person needs before this link is worth showing them. */
  readonly permission: string;
  /** Not yet implemented; listed so the gap is visible rather than forgotten. */
  readonly pending?: boolean;
}

const NAV_MAP: Partial<Record<ModuleId, NavEntry | NavEntry[]>> = {
  'crm.leads': { group: 'CRM', href: '/leads', term: 'lead', permission: 'leads.read' },
  'crm.contacts': {
    group: 'CRM',
    href: '/contacts',
    term: 'contact',
    permission: 'contacts.read',
  },
  'crm.tasks': { group: 'CRM', href: '/tasks', label: 'Tasks', permission: 'tasks.read' },
  'marketing.cms': [
    { group: 'Content', href: '/content', permission: 'content.read' },
    { group: 'Content', href: '/media', label: 'Media', permission: 'media.read' },
  ],
  'marketing.landing_pages': {
    group: 'Content',
    href: '/landing-pages',
    permission: 'content.read',
    pending: true,
  },
  'marketing.forms': {
    group: 'Content',
    href: '/forms',
    label: 'Forms',
    permission: 'forms.read',
  },
  'marketing.seo': { group: 'Content', href: '/seo', permission: 'seo.read', pending: true },
  'ops.services': {
    group: 'Operations',
    href: '/services',
    term: 'service',
    permission: 'services.read',
    pending: true,
  },
  'ops.scheduling': {
    group: 'Operations',
    href: '/appointments',
    term: 'appointment',
    permission: 'services.read',
    pending: true,
  },
  'ops.documents': {
    group: 'Operations',
    href: '/documents',
    label: 'Documents',
    permission: 'documents.read',
  },
  'ops.orders': {
    group: 'Operations',
    href: '/orders',
    term: 'order',
    permission: 'leads.read',
    pending: true,
  },
  'ops.workflows': {
    group: 'Operations',
    href: '/automations',
    label: 'Automations',
    permission: 'automations.read',
  },
  'comms.email': {
    group: 'Communications',
    href: '/email',
    label: 'Email',
    permission: 'leads.read',
  },
  'comms.whatsapp': {
    group: 'Communications',
    href: '/whatsapp',
    label: 'WhatsApp',
    permission: 'leads.read',
  },
  'analytics.traffic': {
    group: 'Analytics',
    href: '/analytics',
    label: 'Traffic',
    permission: 'analytics.read',
  },
  'analytics.search': {
    group: 'Analytics',
    href: '/analytics/search',
    label: 'Search',
    permission: 'analytics.read',
  },
  'analytics.conversion': {
    group: 'Analytics',
    href: '/analytics/conversion',
    label: 'Conversions',
    permission: 'analytics.read',
  },
  'reputation.reviews': {
    group: 'Reputation',
    href: '/reviews',
    permission: 'content.read',
    pending: true,
  },
  'reputation.local_seo': {
    group: 'Reputation',
    href: '/local-seo',
    permission: 'seo.read',
    pending: true,
  },
};

const GROUP_ORDER = ['CRM', 'Content', 'Operations', 'Communications', 'Analytics', 'Reputation'];

export interface BuildNavigationOptions {
  /** Include screens that are scheduled but not built. Off by default. */
  readonly includePending?: boolean;
}

export function buildNavigation(
  enabledModules: readonly ModuleId[],
  businessType: BusinessType,
  permissions: readonly string[],
  options: BuildNavigationOptions = {},
): NavGroup[] {
  const held = new Set(permissions);
  const groups = new Map<string, NavItem[]>();

  for (const moduleId of enabledModules) {
    const mapped = NAV_MAP[moduleId];
    if (!mapped) continue;

    for (const entry of Array.isArray(mapped) ? mapped : [mapped]) {
      /*
       * A link to a screen that does not exist is worse than a missing link:
       * it reads as a broken product rather than an unfinished one. The
       * entries stay in the map so the remaining work is visible in this
       * file, and `includePending` exposes them for a roadmap view.
       */
      if (entry.pending && !options.includePending) continue;

      if (!held.has(entry.permission)) continue;

      // The label follows the business type's vocabulary: the same
      // ops.scheduling module reads "Departures" for a tour operator and
      // "Consultations" for an education service.
      const base = MODULE_REGISTRY[moduleId].label;
      const label =
        entry.label ?? (entry.term ? `${vocabularyFor(businessType, entry.term, base)}s` : base);

      const items = groups.get(entry.group) ?? [];
      items.push({ href: entry.href, label, moduleId });
      groups.set(entry.group, items);
    }
  }

  return GROUP_ORDER.filter((title) => groups.has(title)).map((title) => ({
    title,
    items: groups.get(title) ?? [],
  }));
}

/** Which module-backed screens are still to be built. Used by the roadmap page. */
export function pendingScreens(enabledModules: readonly ModuleId[]): readonly string[] {
  return enabledModules
    .flatMap((moduleId) => {
      const mapped = NAV_MAP[moduleId];
      return mapped ? (Array.isArray(mapped) ? mapped : [mapped]) : [];
    })
    .filter((entry) => entry.pending === true)
    .map((entry) => entry.href);
}
