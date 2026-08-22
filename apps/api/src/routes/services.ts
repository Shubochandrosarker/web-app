import { and, asc, eq, ilike, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace, type Database } from '@bos/database';
import { ApiError } from '../lib/errors.ts';
import { requirePermission } from '../lib/permissions.ts';
import { requireWorkspace } from '../lib/context.ts';
import type { AppContext } from '../app.ts';

/**
 * Services are the reusable catalogue behind service pages, forms,
 * appointments and orders. The API owns the catalogue; content sections only
 * reference service ids, so renaming a service cannot leave stale copies in
 * page JSON.
 */

const slug = z
  .string()
  .min(1)
  .max(140)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase words separated by single hyphens');
const status = z.enum(schema.publishStatus.enumValues);

const serviceInput = z.object({
  name: z.string().min(1).max(200),
  slug,
  summary: z.string().max(2000).nullable().optional(),
  categoryId: z.uuid().nullable().optional(),
  status: status.optional(),
  priceAmount: z.number().int().min(0).nullable().optional(),
  priceCurrency: z.string().length(3).toUpperCase().nullable().optional(),
  priceNote: z.string().max(200).nullable().optional(),
  durationMinutes: z.number().int().positive().max(10080).nullable().optional(),
  turnaroundNote: z.string().max(200).nullable().optional(),
  requirements: z.array(z.string().min(1).max(500)).max(50).optional(),
  locationIds: z.array(z.uuid()).max(50).optional(),
  bookable: z.boolean().optional(),
  position: z.number().int().min(0).max(100000).optional(),
});

const servicePatch = serviceInput.partial();

const serviceQuery = z.object({
  status: status.optional(),
  categoryId: z.uuid().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function validatePricing(input: {
  priceAmount?: number | null | undefined;
  priceCurrency?: string | null | undefined;
}): void {
  if (input.priceAmount !== undefined && input.priceAmount !== null && !input.priceCurrency) {
    throw ApiError.badRequest('A currency is required when a numeric price is set.');
  }
  if (input.priceCurrency && (input.priceAmount === undefined || input.priceAmount === null)) {
    throw ApiError.badRequest('A numeric price is required when a currency is set.');
  }
}

/**
 * RLS hides other tenants' rows, but hiding is not validating: without this
 * check a foreign category or location UUID would be *stored* — a dangling
 * reference that renders as nothing and quietly survives every edit.
 * Reference ids are proven to exist in this workspace before they are saved,
 * the same philosophy the appointment routes apply.
 */
async function assertReferencesInWorkspace(
  tx: Database,
  input: {
    categoryId?: string | null | undefined;
    locationIds?: readonly string[] | undefined;
  },
): Promise<void> {
  if (input.categoryId) {
    const [category] = await tx
      .select({ id: schema.serviceCategories.id })
      .from(schema.serviceCategories)
      .where(eq(schema.serviceCategories.id, input.categoryId))
      .limit(1);
    if (!category) {
      throw ApiError.badRequest('Every linked record must belong to this workspace.');
    }
  }

  if (input.locationIds && input.locationIds.length > 0) {
    const unique = [...new Set(input.locationIds)];
    const rows = await tx
      .select({ id: schema.locations.id })
      .from(schema.locations)
      .where(and(inArray(schema.locations.id, unique), isNull(schema.locations.deletedAt)));
    if (rows.length !== unique.length) {
      throw ApiError.badRequest('Every linked record must belong to this workspace.');
    }
  }
}

function present(row: typeof schema.services.$inferSelect, categoryName?: string | null) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    summary: row.summary,
    categoryId: row.categoryId,
    categoryName: categoryName ?? null,
    status: row.status,
    priceAmount: row.priceAmount,
    priceCurrency: row.priceCurrency,
    priceNote: row.priceNote,
    durationMinutes: row.durationMinutes,
    turnaroundNote: row.turnaroundNote,
    requirements: row.requirements,
    locationIds: row.locationIds,
    bookable: row.bookable,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function registerServicesRoutes(app: FastifyInstance, context: AppContext): void {
  const { db } = context;

  app.get(
    '/v1/services',
    { config: { bosAccess: requirePermission('services.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const query = serviceQuery.parse(request.query);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const conditions = [isNull(schema.services.deletedAt)];
        if (query.status) conditions.push(eq(schema.services.status, query.status));
        if (query.categoryId) conditions.push(eq(schema.services.categoryId, query.categoryId));
        if (query.search) conditions.push(ilike(schema.services.name, `%${query.search}%`));

        const rows = await tx
          .select({ service: schema.services, categoryName: schema.serviceCategories.name })
          .from(schema.services)
          .leftJoin(
            schema.serviceCategories,
            eq(schema.serviceCategories.id, schema.services.categoryId),
          )
          .where(and(...conditions))
          .orderBy(asc(schema.services.position), asc(schema.services.name))
          .limit(query.limit);

        return { items: rows.map((row) => present(row.service, row.categoryName)) };
      });
    },
  );

  app.get(
    '/v1/services/:id',
    { config: { bosAccess: requirePermission('services.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const params = z.object({ id: z.uuid() }).parse(request.params);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [row] = await tx
          .select({ service: schema.services, categoryName: schema.serviceCategories.name })
          .from(schema.services)
          .leftJoin(
            schema.serviceCategories,
            eq(schema.serviceCategories.id, schema.services.categoryId),
          )
          .where(and(eq(schema.services.id, params.id), isNull(schema.services.deletedAt)))
          .limit(1);

        if (!row) throw ApiError.hidden('Service');
        return present(row.service, row.categoryName);
      });
    },
  );

  app.post(
    '/v1/services',
    { config: { bosAccess: requirePermission('services.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const input = serviceInput.parse(request.body);
      validatePricing(input);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [existing] = await tx
          .select({ id: schema.services.id })
          .from(schema.services)
          .where(and(eq(schema.services.slug, input.slug), isNull(schema.services.deletedAt)))
          .limit(1);
        if (existing) throw ApiError.conflict('A service with that slug already exists.');

        await assertReferencesInWorkspace(tx, input);

        const [row] = await tx
          .insert(schema.services)
          .values({
            workspaceId: workspace.workspaceId,
            name: input.name,
            slug: input.slug,
            summary: input.summary ?? null,
            categoryId: input.categoryId ?? null,
            status: input.status ?? 'draft',
            priceAmount: input.priceAmount ?? null,
            priceCurrency: input.priceCurrency ?? null,
            priceNote: input.priceNote ?? null,
            durationMinutes: input.durationMinutes ?? null,
            turnaroundNote: input.turnaroundNote ?? null,
            requirements: input.requirements ?? [],
            locationIds: input.locationIds ?? [],
            bookable: input.bookable ?? false,
            position: input.position ?? 0,
          })
          .returning();

        return { service: present(row!) };
      });
    },
  );

  app.patch(
    '/v1/services/:id',
    { config: { bosAccess: requirePermission('services.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const params = z.object({ id: z.uuid() }).parse(request.params);
      const input = servicePatch.parse(request.body);
      validatePricing(input);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [current] = await tx
          .select()
          .from(schema.services)
          .where(and(eq(schema.services.id, params.id), isNull(schema.services.deletedAt)))
          .limit(1);
        if (!current) throw ApiError.hidden('Service');

        if (input.slug && input.slug !== current.slug) {
          const [existing] = await tx
            .select({ id: schema.services.id })
            .from(schema.services)
            .where(and(eq(schema.services.slug, input.slug), isNull(schema.services.deletedAt)))
            .limit(1);
          if (existing) throw ApiError.conflict('A service with that slug already exists.');
        }

        await assertReferencesInWorkspace(tx, input);

        const [row] = await tx
          .update(schema.services)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.slug !== undefined ? { slug: input.slug } : {}),
            ...(input.summary !== undefined ? { summary: input.summary } : {}),
            ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.priceAmount !== undefined ? { priceAmount: input.priceAmount } : {}),
            ...(input.priceCurrency !== undefined ? { priceCurrency: input.priceCurrency } : {}),
            ...(input.priceNote !== undefined ? { priceNote: input.priceNote } : {}),
            ...(input.durationMinutes !== undefined
              ? { durationMinutes: input.durationMinutes }
              : {}),
            ...(input.turnaroundNote !== undefined ? { turnaroundNote: input.turnaroundNote } : {}),
            ...(input.requirements !== undefined ? { requirements: input.requirements } : {}),
            ...(input.locationIds !== undefined ? { locationIds: input.locationIds } : {}),
            ...(input.bookable !== undefined ? { bookable: input.bookable } : {}),
            ...(input.position !== undefined ? { position: input.position } : {}),
            updatedAt: new Date(),
          })
          .where(eq(schema.services.id, params.id))
          .returning();

        return { service: present(row!) };
      });
    },
  );

  app.post(
    '/v1/services/:id/archive',
    { config: { bosAccess: requirePermission('services.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const params = z.object({ id: z.uuid() }).parse(request.params);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [row] = await tx
          .update(schema.services)
          .set({ status: 'archived', updatedAt: new Date() })
          .where(and(eq(schema.services.id, params.id), isNull(schema.services.deletedAt)))
          .returning();
        if (!row) throw ApiError.hidden('Service');
        return { service: present(row), message: 'Service archived.' };
      });
    },
  );

  app.post(
    '/v1/services/:id/duplicate',
    { config: { bosAccess: requirePermission('services.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const params = z.object({ id: z.uuid() }).parse(request.params);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [source] = await tx
          .select()
          .from(schema.services)
          .where(and(eq(schema.services.id, params.id), isNull(schema.services.deletedAt)))
          .limit(1);
        if (!source) throw ApiError.hidden('Service');

        const baseSlug = `${source.slug}-copy`.slice(0, 140);
        let nextSlug = baseSlug;
        for (let suffix = 2; suffix < 100; suffix += 1) {
          const [taken] = await tx
            .select({ id: schema.services.id })
            .from(schema.services)
            .where(and(eq(schema.services.slug, nextSlug), isNull(schema.services.deletedAt)))
            .limit(1);
          if (!taken) break;
          const suffixText = `-${suffix}`;
          nextSlug = `${baseSlug.slice(0, 140 - suffixText.length)}${suffixText}`;
        }

        const [row] = await tx
          .insert(schema.services)
          .values({
            workspaceId: workspace.workspaceId,
            categoryId: source.categoryId,
            slug: nextSlug,
            name: `${source.name} (copy)`,
            summary: source.summary,
            status: 'draft',
            priceAmount: source.priceAmount,
            priceCurrency: source.priceCurrency,
            priceNote: source.priceNote,
            durationMinutes: source.durationMinutes,
            turnaroundNote: source.turnaroundNote,
            requirements: source.requirements,
            locationIds: source.locationIds,
            bookable: source.bookable,
            position: source.position,
          })
          .returning();

        return { service: present(row!), message: 'Service duplicated as a draft.' };
      });
    },
  );
}
