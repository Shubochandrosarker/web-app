import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace } from '@bos/database';
import { email, phoneE164, url } from '@bos/validation';
import { ApiError } from '../lib/errors.ts';
import { requirePermission } from '../lib/permissions.ts';
import { requireWorkspace } from '../lib/context.ts';
import type { AppContext } from '../app.ts';

const slug = z
  .string()
  .min(1)
  .max(140)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be lowercase words separated by single hyphens');
const coordinate = z.string().regex(/^-?\d{1,3}(?:\.\d+)?$/, 'must be a decimal coordinate');

const locationInput = z.object({
  slug,
  legalName: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200),
  streetAddress: z.string().min(1).max(500),
  addressLocality: z.string().min(1).max(140),
  addressRegion: z.string().max(140).nullable().optional(),
  postalCode: z.string().max(30).nullable().optional(),
  addressCountry: z.string().regex(/^[A-Z]{2}$/),
  latitude: coordinate.nullable().optional(),
  longitude: coordinate.nullable().optional(),
  telephone: phoneE164,
  whatsapp: phoneE164.nullable().optional(),
  email,
  openingHours: z.array(z.string().min(1).max(100)).max(14).optional(),
  areaServed: z.array(z.string().min(1).max(140)).max(100).optional(),
  sameAs: z.array(url).max(20).optional(),
  googleBusinessProfileUrl: url.nullable().optional(),
  isPrimary: z.boolean().optional(),
});

const locationPatch = locationInput.partial();

function present(row: typeof schema.locations.$inferSelect) {
  return {
    id: row.id,
    slug: row.slug,
    legalName: row.legalName,
    displayName: row.displayName,
    streetAddress: row.streetAddress,
    addressLocality: row.addressLocality,
    addressRegion: row.addressRegion,
    postalCode: row.postalCode,
    addressCountry: row.addressCountry,
    latitude: row.latitude,
    longitude: row.longitude,
    telephone: row.telephone,
    whatsapp: row.whatsapp,
    email: row.email,
    openingHours: row.openingHours,
    areaServed: row.areaServed,
    sameAs: row.sameAs,
    googleBusinessProfileUrl: row.googleBusinessProfileUrl,
    isPrimary: row.isPrimary,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function registerLocationRoutes(app: FastifyInstance, context: AppContext): void {
  const { db } = context;

  app.get(
    '/v1/locations',
    { config: { bosAccess: requirePermission('locations.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const rows = await tx
          .select()
          .from(schema.locations)
          .where(isNull(schema.locations.deletedAt))
          .orderBy(desc(schema.locations.isPrimary), asc(schema.locations.displayName));
        return { items: rows.map(present) };
      });
    },
  );

  app.get(
    '/v1/locations/:id',
    { config: { bosAccess: requirePermission('locations.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.locations)
          .where(and(eq(schema.locations.id, id), isNull(schema.locations.deletedAt)))
          .limit(1);
        if (!row) throw ApiError.hidden('Location');
        return present(row);
      });
    },
  );

  app.post(
    '/v1/locations',
    { config: { bosAccess: requirePermission('locations.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const input = locationInput.parse(request.body);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [existing] = await tx
          .select({ id: schema.locations.id })
          .from(schema.locations)
          .where(and(eq(schema.locations.slug, input.slug), isNull(schema.locations.deletedAt)))
          .limit(1);
        if (existing) throw ApiError.conflict('A location with that slug already exists.');

        if (input.isPrimary) {
          await tx
            .update(schema.locations)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(isNull(schema.locations.deletedAt));
        }

        const [row] = await tx
          .insert(schema.locations)
          .values({
            workspaceId: workspace.workspaceId,
            slug: input.slug,
            legalName: input.legalName,
            displayName: input.displayName,
            streetAddress: input.streetAddress,
            addressLocality: input.addressLocality,
            addressRegion: input.addressRegion ?? null,
            postalCode: input.postalCode ?? null,
            addressCountry: input.addressCountry,
            latitude: input.latitude ?? null,
            longitude: input.longitude ?? null,
            telephone: input.telephone,
            whatsapp: input.whatsapp ?? null,
            email: input.email,
            openingHours: input.openingHours ?? [],
            areaServed: input.areaServed ?? [],
            sameAs: input.sameAs ?? [],
            googleBusinessProfileUrl: input.googleBusinessProfileUrl ?? null,
            isPrimary: input.isPrimary ?? false,
          })
          .returning();
        return { location: present(row!) };
      });
    },
  );

  app.patch(
    '/v1/locations/:id',
    { config: { bosAccess: requirePermission('locations.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const input = locationPatch.parse(request.body);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [current] = await tx
          .select()
          .from(schema.locations)
          .where(and(eq(schema.locations.id, id), isNull(schema.locations.deletedAt)))
          .limit(1);
        if (!current) throw ApiError.hidden('Location');

        if (input.slug && input.slug !== current.slug) {
          const [existing] = await tx
            .select({ id: schema.locations.id })
            .from(schema.locations)
            .where(and(eq(schema.locations.slug, input.slug), isNull(schema.locations.deletedAt)))
            .limit(1);
          if (existing) throw ApiError.conflict('A location with that slug already exists.');
        }
        if (input.isPrimary) {
          await tx
            .update(schema.locations)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(isNull(schema.locations.deletedAt));
        }

        const [row] = await tx
          .update(schema.locations)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(schema.locations.id, id))
          .returning();
        return { location: present(row!) };
      });
    },
  );

  app.post(
    '/v1/locations/:id/archive',
    { config: { bosAccess: requirePermission('locations.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [row] = await tx
          .update(schema.locations)
          .set({ deletedAt: new Date(), updatedAt: new Date(), isPrimary: false })
          .where(and(eq(schema.locations.id, id), isNull(schema.locations.deletedAt)))
          .returning();
        if (!row) throw ApiError.hidden('Location');
        return { location: present(row), message: 'Location archived.' };
      });
    },
  );
}
