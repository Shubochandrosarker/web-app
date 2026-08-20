import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { metadata, primaryKeyColumn, softDelete, timestamps } from './_shared.ts';
import { publishStatus } from './enums.ts';
import { workspaces } from './identity.ts';

/**
 * The business itself: brand, locations, and the catalogue of what is sold.
 *
 * `locations` is the single source of truth for name, address and phone. The
 * footer, the contact page, LocalBusiness JSON-LD and email signatures all
 * read from this table — which is the whole point. Inconsistent NAP data
 * across a site is one of the few local-SEO problems that is entirely
 * self-inflicted, and it is prevented structurally here rather than by
 * remembering to update four places.
 */

export const brands = pgTable(
  'brands',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    tagline: varchar('tagline', { length: 300 }),
    logoMediaId: uuid('logo_media_id'),
    /** Design tokens: colours, type scale, radius. Consumed by the theme layer. */
    tokens: jsonb('tokens')
      .notNull()
      .default(sql`'{}'::jsonb`),
    isPrimary: boolean('is_primary').notNull().default(true),
    ...timestamps,
  },
  (table) => [index('brands_workspace_idx').on(table.workspaceId)],
);

export const locations = pgTable(
  'locations',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 140 }).notNull(),
    /** Registered name, used for Organization schema and legal copy. */
    legalName: varchar('legal_name', { length: 200 }).notNull(),
    /** Trading name, used in the UI. Often the same; not always. */
    displayName: varchar('display_name', { length: 200 }).notNull(),
    streetAddress: text('street_address').notNull(),
    addressLocality: varchar('address_locality', { length: 140 }).notNull(),
    addressRegion: varchar('address_region', { length: 140 }),
    postalCode: varchar('postal_code', { length: 30 }),
    addressCountry: varchar('address_country', { length: 2 }).notNull(),
    /** Stored as text to avoid float rounding drifting a pin off the building. */
    latitude: varchar('latitude', { length: 32 }),
    longitude: varchar('longitude', { length: 32 }),
    telephone: varchar('telephone', { length: 20 }).notNull(),
    whatsapp: varchar('whatsapp', { length: 20 }),
    email: varchar('email', { length: 320 }).notNull(),
    /** schema.org `openingHours` strings, e.g. "Sa-Th 09:00-18:00". */
    openingHours: jsonb('opening_hours')
      .notNull()
      .default(sql`'[]'::jsonb`),
    areaServed: jsonb('area_served')
      .notNull()
      .default(sql`'[]'::jsonb`),
    sameAs: jsonb('same_as')
      .notNull()
      .default(sql`'[]'::jsonb`),
    googleBusinessProfileUrl: text('google_business_profile_url'),
    isPrimary: boolean('is_primary').notNull().default(false),
    metadata: metadata(),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    uniqueIndex('locations_workspace_slug_key').on(table.workspaceId, table.slug),
    index('locations_workspace_idx').on(table.workspaceId),
  ],
);

export const serviceCategories = pgTable(
  'service_categories',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 140 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description'),
    position: integer('position').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('service_categories_workspace_slug_key').on(table.workspaceId, table.slug),
  ],
);

/**
 * What the business sells. The same table backs a consultancy's services, a
 * tour operator's tours and a training provider's courses — the business type
 * changes the label, not the shape.
 */
export const services = pgTable(
  'services',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').references(() => serviceCategories.id, {
      onDelete: 'set null',
    }),
    slug: varchar('slug', { length: 140 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    summary: text('summary'),
    status: publishStatus('status').notNull().default('draft'),
    /** Minor units. Null means "on request", which is a legitimate answer. */
    priceAmount: integer('price_amount'),
    priceCurrency: varchar('price_currency', { length: 3 }),
    priceNote: varchar('price_note', { length: 200 }),
    /** Typical turnaround, shown to set expectations before a lead is created. */
    durationMinutes: integer('duration_minutes'),
    turnaroundNote: varchar('turnaround_note', { length: 200 }),
    /** Documents or information the customer must supply. */
    requirements: jsonb('requirements')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Where this service is offered. Empty means every location. */
    locationIds: jsonb('location_ids')
      .notNull()
      .default(sql`'[]'::jsonb`),
    bookable: boolean('bookable').notNull().default(false),
    position: integer('position').notNull().default(0),
    metadata: metadata(),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    uniqueIndex('services_workspace_slug_key').on(table.workspaceId, table.slug),
    index('services_workspace_status_idx').on(table.workspaceId, table.status),
    index('services_category_idx').on(table.categoryId),
  ],
);

/**
 * People the business puts on its website and assigns work to. Separate from
 * `users`: a consultant who appears on the team page and takes bookings may
 * never log in, and a bookkeeper who logs in daily may never appear publicly.
 */
export const staffProfiles = pgTable(
  'staff_profiles',
  {
    id: primaryKeyColumn(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id'),
    slug: varchar('slug', { length: 140 }).notNull(),
    fullName: varchar('full_name', { length: 200 }).notNull(),
    role: varchar('role', { length: 200 }),
    bio: text('bio'),
    photoMediaId: uuid('photo_media_id'),
    email: varchar('email', { length: 320 }),
    telephone: varchar('telephone', { length: 20 }),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
    sameAs: jsonb('same_as')
      .notNull()
      .default(sql`'[]'::jsonb`),
    isPublic: boolean('is_public').notNull().default(false),
    acceptsBookings: boolean('accepts_bookings').notNull().default(false),
    position: integer('position').notNull().default(0),
    ...timestamps,
    ...softDelete,
  },
  (table) => [
    uniqueIndex('staff_profiles_workspace_slug_key').on(table.workspaceId, table.slug),
    index('staff_profiles_workspace_idx').on(table.workspaceId),
    index('staff_profiles_user_idx').on(table.userId),
  ],
);

export const locationsRelations = relations(locations, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [locations.workspaceId], references: [workspaces.id] }),
  staff: many(staffProfiles),
}));

export const servicesRelations = relations(services, ({ one }) => ({
  workspace: one(workspaces, { fields: [services.workspaceId], references: [workspaces.id] }),
  category: one(serviceCategories, {
    fields: [services.categoryId],
    references: [serviceCategories.id],
  }),
}));

export const staffProfilesRelations = relations(staffProfiles, ({ one }) => ({
  location: one(locations, { fields: [staffProfiles.locationId], references: [locations.id] }),
}));
