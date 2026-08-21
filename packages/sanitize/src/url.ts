import { z } from 'zod';

/**
 * URL safety.
 *
 * Kept free of Node-only dependencies so the Worker, the public site and the
 * API all reach the same verdict about a link. A scheme that is dangerous in
 * one of them is dangerous in all of them, and two implementations of "is this
 * href safe" is one implementation too many.
 */

/**
 * Schemes a stored link may use.
 *
 * `http:` is allowed because imported legacy content genuinely contains it and
 * rejecting it outright would lose real links during a WordPress migration;
 * it is upgraded to `https:` on the way in. Everything absent from this list is
 * rejected rather than escaped — there is no `javascript:` link a CMS editor
 * legitimately needs.
 */
export const ALLOWED_URL_SCHEMES = ['https:', 'http:', 'mailto:', 'tel:'] as const;

export type AllowedScheme = (typeof ALLOWED_URL_SCHEMES)[number];

export interface UrlPolicy {
  /** Schemes permitted for absolute URLs. */
  readonly schemes?: readonly string[];
  /** Allow site-relative paths such as `/services/attestation`. */
  readonly allowRelative?: boolean;
  /** Rewrite `http:` to `https:` instead of storing the insecure original. */
  readonly upgradeInsecure?: boolean;
}

const DEFAULT_POLICY: Required<UrlPolicy> = {
  schemes: ALLOWED_URL_SCHEMES,
  allowRelative: true,
  upgradeInsecure: true,
};

/**
 * Strip characters browsers ignore while parsing a scheme.
 *
 * `java\tscript:alert(1)`, a leading NUL and a zero-width space all parse as
 * `javascript:` somewhere, so the string is normalised before the scheme is
 * read rather than after. Whitespace inside the *path* is left alone; only the
 * characters that can hide inside a scheme are removed.
 */
/* eslint-disable no-control-regex -- matching control characters is this function's entire job */
function stripSchemeObfuscation(value: string): string {
  return value.replace(
    /[\u0000-\u0020\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/g,
    '',
  );
}
/* eslint-enable no-control-regex */

export interface UrlVerdict {
  readonly safe: boolean;
  /** The value to store. Only present when `safe`. */
  readonly href?: string;
  readonly reason?: string;
}

/**
 * Decide whether an href may be stored and rendered, and normalise it.
 *
 * Returns a verdict rather than throwing so a bulk import can drop one bad
 * link and keep going, and so the CMS can show the editor which field is at
 * fault instead of failing the whole save.
 */
export function inspectUrl(raw: string, policy: UrlPolicy = {}): UrlVerdict {
  const { schemes, allowRelative, upgradeInsecure } = { ...DEFAULT_POLICY, ...policy };
  const value = stripSchemeObfuscation(raw);

  if (value.length === 0) return { safe: false, reason: 'empty' };
  if (value.length > 2048) return { safe: false, reason: 'too long' };

  // Protocol-relative URLs inherit the page's scheme, which makes their real
  // destination invisible in the stored value. Require an explicit scheme.
  if (value.startsWith('//')) return { safe: false, reason: 'protocol-relative' };

  // Fragment and query-only links stay on the current page and carry no scheme.
  if (value.startsWith('#') || value.startsWith('?') || value.startsWith('/')) {
    return allowRelative
      ? { safe: true, href: value }
      : { safe: false, reason: 'relative link not allowed here' };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // Not absolute and not rooted. A bare `services/attestation` resolves
    // differently depending on the page it appears on, so it is rejected
    // rather than guessed at.
    return { safe: false, reason: 'not an absolute URL or a rooted path' };
  }

  const scheme = parsed.protocol.toLowerCase();
  if (!schemes.includes(scheme)) {
    return { safe: false, reason: `scheme "${scheme}" is not allowed` };
  }

  if (scheme === 'http:' && upgradeInsecure) {
    parsed.protocol = 'https:';
    return { safe: true, href: parsed.toString() };
  }

  return { safe: true, href: parsed.toString() };
}

/** Convenience wrapper: the normalised href, or null when the URL is unsafe. */
export function sanitizeUrl(raw: string, policy?: UrlPolicy): string | null {
  const verdict = inspectUrl(raw, policy);
  return verdict.safe && verdict.href !== undefined ? verdict.href : null;
}

export function isSafeUrl(raw: string, policy?: UrlPolicy): boolean {
  return inspectUrl(raw, policy).safe;
}

/**
 * The Zod schema every stored link field uses.
 *
 * Section schemas take this rather than a bare `z.string()`, which is what
 * turns "the link schema accepts arbitrary strings" from a review finding into
 * a validation error at publish time.
 */
export const safeHref = z
  .string()
  .min(1)
  .max(2048)
  .transform((value, ctx) => {
    const verdict = inspectUrl(value);
    if (!verdict.safe || verdict.href === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `unsafe or malformed link (${verdict.reason ?? 'rejected'})`,
      });
      return z.NEVER;
    }
    return verdict.href;
  });

/** Same rules, but absolute only — for canonical URLs and `sameAs` entries. */
export const safeAbsoluteUrl = z
  .string()
  .min(1)
  .max(2048)
  .transform((value, ctx) => {
    const verdict = inspectUrl(value, { allowRelative: false, schemes: ['https:', 'http:'] });
    if (!verdict.safe || verdict.href === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `unsafe or malformed URL (${verdict.reason ?? 'rejected'})`,
      });
      return z.NEVER;
    }
    return verdict.href;
  });
