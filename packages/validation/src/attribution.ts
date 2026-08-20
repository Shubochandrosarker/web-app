import { z } from 'zod';
import { routePath, url } from './primitives.ts';

/**
 * Attribution travels with every lead, form submission and analytics event.
 * It is one schema so first-touch and last-touch are structurally identical
 * and can be compared without a translation layer.
 */
export const utmParameters = z.object({
  source: z.string().max(255).optional(),
  medium: z.string().max(255).optional(),
  campaign: z.string().max(255).optional(),
  term: z.string().max(255).optional(),
  content: z.string().max(255).optional(),
});

export const touchPoint = z.object({
  occurredAt: z.iso.datetime({ offset: true }),
  landingPath: routePath,
  referrer: url.optional(),
  /** Resolved by @bos/analytics from referrer + utm — see docs/architecture/06. */
  channel: z.string().max(64),
  utm: utmParameters.default({}),
  gclid: z.string().max(255).optional(),
  fbclid: z.string().max(255).optional(),
});

export const attribution = z.object({
  firstTouch: touchPoint.optional(),
  lastTouch: touchPoint.optional(),
});

export type UtmParameters = z.infer<typeof utmParameters>;
export type TouchPoint = z.infer<typeof touchPoint>;
export type Attribution = z.infer<typeof attribution>;
