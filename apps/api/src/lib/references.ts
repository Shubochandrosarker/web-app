import { and, asc, desc, eq, gte, inArray, isNotNull, isNull } from 'drizzle-orm';
import { schema, type Database } from '@bos/database';
import {
  EMPTY_REFERENCES,
  type ResolvedForm,
  type ResolvedLocation,
  type ResolvedMedia,
  type ResolvedPerson,
  type ResolvedRelatedEntry,
  type ResolvedReview,
  type ResolvedService,
  type SectionReferences,
} from '@bos/content';
import { collectSectionReferences, type ParsedSection } from '@bos/sections';
import { sanitizeUrl } from '@bos/sanitize/url';

/**
 * Resolve everything a page's sections refer to by id.
 *
 * One pass per page rather than a query per section: a service page with a
 * service grid, a team block, a locations block and a related-content block
 * would otherwise be four round trips plus one per item.
 *
 * Every query runs inside the caller's tenant-scoped transaction, so an id
 * belonging to another workspace simply returns nothing — the isolation is the
 * database's, not a filter this file remembers to add.
 */

export interface ResolveOptions {
  readonly publicMediaBaseUrl: string | undefined;
  readonly turnstileSiteKey: string | undefined;
  readonly defaultLocale: string;
}

function toMedia(
  row: typeof schema.media.$inferSelect,
  baseUrl: string | undefined,
): ResolvedMedia | null {
  // Without a configured CDN origin there is no URL to give, and inventing a
  // relative one would render a broken image rather than no image.
  if (!baseUrl) return null;
  const url = sanitizeUrl(`${baseUrl.replace(/\/+$/, '')}/${row.objectKey.replace(/^\/+/, '')}`, {
    allowRelative: false,
  });
  if (!url) return null;

  return {
    id: row.id,
    url,
    mimeType: row.mimeType,
    ...(row.width !== null ? { width: row.width } : {}),
    ...(row.height !== null ? { height: row.height } : {}),
    ...(row.altText ? { alt: row.altText } : {}),
    ...(row.placeholder ? { blurDataUrl: row.placeholder } : {}),
  };
}

export async function resolveSectionReferences(
  tx: Database,
  workspaceId: string,
  sections: readonly ParsedSection[],
  options: ResolveOptions,
): Promise<SectionReferences> {
  const request = collectSectionReferences(sections);

  const needsAnything =
    request.serviceIds.length > 0 ||
    request.personIds.length > 0 ||
    request.locationIds.length > 0 ||
    request.contentEntryIds.length > 0 ||
    request.mediaIds.length > 0 ||
    request.formIds.length > 0 ||
    request.wantsReviews ||
    request.wantsAllServices ||
    request.wantsAllPeople ||
    request.wantsAllLocations;

  if (!needsAnything) return EMPTY_REFERENCES;

  const [services, people, locations, reviews, related, media] = await Promise.all([
    resolveServices(tx, workspaceId, request, options),
    resolvePeople(tx, workspaceId, request, options),
    resolveLocations(tx, workspaceId, request),
    request.wantsReviews ? resolveReviews(tx, workspaceId) : Promise.resolve([]),
    resolveRelated(tx, request, options),
    resolveMedia(tx, request, options),
  ]);

  /*
   * Forms resolve last, because a select can draw its options from the service
   * catalogue. A page that shows a form but no service grid still needs the
   * catalogue, so it is loaded here when the pass above did not already have a
   * reason to.
   */
  const catalogue =
    request.formIds.length > 0 && services.length === 0
      ? await resolveServices(
          tx,
          workspaceId,
          { ...request, wantsAllServices: true, serviceIds: [] },
          options,
        )
      : services;

  const forms = await resolveForms(tx, request, options, catalogue);

  // People and related entries carry their own media, which may not be in the
  // section props. Fold it in so a renderer has one place to look.
  const extraMedia = [
    ...people.flatMap((person) => (person.media ? [person.media] : [])),
    ...related.flatMap((entry) => (entry.media ? [entry.media] : [])),
  ];
  const seen = new Set(media.map((item) => item.id));
  const allMedia = [...media, ...extraMedia.filter((item) => !seen.has(item.id))];

  return { services, people, locations, reviews, related, media: allMedia, forms };
}

async function resolveServices(
  tx: Database,
  workspaceId: string,
  request: ReturnType<typeof collectSectionReferences>,
  options: ResolveOptions,
): Promise<ResolvedService[]> {
  if (!request.wantsAllServices && request.serviceIds.length === 0) return [];

  const conditions = [
    eq(schema.services.workspaceId, workspaceId),
    // Only published services reach a public page. A draft service that is
    // still being priced must not appear because someone pasted its id.
    eq(schema.services.status, 'published'),
    isNull(schema.services.deletedAt),
  ];
  if (!request.wantsAllServices) {
    conditions.push(inArray(schema.services.id, [...request.serviceIds]));
  }

  const rows = await tx
    .select()
    .from(schema.services)
    .where(and(...conditions))
    .orderBy(asc(schema.services.position), asc(schema.services.name))
    .limit(48);

  // The service's own page, when one exists. Looked up by the `serviceId` an
  // editor set on the content entry rather than by guessing a slug, so a
  // service page that lives at an unusual path still links correctly.
  const pathRows =
    rows.length === 0
      ? []
      : await tx
          .select({
            path: schema.contentEntries.path,
            fields: schema.contentEntries.fields,
          })
          .from(schema.contentEntries)
          .where(
            and(
              eq(schema.contentEntries.workspaceId, workspaceId),
              eq(schema.contentEntries.type, 'service'),
              eq(schema.contentEntries.status, 'published'),
              eq(schema.contentEntries.locale, options.defaultLocale),
              isNull(schema.contentEntries.deletedAt),
            ),
          );

  const pathByServiceId = new Map<string, string>();
  for (const row of pathRows) {
    const serviceId = (row.fields as Record<string, unknown>).serviceId;
    if (typeof serviceId === 'string') pathByServiceId.set(serviceId, row.path);
  }

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    requirements: (row.requirements as string[] | null) ?? [],
    ...(row.summary ? { summary: row.summary } : {}),
    ...(pathByServiceId.has(row.id) ? { path: pathByServiceId.get(row.id)! } : {}),
    ...(row.priceAmount !== null ? { priceAmount: row.priceAmount } : {}),
    ...(row.priceCurrency ? { priceCurrency: row.priceCurrency } : {}),
    ...(row.priceNote ? { priceNote: row.priceNote } : {}),
    ...(row.turnaroundNote ? { turnaroundNote: row.turnaroundNote } : {}),
  }));
}

async function resolvePeople(
  tx: Database,
  workspaceId: string,
  request: ReturnType<typeof collectSectionReferences>,
  options: ResolveOptions,
): Promise<ResolvedPerson[]> {
  if (!request.wantsAllPeople && request.personIds.length === 0) return [];

  const conditions = [
    eq(schema.staffProfiles.workspaceId, workspaceId),
    // `is_public` is the switch a person controls. Someone who takes bookings
    // but does not want a photograph on the website stays off it.
    eq(schema.staffProfiles.isPublic, true),
    isNull(schema.staffProfiles.deletedAt),
  ];
  if (!request.wantsAllPeople) {
    conditions.push(inArray(schema.staffProfiles.id, [...request.personIds]));
  }

  const rows = await tx
    .select({
      profile: schema.staffProfiles,
      photo: schema.media,
    })
    .from(schema.staffProfiles)
    .leftJoin(schema.media, eq(schema.media.id, schema.staffProfiles.photoMediaId))
    .where(and(...conditions))
    .orderBy(asc(schema.staffProfiles.position), asc(schema.staffProfiles.fullName))
    .limit(48);

  return rows.map(({ profile, photo }) => {
    const media = photo ? toMedia(photo, options.publicMediaBaseUrl) : null;
    return {
      id: profile.id,
      name: profile.fullName,
      ...(profile.role ? { role: profile.role } : {}),
      ...(profile.bio ? { bio: profile.bio } : {}),
      ...(media ? { media } : {}),
    };
  });
}

async function resolveLocations(
  tx: Database,
  workspaceId: string,
  request: ReturnType<typeof collectSectionReferences>,
): Promise<ResolvedLocation[]> {
  if (!request.wantsAllLocations && request.locationIds.length === 0) return [];

  const conditions = [
    eq(schema.locations.workspaceId, workspaceId),
    isNull(schema.locations.deletedAt),
  ];
  if (!request.wantsAllLocations) {
    conditions.push(inArray(schema.locations.id, [...request.locationIds]));
  }

  const rows = await tx
    .select()
    .from(schema.locations)
    .where(and(...conditions))
    .orderBy(desc(schema.locations.isPrimary), asc(schema.locations.displayName))
    .limit(24);

  return rows.map((row) => {
    const mapUrl =
      row.latitude && row.longitude
        ? `https://www.google.com/maps/search/?api=1&query=${row.latitude},${row.longitude}`
        : undefined;

    return {
      id: row.id,
      slug: row.slug,
      displayName: row.displayName,
      streetAddress: row.streetAddress,
      addressLocality: row.addressLocality,
      addressCountry: row.addressCountry,
      telephone: row.telephone,
      email: row.email,
      openingHours: (row.openingHours as string[] | null) ?? [],
      ...(row.addressRegion ? { addressRegion: row.addressRegion } : {}),
      ...(row.postalCode ? { postalCode: row.postalCode } : {}),
      ...(row.whatsapp ? { whatsapp: row.whatsapp } : {}),
      ...(row.latitude ? { latitude: row.latitude } : {}),
      ...(row.longitude ? { longitude: row.longitude } : {}),
      ...(mapUrl ? { mapUrl } : {}),
    };
  });
}

/**
 * Approved reviews only.
 *
 * `approved_at` is the gate, and it is set by a person in the dashboard. There
 * is no path from a form submission or an import straight onto a page, which
 * is what keeps a Review node backed by something a human vouched for.
 */
async function resolveReviews(tx: Database, workspaceId: string): Promise<ResolvedReview[]> {
  const rows = await tx
    .select()
    .from(schema.reviews)
    .where(
      and(
        eq(schema.reviews.workspaceId, workspaceId),
        isNotNull(schema.reviews.approvedAt),
        gte(schema.reviews.rating, 1),
      ),
    )
    .orderBy(desc(schema.reviews.reviewedAt))
    .limit(24);

  return rows
    .filter((row) => row.body !== null && row.body.length > 0)
    .map((row) => ({
      id: row.id,
      authorName: row.authorName,
      rating: row.rating,
      body: row.body ?? '',
      publishedAt: (row.approvedAt ?? row.reviewedAt).toISOString(),
      source: row.source,
    }));
}

async function resolveRelated(
  tx: Database,
  request: ReturnType<typeof collectSectionReferences>,
  options: ResolveOptions,
): Promise<ResolvedRelatedEntry[]> {
  if (request.contentEntryIds.length === 0) return [];

  const rows = await tx
    .select({
      entry: schema.contentEntries,
      ogImage: schema.media,
    })
    .from(schema.contentEntries)
    .leftJoin(schema.seoMetadata, eq(schema.seoMetadata.contentEntryId, schema.contentEntries.id))
    .leftJoin(schema.media, eq(schema.media.id, schema.seoMetadata.ogImageMediaId))
    .where(
      and(
        inArray(schema.contentEntries.id, [...request.contentEntryIds]),
        eq(schema.contentEntries.status, 'published'),
        isNull(schema.contentEntries.deletedAt),
      ),
    )
    .limit(12);

  // Preserve the editor's chosen order rather than the database's.
  const order = new Map(request.contentEntryIds.map((id, index) => [id, index]));

  return rows
    .sort((a, b) => (order.get(a.entry.id) ?? 0) - (order.get(b.entry.id) ?? 0))
    .map(({ entry, ogImage }) => {
      const media = ogImage ? toMedia(ogImage, options.publicMediaBaseUrl) : null;
      return {
        id: entry.id,
        title: entry.title,
        path: entry.path,
        type: entry.type,
        ...(entry.excerpt ? { excerpt: entry.excerpt } : {}),
        ...(media ? { media } : {}),
      };
    });
}

async function resolveMedia(
  tx: Database,
  request: ReturnType<typeof collectSectionReferences>,
  options: ResolveOptions,
): Promise<ResolvedMedia[]> {
  if (request.mediaIds.length === 0) return [];

  const rows = await tx
    .select()
    .from(schema.media)
    .where(
      and(
        inArray(schema.media.id, [...request.mediaIds]),
        // A private object must never acquire a public URL by being referenced
        // from a page. This is the check that keeps the two buckets separate.
        eq(schema.media.visibility, 'public'),
        isNull(schema.media.deletedAt),
      ),
    )
    .limit(64);

  return rows
    .map((row) => toMedia(row, options.publicMediaBaseUrl))
    .filter((item): item is ResolvedMedia => item !== null);
}

/**
 * Form definitions, projected down to what a browser needs to render them.
 *
 * Notification addresses, outcome configuration and the spam thresholds stay
 * server-side. The honeypot's field *name* is the one internal detail that has
 * to cross, because the browser must render the decoy for a bot to fill it in.
 */
async function resolveForms(
  tx: Database,
  request: ReturnType<typeof collectSectionReferences>,
  options: ResolveOptions,
  services: readonly ResolvedService[],
): Promise<ResolvedForm[]> {
  if (request.formIds.length === 0) return [];

  const rows = await tx
    .select()
    .from(schema.forms)
    .where(
      and(
        inArray(schema.forms.id, [...request.formIds]),
        eq(schema.forms.enabled, true),
        isNull(schema.forms.deletedAt),
      ),
    )
    .limit(8);

  return rows.map((row) => {
    const spam = (row.spamConfig as { honeypotField?: string } | null) ?? {};
    const fields = ((row.fields as ResolvedForm['fields'] | null) ?? []).map((field) =>
      field.optionsSource === 'services'
        ? {
            ...field,
            options: services.map((service) => ({ value: service.slug, label: service.name })),
          }
        : field,
    );

    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      fields,
      submitLabel: row.submitLabel,
      requiresConsent: row.requiresConsent,
      honeypotField: spam.honeypotField ?? 'company_website',
      ...(row.successMessage ? { successMessage: row.successMessage } : {}),
      ...(row.consentText ? { consentText: row.consentText } : {}),
      ...(options.turnstileSiteKey ? { turnstileSiteKey: options.turnstileSiteKey } : {}),
    };
  });
}
