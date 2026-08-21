import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import {
  closeDatabase,
  createDatabase,
  schema,
  withWorkspace,
  withoutTenantScope,
} from '@bos/database';
import {
  resolveWorkspaceConfig,
  workspaceConfigSchema,
  type ResolvedWorkspaceConfig,
} from '@bos/business-types';
import { hashPassword } from '../src/lib/crypto.ts';

/**
 * Workspace provisioning.
 *
 * Turns `configs/<slug>/business.json` into the rows a tenant needs to exist:
 * the workspace, its brand, its primary location, its enabled modules, a
 * default lead pipeline and its stages.
 *
 * **Idempotent.** Running it twice must not produce two locations or reset a
 * pipeline somebody has renamed. That is not a nicety — provisioning is what
 * runs on every deploy to pick up a config change, so "safe to re-run" is the
 * only way it can also be "safe to automate".
 *
 * The rule this file follows for re-runs: create what is missing, update the
 * fields the config owns, and never touch a field a person edits in the
 * dashboard. A pipeline stage renamed from "Contacted" to "Documents
 * requested" stays renamed.
 *
 *   pnpm workspace:provision nuesheba
 *   pnpm workspace:provision nuesheba --owner-email you@example.com
 */

interface ProvisionOptions {
  readonly slug: string;
  readonly ownerEmail: string | undefined;
  readonly ownerPassword: string | undefined;
  readonly dryRun: boolean;
}

/**
 * The default pipeline for a lead.
 *
 * Created once. `position` is what the board orders by, and the slugs are
 * stable identifiers the config can refer to even after the names change.
 */
const DEFAULT_STAGES = [
  { slug: 'new', name: 'New', position: 0, isWon: false, isLost: false },
  { slug: 'contacted', name: 'Contacted', position: 1, isWon: false, isLost: false },
  {
    slug: 'documents-requested',
    name: 'Documents requested',
    position: 2,
    isWon: false,
    isLost: false,
  },
  { slug: 'in-progress', name: 'In progress', position: 3, isWon: false, isLost: false },
  { slug: 'completed', name: 'Completed', position: 4, isWon: true, isLost: false },
  { slug: 'lost', name: 'Lost', position: 5, isWon: false, isLost: true },
] as const;

function parseArgs(argv: readonly string[]): ProvisionOptions {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const slug = positional[0];
  if (!slug) {
    throw new Error('Usage: pnpm workspace:provision <slug> [--owner-email <email>] [--dry-run]');
  }

  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  return {
    slug,
    ownerEmail: flag('owner-email'),
    ownerPassword: process.env.BOS_OWNER_PASSWORD,
    dryRun: argv.includes('--dry-run'),
  };
}

async function loadConfig(slug: string): Promise<ResolvedWorkspaceConfig> {
  const path = resolve(process.cwd(), '../../configs', slug, 'business.json');
  const raw = await readFile(path, 'utf8').catch(() => {
    throw new Error(`No configuration found at ${path}.`);
  });

  const parsed = workspaceConfigSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid workspace config for "${slug}":\n${detail}`);
  }

  return resolveWorkspaceConfig(parsed.data);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig(options.slug);

  console.log(`Provisioning "${config.slug}" (${config.businessType})`);
  console.log(`  ${config.enabledModules.length} modules: ${config.enabledModules.join(', ')}`);

  if (options.dryRun) {
    console.log('\n--dry-run: configuration is valid; nothing was written.');
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set.');

  const db = createDatabase({ connectionString, maxConnections: 2 });

  try {
    /*
     * The workspace row itself is written outside tenant scope, because until
     * it exists there is no tenant to be scoped to. Everything after it runs
     * inside `withWorkspace`, so a bug in this script cannot write into
     * another tenant — row-level security refuses it.
     */
    const workspaceId = await withoutTenantScope(db, async (tx) => {
      const [existing] = await tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.slug, config.slug))
        .limit(1);

      const values = {
        slug: config.slug,
        name: config.brand.name,
        businessType: config.businessType,
        siteUrl: config.siteUrl,
        defaultLocale: config.locale.defaultLocale,
        supportedLocales: config.locale.supportedLocales,
        timeZone: config.locale.timeZone,
        currency: config.locale.currency,
        enabledModules: config.enabledModules,
        featureFlags: config.features,
        status: 'active' as const,
      };

      if (existing) {
        // The config owns these fields, so re-running picks up a change to
        // any of them. `status` is not in the update: a workspace an operator
        // suspended must not be un-suspended by a deploy.
        await tx
          .update(schema.workspaces)
          .set({ ...values, status: undefined as never, updatedAt: new Date() })
          .where(eq(schema.workspaces.id, existing.id));
        console.log('  workspace: updated');
        return existing.id;
      }

      const [created] = await tx
        .insert(schema.workspaces)
        .values(values)
        .returning({ id: schema.workspaces.id });
      console.log('  workspace: created');
      return created!.id;
    });

    await withWorkspace(db, workspaceId, async (tx) => {
      /* ------------------------------------------------------------ brand */

      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.workspaceId, workspaceId), eq(schema.brands.isPrimary, true)))
        .limit(1);

      const brandValues = {
        workspaceId,
        name: config.brand.name,
        ...(config.brand.tagline ? { tagline: config.brand.tagline } : {}),
        ...(config.brand.logoUrl ? { logoUrl: config.brand.logoUrl } : {}),
        tokens: {
          primaryColor: config.brand.primaryColor ?? '#1a56db',
        },
        isPrimary: true,
      };

      if (brand) {
        await tx.update(schema.brands).set(brandValues).where(eq(schema.brands.id, brand.id));
        console.log('  brand: updated');
      } else {
        await tx.insert(schema.brands).values(brandValues);
        console.log('  brand: created');
      }

      /* --------------------------------------------------------- location */

      const nap = config.nap;
      const locationSlug = 'primary';

      const locationValues = {
        workspaceId,
        slug: locationSlug,
        legalName: nap.legalName,
        displayName: nap.displayName,
        streetAddress: nap.streetAddress,
        addressLocality: nap.addressLocality,
        ...(nap.addressRegion ? { addressRegion: nap.addressRegion } : {}),
        ...(nap.postalCode ? { postalCode: nap.postalCode } : {}),
        addressCountry: nap.addressCountry,
        ...(nap.latitude !== undefined ? { latitude: String(nap.latitude) } : {}),
        ...(nap.longitude !== undefined ? { longitude: String(nap.longitude) } : {}),
        telephone: nap.telephone,
        ...(nap.whatsapp ? { whatsapp: nap.whatsapp } : {}),
        email: nap.email,
        openingHours: nap.openingHours,
        areaServed: nap.areaServed,
        sameAs: nap.sameAs,
        ...(nap.googleBusinessProfileUrl
          ? { googleBusinessProfileUrl: nap.googleBusinessProfileUrl }
          : {}),
        isPrimary: true,
      };

      // The NAP on the site, in the structured data and in the database must
      // be the same three strings. Re-running is how a corrected phone number
      // propagates to all three at once.
      await tx
        .insert(schema.locations)
        .values(locationValues)
        .onConflictDoUpdate({
          target: [schema.locations.workspaceId, schema.locations.slug],
          set: { ...locationValues, updatedAt: new Date() },
        });
      console.log('  primary location: upserted');

      /* --------------------------------------------------------- pipeline */

      const [pipeline] = await tx
        .select({ id: schema.pipelines.id })
        .from(schema.pipelines)
        .where(
          and(eq(schema.pipelines.workspaceId, workspaceId), eq(schema.pipelines.slug, 'sales')),
        )
        .limit(1);

      let pipelineId = pipeline?.id;

      if (!pipelineId) {
        const [created] = await tx
          .insert(schema.pipelines)
          .values({ workspaceId, slug: 'sales', name: 'Service requests', isDefault: true })
          .returning({ id: schema.pipelines.id });
        pipelineId = created!.id;
        console.log('  pipeline: created');
      } else {
        console.log('  pipeline: already present');
      }

      for (const stage of DEFAULT_STAGES) {
        /*
         * `onConflictDoNothing`, not `DoUpdate`.
         *
         * A stage a client renamed must survive the next provisioning run.
         * The slug is the stable identity; the name belongs to whoever is
         * using the board.
         */
        await tx
          .insert(schema.pipelineStages)
          .values({
            workspaceId,
            pipelineId,
            slug: stage.slug,
            name: stage.name,
            position: stage.position,
            isWon: stage.isWon,
            isLost: stage.isLost,
          })
          .onConflictDoNothing({
            target: [schema.pipelineStages.pipelineId, schema.pipelineStages.slug],
          });
      }
      console.log(`  stages: ${DEFAULT_STAGES.length} ensured`);

      /* ------------------------------------------------- service request form */

      const [form] = await tx
        .select({ id: schema.forms.id })
        .from(schema.forms)
        .where(
          and(eq(schema.forms.workspaceId, workspaceId), eq(schema.forms.slug, 'service-request')),
        )
        .limit(1);

      if (!form) {
        await tx.insert(schema.forms).values({
          workspaceId,
          slug: 'service-request',
          name: 'Service request',
          fields: SERVICE_REQUEST_FIELDS,
          submitLabel: 'Send my request',
          successMessage: 'Thank you — we have your request and will contact you shortly.',
          outcome: 'lead',
          outcomeConfig: {},
          notifyEmails: [nap.email],
          spamConfig: { honeypotField: 'company_website', minFillMs: 2000 },
          requiresConsent: true,
          consentText: 'I agree to be contacted about this request by phone, WhatsApp or email.',
          enabled: true,
        });
        console.log('  service request form: created');
      } else {
        console.log('  service request form: already present');
      }
    });

    /* ------------------------------------------------------------- owner */

    if (options.ownerEmail) {
      if (!options.ownerPassword) {
        throw new Error(
          'Set BOS_OWNER_PASSWORD in the environment to create the owner account. ' +
            'Passing a password on the command line would put it in your shell history.',
        );
      }
      if (options.ownerPassword.length < 12) {
        throw new Error('BOS_OWNER_PASSWORD must be at least 12 characters.');
      }

      const email = options.ownerEmail.trim().toLowerCase();
      const passwordHash = await hashPassword(options.ownerPassword);

      await withoutTenantScope(db, async (tx) => {
        const [existing] = await tx
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.email, email))
          .limit(1);

        let userId = existing?.id;

        if (!userId) {
          const [created] = await tx
            .insert(schema.users)
            .values({
              email,
              passwordHash,
              fullName: 'Owner',
              status: 'active',
              emailVerifiedAt: new Date(),
            })
            .returning({ id: schema.users.id });
          userId = created!.id;
          console.log('  owner user: created');
        } else {
          // An existing account's password is not reset by a re-run — that
          // would be a provisioning script quietly changing a credential.
          console.log('  owner user: already present (password unchanged)');
        }

        await tx
          .insert(schema.workspaceMembers)
          .values({ workspaceId, userId, role: 'owner', joinedAt: new Date() })
          .onConflictDoNothing({
            target: [schema.workspaceMembers.workspaceId, schema.workspaceMembers.userId],
          });
        console.log('  owner membership: ensured');
      });
    }

    console.log(`\nProvisioned "${config.slug}" (${workspaceId}).`);
  } finally {
    await closeDatabase();
  }
}

/**
 * The NuESheba service request, as field definitions rather than a template.
 *
 * They live here rather than in the tenant config because the *shape* of a
 * service request is platform behaviour — name, contact, what you need, what
 * you can prove — while which services exist is tenant data. A second client
 * gets the same form with a different service list.
 */
const SERVICE_REQUEST_FIELDS = [
  {
    name: 'name',
    label: 'Your name',
    type: 'text',
    required: true,
    maxLength: 200,
    autocomplete: 'name',
  },
  {
    name: 'phone',
    label: 'Phone number',
    type: 'tel',
    required: true,
    placeholder: '01XXXXXXXXX',
    helpText: 'We will call or message you on this number.',
    autocomplete: 'tel',
    options: [],
  },
  {
    name: 'whatsapp',
    label: 'WhatsApp number',
    type: 'tel',
    required: false,
    helpText: 'Leave blank if it is the same as your phone number.',
    options: [],
  },
  {
    name: 'email',
    label: 'Email address',
    type: 'email',
    required: false,
    autocomplete: 'email',
    options: [],
  },
  {
    name: 'service',
    label: 'What do you need?',
    type: 'select',
    required: true,
    /*
     * Filled from the workspace's published service catalogue when the form is
     * resolved — see `optionsSource` in @bos/content. Writing the options out
     * here would mean a list that has to be kept in step with the catalogue by
     * hand, and an empty one makes a required field unanswerable.
     */
    optionsSource: 'services',
    options: [],
  },
  { name: 'degree', label: 'Degree or programme', type: 'text', required: false, options: [] },
  { name: 'passing_year', label: 'Passing year', type: 'text', required: false, options: [] },
  {
    name: 'registration_number',
    label: 'Registration number',
    type: 'text',
    required: false,
    helpText: 'If you have it to hand. It helps us check your records faster.',
    options: [],
  },
  {
    name: 'message',
    label: 'Anything else we should know?',
    type: 'textarea',
    required: false,
    maxLength: 2000,
    options: [],
  },
] as const;

main().catch((error: unknown) => {
  console.error(`\nProvisioning failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
