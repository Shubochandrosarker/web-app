import type { Attribution, TouchPoint } from '@bos/validation';

/**
 * First-party attribution capture.
 *
 * The question this answers is "what brought this enquiry?", and the naive
 * implementation — read the UTM parameters off the URL at submission time —
 * answers a different one: "what page were they on when they submitted?".
 * Someone who arrives from a search result, reads three pages and then fills
 * in a form on the fourth has no UTM parameters left by then, and would be
 * recorded as direct traffic.
 *
 * So the first touch is written once, on the first page of the visit, and kept
 * until it is used. The last touch is updated whenever a new referrer or
 * campaign appears.
 *
 * No third-party script, no cookie sent to anybody else, and nothing stored
 * that identifies a person: a channel, a campaign and a landing path.
 */

const FIRST_TOUCH_KEY = 'bos_ft';
const LAST_TOUCH_KEY = 'bos_lt';

/** First touch is kept for a full sales cycle; last touch for one session. */
const FIRST_TOUCH_DAYS = 90;
const LAST_TOUCH_DAYS = 1;

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function writeCookie(name: string, value: string, days: number): void {
  if (typeof document === 'undefined') return;
  const expires = new Date(Date.now() + days * 86_400_000).toUTCString();
  // `SameSite=Lax` so the cookie survives a click from a search result;
  // `Secure` because the site is HTTPS-only in every environment that matters.
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax; Secure`;
}

/**
 * Resolve a traffic channel.
 *
 * Coarse on purpose. The distinction that earns its keep is organic search
 * versus an AI assistant versus paid versus direct — splitting "social" into
 * eleven networks produces a report nobody reads. Kept in step with the
 * server-side resolver in `apps/api/src/routes/internal.ts`.
 */
function resolveChannel(referrer: string, medium: string | undefined): string {
  if (medium) {
    const value = medium.toLowerCase();
    if (['cpc', 'ppc', 'paid', 'paidsearch'].includes(value)) return 'paid_search';
    if (['email', 'newsletter'].includes(value)) return 'email';
    if (value.includes('social')) return 'social';
    if (value === 'referral') return 'referral';
  }

  if (!referrer) return 'direct';

  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return 'direct';
  }

  if (typeof window !== 'undefined' && host === window.location.hostname) return 'internal';

  if (
    /(^|\.)(chatgpt\.com|chat\.openai\.com|perplexity\.ai|claude\.ai|copilot\.microsoft\.com|gemini\.google\.com)$/.test(
      host,
    )
  ) {
    return 'ai_assistant';
  }
  if (/(^|\.)(google\.|bing\.|duckduckgo\.|yahoo\.|yandex\.|baidu\.)/.test(host)) {
    return 'organic_search';
  }
  if (
    /(^|\.)(facebook\.com|instagram\.com|x\.com|twitter\.com|linkedin\.com|youtube\.com|t\.co|tiktok\.com)$/.test(
      host,
    )
  ) {
    return 'social';
  }

  return 'referral';
}

function currentTouch(): TouchPoint {
  const params = new URLSearchParams(window.location.search);
  const referrer = document.referrer;
  const medium = params.get('utm_medium') ?? undefined;

  const utm: TouchPoint['utm'] = {};
  const source = params.get('utm_source');
  const campaign = params.get('utm_campaign');
  const term = params.get('utm_term');
  const contentParam = params.get('utm_content');

  if (source) utm.source = source.slice(0, 255);
  if (medium) utm.medium = medium.slice(0, 255);
  if (campaign) utm.campaign = campaign.slice(0, 255);
  if (term) utm.term = term.slice(0, 255);
  if (contentParam) utm.content = contentParam.slice(0, 255);

  const gclid = params.get('gclid');
  const fbclid = params.get('fbclid');

  return {
    occurredAt: new Date().toISOString(),
    landingPath: window.location.pathname,
    channel: resolveChannel(referrer, medium),
    utm,
    ...(referrer ? { referrer } : {}),
    ...(gclid ? { gclid: gclid.slice(0, 255) } : {}),
    ...(fbclid ? { fbclid: fbclid.slice(0, 255) } : {}),
  };
}

/**
 * Record this page view's touch.
 *
 * Called once per page from the layout. Writing the first touch only when it
 * is absent is what makes it *first*; overwriting it on every page would make
 * it another last touch under a different name.
 */
export function captureAttribution(): void {
  if (typeof window === 'undefined') return;

  try {
    const touch = currentTouch();
    const serialised = JSON.stringify(touch);

    if (!readCookie(FIRST_TOUCH_KEY)) {
      writeCookie(FIRST_TOUCH_KEY, serialised, FIRST_TOUCH_DAYS);
    }

    /*
     * Last touch is refreshed only when this page view actually represents a
     * new arrival. An internal click is not a new touch, and treating it as
     * one would rewrite every visit as "internal" by the second page.
     */
    if (touch.channel !== 'internal' && touch.channel !== 'direct') {
      writeCookie(LAST_TOUCH_KEY, serialised, LAST_TOUCH_DAYS);
    } else if (!readCookie(LAST_TOUCH_KEY)) {
      writeCookie(LAST_TOUCH_KEY, serialised, LAST_TOUCH_DAYS);
    }
  } catch {
    // Cookies disabled, or a storage quota. Attribution is nice to have; a
    // form that will not submit because of it is not.
  }
}

/** Read what was captured, in the shape the API's attribution schema expects. */
export function readAttribution(): Attribution {
  if (typeof window === 'undefined') return {};

  const parse = (raw: string | null): TouchPoint | undefined => {
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as TouchPoint;
    } catch {
      return undefined;
    }
  };

  const firstTouch = parse(readCookie(FIRST_TOUCH_KEY));
  const lastTouch = parse(readCookie(LAST_TOUCH_KEY)) ?? firstTouch;

  return {
    ...(firstTouch ? { firstTouch } : {}),
    ...(lastTouch ? { lastTouch } : {}),
  };
}
