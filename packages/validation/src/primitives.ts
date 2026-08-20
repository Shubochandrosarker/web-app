import { z } from 'zod';

/**
 * Shared primitives. Every module validates at its own boundary, but the
 * *shape* of an id, a slug or a phone number is defined once, here — otherwise
 * the site, the API and the Worker slowly drift into three different opinions
 * about what a valid slug is.
 */

export const uuid = z.uuid();

/** URL-safe, lowercase, no leading/trailing/double hyphens. */
export const slug = z
  .string()
  .min(1)
  .max(140)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'must be lowercase alphanumeric words separated by single hyphens',
  );

export const email = z.email().max(320).toLowerCase();

/**
 * E.164. Stored canonically so a lead captured from a Bangla-language form and
 * one captured from WhatsApp dedupe against each other.
 */
export const phoneE164 = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'must be an E.164 phone number, e.g. +8801712345678');

export const url = z.url().max(2048);

/** A relative site path: always starts with "/", never ends with one (except root). */
export const routePath = z
  .string()
  .regex(
    /^\/(?:[A-Za-z0-9\-._~%!$&'()*+,;=:@]+(?:\/[A-Za-z0-9\-._~%!$&'()*+,;=:@]+)*)?$/,
    'must be an absolute site path',
  );

export const isoDateTime = z.iso.datetime({ offset: true });

/** IANA time zone name — validated against the runtime's own tz database. */
export const timeZone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'must be a valid IANA time zone, e.g. Asia/Dhaka');

export const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code, e.g. BDT');

/** Money is stored as integer minor units. Never a float. */
export const minorUnits = z.number().int();

export const localeCode = z
  .string()
  .regex(
    /^[a-z]{2}(?:-[A-Z]{2})?$/,
    'must be a BCP 47 language or language-region tag, e.g. bn-BD',
  );

export const cursorPagination = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

export const sortDirection = z.enum(['asc', 'desc']);

export type CursorPagination = z.infer<typeof cursorPagination>;
export type SortDirection = z.infer<typeof sortDirection>;
