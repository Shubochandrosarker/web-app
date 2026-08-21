'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { ACCESS_COOKIE, apiFetch, ApiRequestError, REFRESH_COOKIE } from './api';

/**
 * Server Actions.
 *
 * Every mutation the dashboard performs goes through one of these, which means
 * every mutation happens on the server with the session cookie attached. The
 * browser never holds a token and never calls the API directly.
 *
 * Next protects Server Actions against cross-site invocation with its own
 * origin check, so these do not each need a CSRF token — but they *do* each
 * need the API's permission check, which they get by virtue of being ordinary
 * API calls.
 */

export interface ActionResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly fieldErrors?: Record<string, string>;
  /** Set when the API demands a second factor before issuing a session. */
  readonly mfaChallengeToken?: string;
}

function apiUrl(): string {
  return (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/+$/, '');
}

/**
 * Copy the API's session cookies onto this response.
 *
 * The API sets them for its own domain; the dashboard is a different origin,
 * so the values are read out of the API's `set-cookie` and re-set here with
 * the dashboard's own attributes. Doing it this way keeps the token
 * `HttpOnly` end to end — it is never in a response body the browser can read.
 */
async function adoptSession(setCookieHeaders: string[]): Promise<void> {
  const jar = await cookies();
  const isProduction = process.env.NODE_ENV === 'production';

  for (const header of setCookieHeaders) {
    const parts = header.split(';').map((part) => part.trim());
    const [pair, ...attributes] = parts;
    const separator = pair?.indexOf('=') ?? -1;
    if (!pair || separator === -1) continue;

    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (name !== ACCESS_COOKIE && name !== REFRESH_COOKIE) continue;

    // The API decides how long its tokens live; the dashboard's cookie must
    // expire in step or the browser presents a token the server has already
    // let die. Parsed from the API's own Set-Cookie rather than duplicated.
    let maxAge = name === REFRESH_COOKIE ? 2_592_000 : 900;
    for (const attribute of attributes) {
      const [attrName, attrValue] = attribute.split('=');
      if (attrName?.toLowerCase() === 'max-age' && Number(attrValue) > 0) {
        maxAge = Number(attrValue);
      }
    }

    jar.set(name, value, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge,
    });
  }
}

export async function signIn(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  if (!email || !password) {
    return { ok: false, message: 'Enter your email address and password.' };
  }

  const response = await fetch(`${apiUrl()}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
    cache: 'no-store',
  });

  const body = (await response.json().catch(() => ({}))) as {
    mfaRequired?: boolean;
    challengeToken?: string;
    error?: { message?: string };
  };

  if (!response.ok) {
    // The API returns one message for every credential failure on purpose;
    // relaying it verbatim keeps that property rather than re-inventing a
    // more "helpful" one that distinguishes the cases.
    return { ok: false, message: body.error?.message ?? 'Those sign-in details are not correct.' };
  }

  if (body.mfaRequired && body.challengeToken) {
    return { ok: true, mfaChallengeToken: body.challengeToken };
  }

  await adoptSession(response.headers.getSetCookie());
  redirect('/');
}

export async function verifyMfa(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const challengeToken = String(formData.get('challengeToken') ?? '');
  const code = String(formData.get('code') ?? '').trim();

  if (!challengeToken || !code) {
    return { ok: false, message: 'Enter the six-digit code from your authenticator app.' };
  }

  const response = await fetch(`${apiUrl()}/v1/auth/mfa/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeToken, code }),
    cache: 'no-store',
  });

  if (!response.ok) {
    return {
      ok: false,
      message: 'That code was not accepted. Check your authenticator app and try again.',
      mfaChallengeToken: challengeToken,
    };
  }

  await adoptSession(response.headers.getSetCookie());
  redirect('/');
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const refreshToken = jar.get(REFRESH_COOKIE)?.value;

  if (refreshToken) {
    // Best effort: the local cookies are cleared regardless, so a failed call
    // to the API cannot leave somebody apparently signed in.
    await fetch(`${apiUrl()}/v1/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    }).catch(() => undefined);
  }

  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
  redirect('/sign-in');
}

/* ---------------------------------------------------------------- sessions */

export async function revokeSession(sessionId: string): Promise<ActionResult> {
  try {
    await apiFetch(`/v1/auth/sessions/${sessionId}`, {
      method: 'DELETE',
      workspaceScoped: false,
    });
    revalidatePath('/settings');
    return { ok: true, message: 'That session has been signed out.' };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export async function signOutEverywhere(): Promise<void> {
  try {
    await apiFetch('/v1/auth/logout-all', { method: 'POST', workspaceScoped: false });
  } catch {
    // The local cookies are cleared regardless; a failed call must not leave
    // somebody apparently signed in on this device.
  }

  const jar = await cookies();
  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
  redirect('/sign-in');
}

export async function requestPasswordReset(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const email = String(formData.get('email') ?? '').trim();
  if (!email) return { ok: false, message: 'Enter your email address.' };

  await fetch(`${apiUrl()}/v1/auth/password/forgot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
    cache: 'no-store',
  }).catch(() => undefined);

  /*
   * Always the same answer, whether or not the address exists — including when
   * the request itself failed. Anything else turns this form into an
   * account-enumeration tool, and the API is already careful about it.
   */
  return {
    ok: true,
    message: 'If that address has an account, a reset link is on its way.',
  };
}

/* --------------------------------------------------------------------- CRM */

export async function updateLead(leadId: string, formData: FormData): Promise<ActionResult> {
  const patch: Record<string, unknown> = {};

  const stageId = formData.get('stageId');
  if (typeof stageId === 'string' && stageId) patch.stageId = stageId;

  const status = formData.get('status');
  if (typeof status === 'string' && status) patch.status = status;

  const assignedToUserId = formData.get('assignedToUserId');
  if (typeof assignedToUserId === 'string') {
    patch.assignedToUserId = assignedToUserId === '' ? null : assignedToUserId;
  }

  if (Object.keys(patch).length === 0) return { ok: true };

  try {
    await apiFetch(`/v1/crm/leads/${leadId}`, { method: 'PATCH', body: patch });
    revalidatePath(`/leads/${leadId}`);
    revalidatePath('/leads');
    return { ok: true };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export async function addLeadNote(leadId: string, formData: FormData): Promise<ActionResult> {
  const body = String(formData.get('body') ?? '').trim();
  if (!body) return { ok: false, message: 'A note cannot be empty.' };

  try {
    await apiFetch(`/v1/crm/leads/${leadId}/notes`, { method: 'POST', body: { body } });
    revalidatePath(`/leads/${leadId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export async function addLeadTask(leadId: string, formData: FormData): Promise<ActionResult> {
  const title = String(formData.get('title') ?? '').trim();
  const dueAt = String(formData.get('dueAt') ?? '');
  if (!title) return { ok: false, message: 'A task needs a title.' };

  try {
    await apiFetch(`/v1/crm/leads/${leadId}/tasks`, {
      method: 'POST',
      body: { title, ...(dueAt ? { dueAt: new Date(dueAt).toISOString() } : {}) },
    });
    revalidatePath(`/leads/${leadId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export async function completeTask(taskId: string, leadId: string): Promise<ActionResult> {
  try {
    await apiFetch(`/v1/crm/tasks/${taskId}`, { method: 'PATCH', body: { status: 'done' } });
    revalidatePath(`/leads/${leadId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/* ------------------------------------------------------------------- CMS */

export async function setContentStatus(
  contentId: string,
  status: 'draft' | 'published' | 'archived',
): Promise<ActionResult> {
  try {
    await apiFetch(`/v1/cms/content/${contentId}/status`, { method: 'POST', body: { status } });
    revalidatePath('/content');
    revalidatePath(`/content/${contentId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export async function saveContent(contentId: string, formData: FormData): Promise<ActionResult> {
  const title = String(formData.get('title') ?? '').trim();
  const excerpt = String(formData.get('excerpt') ?? '').trim();
  const documentJson = String(formData.get('document') ?? '');

  if (!title) return { ok: false, message: 'A page needs a title.' };

  let document: unknown;
  try {
    document = JSON.parse(documentJson);
  } catch {
    return {
      ok: false,
      message: 'The section document is not valid JSON.',
      fieldErrors: { document: 'Check for a missing comma or bracket.' },
    };
  }

  try {
    const result = await apiFetch<{ warnings?: string[] }>(`/v1/cms/content/${contentId}`, {
      method: 'PATCH',
      body: { title, excerpt, document },
    });

    revalidatePath(`/content/${contentId}`);
    revalidatePath('/content');

    // Sanitisation warnings are surfaced rather than swallowed: an editor whose
    // link was dropped should be told which one and why.
    return {
      ok: true,
      ...(result.warnings && result.warnings.length > 0
        ? { message: result.warnings.join(' ') }
        : {}),
    };
  } catch (error) {
    return { ok: false, message: describe(error), ...fieldErrorsFrom(error) };
  }
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.isUnauthenticated) return 'Your session has expired. Please sign in again.';
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}

function fieldErrorsFrom(error: unknown): { fieldErrors?: Record<string, string> } {
  if (!(error instanceof ApiRequestError) || !Array.isArray(error.details)) return {};

  const fieldErrors: Record<string, string> = {};
  for (const detail of error.details as { path?: string; message?: string }[]) {
    if (detail.path && detail.message) fieldErrors[detail.path] = detail.message;
  }
  return Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {};
}
