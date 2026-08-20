import { BUSINESS_TYPE_PRESETS, resolveEnabledModules } from '@bos/business-types';
import { buildNavigation } from '@/lib/navigation';

/**
 * Phase 1 placeholder.
 *
 * It renders the navigation the current business type would produce, which is
 * worth having now: it makes the module system visible and verifiable before
 * any screen behind those links exists. TASK-107 replaces this with the real
 * authenticated shell reading the workspace from the API.
 */
export default function DashboardHome() {
  const businessType = 'education_service' as const;
  const enabled = resolveEnabledModules(BUSINESS_TYPE_PRESETS[businessType].defaultModules);
  const navigation = buildNavigation(enabled, businessType);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: '60ch' }}>
      <h1>Business OS dashboard</h1>
      <p>
        Navigation below is generated from the <code>{businessType}</code> preset — {enabled.length}{' '}
        modules enabled. Change the business type and the sidebar changes with it; nothing here is
        written per client.
      </p>
      {navigation.map((group) => (
        <section key={group.title}>
          <h2>{group.title}</h2>
          <ul>
            {group.items.map((item) => (
              <li key={item.href}>
                {item.label} <code>{item.href}</code>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
