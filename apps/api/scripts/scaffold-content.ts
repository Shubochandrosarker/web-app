import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { closeDatabase, createDatabase, schema, withoutTenantScope } from '@bos/database';

/**
 * Create the draft page architecture for a tenant.
 *
 *   pnpm --filter @bos/api scaffold-content <slug>
 *
 * What this does and pointedly does not do:
 *
 *  - It creates **drafts**, never published pages. Every text placeholder is
 *    an explicit `[OWNER:]` marker naming what must be supplied, so nothing
 *    invented can reach the public site by accident — publishing requires a
 *    person opening the page, replacing the markers and pressing Publish.
 *  - Service pages are generated **from the services table**, one per row.
 *    The catalogue itself is owner data (docs/owner-input-required.md); if no
 *    services exist yet, this says so instead of inventing ten.
 *  - Re-running skips paths that already exist: an editor's work is never
 *    overwritten by a scaffold.
 */

const OWNER = (what: string): string => `[OWNER: ${what}]`;

interface Draft {
  readonly type: 'page' | 'service' | 'location' | 'post';
  readonly slug: string;
  readonly path: string;
  readonly title: string;
  readonly sections: { type: string; props: Record<string, unknown> }[];
}

function section(type: string, props: Record<string, unknown>) {
  return { id: randomUUID(), type, hidden: false, props };
}

async function main(): Promise<void> {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: scaffold-content <workspace-slug>');
    process.exit(1);
  }

  const db = createDatabase({
    connectionString: process.env.DATABASE_URL ?? '',
    maxConnections: 3,
  });

  try {
    const { workspaceId, services } = await withoutTenantScope(db, async (tx) => {
      const [workspace] = await tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.slug, slug))
        .limit(1);
      if (!workspace) throw new Error(`No workspace with slug "${slug}". Provision it first.`);

      const services = await tx
        .select({ id: schema.services.id, slug: schema.services.slug, name: schema.services.name })
        .from(schema.services)
        .where(
          and(eq(schema.services.workspaceId, workspace.id), isNull(schema.services.deletedAt)),
        );
      return { workspaceId: workspace.id, services };
    });

    const drafts: Draft[] = [
      {
        type: 'page',
        slug: 'home',
        path: '/',
        title: OWNER('Home page title — what the business does, in plain words'),
        sections: [
          section('hero', {
            heading: OWNER('One-sentence answer to "what do you do for me?"'),
            subheading: OWNER('Supporting line — who it is for and why to trust it'),
            links: [],
          }),
          section('service-grid', { heading: 'Services', serviceIds: [] }),
          section('faq', {
            heading: 'Common questions',
            emitSchema: false,
            items: [
              {
                question: OWNER('A question customers actually ask (from enquiries/GSC)'),
                answer: OWNER('The direct answer, verified by the owner'),
              },
            ],
          }),
          section('form', { heading: 'Request the service', formSlug: 'service-request' }),
        ],
      },
      {
        type: 'page',
        slug: 'about',
        path: '/about',
        title: OWNER('About page title'),
        sections: [
          section('content', {
            html: `<p>${OWNER('Who runs the business, since when, and the independence disclaimer once its wording is approved')}</p>`,
            layout: 'prose',
          }),
        ],
      },
      {
        type: 'page',
        slug: 'contact',
        path: '/contact',
        title: 'Contact',
        sections: [
          section('locations', { heading: 'Where to find us', locationIds: [] }),
          section('form', { heading: 'Send a request', formSlug: 'service-request' }),
        ],
      },
      {
        type: 'location',
        slug: 'gazipur',
        path: '/locations/gazipur',
        title: OWNER('Location page title — one real location, no mass-generated pages'),
        sections: [
          section('locations', { heading: 'Visit us', locationIds: [] }),
          section('content', {
            html: `<p>${OWNER('Directions and what to bring — verified details only')}</p>`,
            layout: 'prose',
          }),
        ],
      },
      {
        type: 'page',
        slug: 'guides',
        path: '/guides',
        title: OWNER('Guides index title'),
        sections: [
          section('content', {
            html: `<p>${OWNER('Introduce the guides; each guide is a post written from verified process knowledge')}</p>`,
            layout: 'prose',
          }),
          section('related-content', { heading: 'Guides', contentType: 'post', limit: 12 }),
        ],
      },
      ...services.map(
        (service): Draft => ({
          type: 'service',
          slug: service.slug,
          path: `/services/${service.slug}`,
          title: service.name,
          sections: [
            section('hero', {
              heading: service.name,
              subheading: OWNER(
                'Answer-first opener: what the customer gets, the real duration policy, the real pricing policy ("on request" if that is the truth)',
              ),
              links: [],
            }),
            section('process', {
              heading: 'How it works',
              steps: [
                {
                  title: OWNER('Step 1'),
                  description: OWNER('Realistic duration from actual experience'),
                },
              ],
            }),
            section('faq', {
              heading: 'Questions about this service',
              emitSchema: false,
              items: [
                {
                  question: OWNER('A question actually asked about this service'),
                  answer: OWNER('The verified answer'),
                },
              ],
            }),
            section('form', { heading: 'Request this service', formSlug: 'service-request' }),
            section('related-content', { heading: 'Related services', contentType: 'service' }),
          ],
        }),
      ),
    ];

    let created = 0;
    let skipped = 0;
    for (const draft of drafts) {
      const inserted = await withoutTenantScope(db, async (tx) => {
        const [existing] = await tx
          .select({ id: schema.contentEntries.id })
          .from(schema.contentEntries)
          .where(
            and(
              eq(schema.contentEntries.workspaceId, workspaceId),
              eq(schema.contentEntries.path, draft.path),
              isNull(schema.contentEntries.deletedAt),
            ),
          )
          .limit(1);
        if (existing) return false;

        await tx.insert(schema.contentEntries).values({
          workspaceId,
          type: draft.type,
          slug: draft.slug,
          path: draft.path,
          locale: 'en',
          title: draft.title.slice(0, 300),
          status: 'draft',
          document: { sections: draft.sections },
        });
        return true;
      });
      if (inserted) {
        created += 1;
        console.log(`  draft: ${draft.path}`);
      } else {
        skipped += 1;
      }
    }

    if (services.length === 0) {
      console.log(
        '\n  NOTE: no services exist for this workspace, so no service pages were scaffolded.\n' +
          '  The service catalogue is owner data — see docs/owner-input-required.md.',
      );
    }
    console.log(`\nScaffolded ${created} draft page(s); ${skipped} already existed.`);
    console.log('All drafts contain [OWNER: …] markers and cannot be published by this script.');
  } finally {
    await closeDatabase().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
