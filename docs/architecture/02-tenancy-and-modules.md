# Tenancy and modules

## The hierarchy

```
Workspace                    the tenant boundary; everything hangs off it
├── Brand                    name, tagline, logo, design tokens
├── Locations                NAP — the single source of truth for address data
├── Users (via members)      people with access, and their roles
├── Services                 what the business sells
├── Staff profiles           people the business shows publicly / assigns work to
├── Content                  pages, posts, services, locations, guides
├── Contacts → Leads         people, and their individual enquiries
└── Integrations             credentials, webhooks, connected accounts
```

One deployment serves one workspace, selected by `BOS_WORKSPACE_SLUG`. The
database is multi-tenant regardless — because a shared control plane, agency
dashboards and cross-client reporting all become possible without a migration,
and because RLS is cheaper to build in from the start than to retrofit.

## Business types

Eleven presets: `education_service`, `restaurant`, `tour_operator`,
`healthcare`, `agency`, `local_service`, `professional_service`, `ecommerce`,
`membership`, `training`, `real_estate`.

A business type decides two things and nothing else:

1. **Default modules.** A tour operator starts with orders and revenue
   analytics; a restaurant does not.
2. **UI vocabulary.** The same `ops.scheduling` module reads "Departure" for a
   tour operator, "Consultation" for an education service, "Viewing" for real
   estate.

```ts
export const BUSINESS_TYPE_PRESETS: Record<BusinessType, BusinessTypePreset>;
export function vocabularyFor(type, term, fallback): string;
```

**Nothing may branch on business type at runtime.** A conditional that wants to
belongs in a module or a setting. The moment `if (businessType === 'x')` appears
in a handler, the platform has stopped being reusable and started being several
products sharing a repository.

## Modules

Twenty-eight modules across seven groups. Four are core and always on:
`core.auth`, `core.workspace`, `core.users`, `core.settings`.

Modules declare dependencies:

```ts
'ops.scheduling': { requires: ['ops.services', 'crm.contacts'] }
```

`resolveEnabledModules()` expands the transitive closure and returns a stable,
registry-ordered list, so navigation and route tables are deterministic.

### Resolution

```
business type preset
  + workspace `modules`         explicit additions
  − workspace `disabledModules` explicit removals
  → expand dependencies
  → enabledModules
```

Disabling a module that something else still depends on throws at config load
with the reason — not at runtime, and not silently.

### What "enabled" controls

| Surface     | Effect                                                             |
| ----------- | ------------------------------------------------------------------ |
| API         | The module's routes are mounted. Disabled means _absent_, not 403. |
| Dashboard   | Navigation is generated from the enabled list.                     |
| Site        | Which section types and which form outcomes are available.         |
| Automations | Which triggers and actions can be selected.                        |

`workspaces.enabled_modules` is stored, not recomputed per request, so
authorisation does not require resolving the whole tenant config on every call.
The config loader is what writes it.

## Roles and permissions

Five roles, ordered by breadth:

| Role      | Intent                                                   |
| --------- | -------------------------------------------------------- |
| `owner`   | Everything, including billing and deleting the workspace |
| `admin`   | Everything operational; not billing                      |
| `manager` | Their team's CRM, content, scheduling                    |
| `staff`   | Their own assigned work                                  |
| `viewer`  | Read-only                                                |

Permissions are `<module>.<action>` — `leads.read`, `documents.download`,
`content.publish`. A role maps to a permission set; `workspace_members.
extra_permissions` grants beyond it.

Two rules keep this from becoming unauditable:

- **Extra permissions are additive only.** They can never widen past what the
  role forbids outright, so reading a role still tells you the ceiling.
- **Access to a private document is always audited**, whatever the role. See
  [07 — Security](07-security-and-data-protection.md).

## Adding a client

1. `configs/<slug>/business.json` — brand, NAP, locale, business type, modules.
2. `pnpm --filter @bos/business-types test` — validates it. CI runs this on
   every config, so a malformed NAP or a mismatched slug fails the build rather
   than the site boot.
3. Seed the workspace row and its content.
4. Deploy with `BOS_WORKSPACE_SLUG=<slug>`.

No code changes. If a client needs one, that is a signal the capability belongs
in a module — the correct response is to add the module, not the client.
