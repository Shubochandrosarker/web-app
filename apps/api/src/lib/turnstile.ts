/**
 * Cloudflare Turnstile verification.
 *
 * A CAPTCHA is a filter, not a gate: it raises the cost of automated
 * submission enough that the low-effort bulk of it goes elsewhere. Everything
 * downstream of this check still validates as though it had not run.
 */

export interface TurnstileVerdict {
  readonly success: boolean;
  readonly reason?: string;
}

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(
  secret: string,
  token: string,
  remoteIp: string,
  // Overridden only by tests, which point it at a local stub. The check
  // itself — including its fail-closed path — is exercised for real.
  verifyUrl: string = TURNSTILE_VERIFY_URL,
): Promise<TurnstileVerdict> {
  if (!token) return { success: false, reason: 'missing-token' };

  try {
    const response = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: remoteIp }),
      // A slow CAPTCHA service must not hold a form submission open. Five
      // seconds is generous for an endpoint that normally answers in tens of
      // milliseconds.
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) return { success: false, reason: `verify-http-${response.status}` };

    const body = (await response.json()) as {
      success?: boolean;
      'error-codes'?: string[];
    };

    return body.success === true
      ? { success: true }
      : { success: false, reason: body['error-codes']?.join(',') ?? 'rejected' };
  } catch (error) {
    /*
     * Fail closed.
     *
     * The alternative — treating a Turnstile outage as a pass — turns any
     * disruption of Cloudflare's endpoint into an open flood gate on the one
     * unauthenticated write path in the platform. A brief period of legitimate
     * visitors being asked to try again is the cheaper failure.
     */
    return {
      success: false,
      reason:
        error instanceof Error ? `verify-unreachable: ${error.message}` : 'verify-unreachable',
    };
  }
}
