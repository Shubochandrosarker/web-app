import { and, eq, isNull } from 'drizzle-orm';
import { closeDatabase, createDatabase, schema, withoutTenantScope } from '@bos/database';

/**
 * Content for the smoke test to walk.
 *
 * ## Why this exists
 *
 * A freshly provisioned workspace has a brand, a pipeline and a service
 * request form, and no pages at all — because pages are authored, not
 * generated. That is the right default: a Business OS that invented marketing
 * copy for every new tenant would be publishing claims nobody made.
 *
 * It does mean the smoke test has nothing to walk against a clean database,
 * which is why it could only ever be run by hand against a database somebody
 * had already typed content into. This script closes that gap.
 *
 * ## Why the copy is deliberately worthless
 *
 * Every string below announces itself as a fixture. That is not laziness — it
 * is the point. Plausible-sounding business copy in a repository is a hazard:
 * it gets published by somebody who assumes it was written by the business,
 * and an invented turnaround time or fee is worse than an empty page. Nothing
 * here could survive that mistake unnoticed.
 *
 * Real content is authored in the dashboard, by the business, and the go-live
 * checklist says so.
 *
 * Development and CI only. Refuses to run against a production database.
 */

const SMOKE_PAGE_PATH = '/';
const SMOKE_SERVICE_PATH = '/services/smoke-test-service';

/**
 * A service page carrying the sections the smoke test asserts on: a heading,
 * and a form it can submit. The form section resolves its fields from the
 * workspace's provisioned service request form, so this exercises the real
 * lead path rather than a stub of it.
 */
function smokeServiceDocument(formId: string) {
  return {
    sections: [
      {
        id: '5c0e0000-0000-4000-8000-000000000001',
        type: 'hero',
        hidden: false,
        props: {
          variant: 'service',
          heading: 'Smoke test service',
          answer:
            'This page is a test fixture created by scripts/seed-smoke.ts. It is not a service, ' +
            'and nothing on it describes a real one.',
          links: [{ href: SMOKE_SERVICE_PATH, label: 'Request', primary: true }],
        },
      },
      {
        id: '5c0e0000-0000-4000-8000-000000000002',
        type: 'content',
        hidden: false,
        props: {
          layout: 'prose',
          html:
            '<h2>Fixture</h2><p>Created so continuous integration can submit the service ' +
            'request form and check that a lead is written. Delete it in any environment a ' +
            'visitor can reach.</p>',
        },
      },
      {
        id: '5c0e0000-0000-4000-8000-000000000003',
        type: 'form',
        hidden: false,
        props: { heading: 'Request', formId, layout: 'card' },
      },
    ],
  };
}

/** A homepage, because the smoke test asserts the site serves one. */
function smokeHomeDocument() {
  return {
    sections: [
      {
        id: '5c0e0000-0000-4000-8000-000000000010',
        type: 'hero',
        hidden: false,
        props: {
          variant: 'landing',
          heading: 'Smoke test homepage',
          answer:
            'This page is a test fixture created by scripts/seed-smoke.ts. Replace it with ' +
            'content the business has actually written.',
          links: [{ href: SMOKE_SERVICE_PATH, label: 'Smoke test service', primary: true }],
        },
      },
      {
        id: '5c0e0000-0000-4000-8000-000000000011',
        type: 'service-grid',
        hidden: false,
        props: { heading: 'Services', columns: 3, limit: 12, serviceIds: [], showPricing: false },
      },
    ],
  };
}

async function seed(slug: string): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'seed-smoke refuses to run with NODE_ENV=production. It writes fixture content, and ' +
        'fixture content on a live site is worse than no content.',
    );
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set.');

  const db = createDatabase({ connectionString, maxConnections: 2 });

  try {
    await withoutTenantScope(db, async (tx) => {
      const [workspace] = await tx
        .select({ id: schema.workspaces.id, locale: schema.workspaces.defaultLocale })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.slug, slug))
        .limit(1);

      if (!workspace) {
        throw new Error(`No workspace "${slug}". Run: pnpm workspace:provision ${slug}`);
      }

      /*
       * The form section addresses a form by id, not by slug — a slug is
       * mutable and a section pointing at a renamed form should break loudly
       * rather than silently resolve to a different one. So the fixture has to
       * look the provisioned form up rather than hard-code anything.
       */
      const [form] = await tx
        .select({ id: schema.forms.id })
        .from(schema.forms)
        .where(
          and(eq(schema.forms.workspaceId, workspace.id), eq(schema.forms.slug, 'service-request')),
        )
        .limit(1);

      if (!form) {
        throw new Error(
          `Workspace "${slug}" has no service-request form. Run: pnpm workspace:provision ${slug}`,
        );
      }

      /*
       * A service, because the provisioned service-request form has a required
       * `service` select whose options come from the published catalogue. An
       * empty catalogue leaves that select with nothing to pick, and a required
       * select with no options is a form nobody can submit — which is exactly
       * the failure this smoke test exists to catch, so the fixture has to
       * supply one rather than trip over it.
       */
      const [existingService] = await tx
        .select({ id: schema.services.id })
        .from(schema.services)
        .where(
          and(
            eq(schema.services.workspaceId, workspace.id),
            eq(schema.services.slug, 'smoke-test-service'),
          ),
        )
        .limit(1);

      if (existingService) {
        console.log('  service smoke-test-service — already present, left alone');
      } else {
        await tx.insert(schema.services).values({
          workspaceId: workspace.id,
          slug: 'smoke-test-service',
          name: 'Smoke test service',
          summary: 'Test fixture. Not a real service, and not priced.',
          status: 'published',
          position: 0,
        });
        console.log('  service smoke-test-service — created');
      }

      const entries = [
        {
          type: 'page' as const,
          slug: 'home',
          path: SMOKE_PAGE_PATH,
          title: 'Smoke test homepage',
          excerpt: 'Test fixture. Not real content.',
          document: smokeHomeDocument(),
        },
        {
          type: 'service' as const,
          slug: 'smoke-test-service',
          path: SMOKE_SERVICE_PATH,
          title: 'Smoke test service',
          excerpt: 'Test fixture. Not a real service.',
          document: smokeServiceDocument(form.id),
        },
      ];

      for (const entry of entries) {
        // Idempotent: re-running must not fail on the unique path index, so a
        // second run is a no-op rather than an error somebody has to read.
        const [existing] = await tx
          .select({ id: schema.contentEntries.id })
          .from(schema.contentEntries)
          .where(
            and(
              eq(schema.contentEntries.workspaceId, workspace.id),
              eq(schema.contentEntries.locale, workspace.locale),
              eq(schema.contentEntries.path, entry.path),
              isNull(schema.contentEntries.deletedAt),
            ),
          )
          .limit(1);

        if (existing) {
          console.log(`  ${entry.path} — already present, left alone`);
          continue;
        }

        await tx.insert(schema.contentEntries).values({
          workspaceId: workspace.id,
          type: entry.type,
          slug: entry.slug,
          path: entry.path,
          locale: workspace.locale,
          title: entry.title,
          excerpt: entry.excerpt,
          status: 'published',
          publishedAt: new Date(),
          document: entry.document,
          fields: {},
        });

        console.log(`  ${entry.path} — created`);
      }
    });

    console.log(`\nSeeded fixture content into "${slug}". Delete it before anyone sees it.`);
  } finally {
    await closeDatabase();
  }
}

const slug = process.argv[2];
if (!slug) {
  console.error('Usage: pnpm workspace:seed-smoke <workspace-slug>');
  process.exit(1);
}

await seed(slug);
