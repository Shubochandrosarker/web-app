'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { ACCESS_COOKIE, apiFetch, apiUpload, ApiRequestError, REFRESH_COOKIE } from './api';

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
    if (leadId) revalidatePath(`/leads/${leadId}`);
    revalidatePath('/tasks');
    return { ok: true };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export async function reopenTask(taskId: string, leadId?: string): Promise<ActionResult> {
  try {
    await apiFetch(`/v1/crm/tasks/${taskId}`, { method: 'PATCH', body: { status: 'open' } });
    if (leadId) revalidatePath(`/leads/${leadId}`);
    revalidatePath('/tasks');
    return { ok: true };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/* ------------------------------------------------------------------- CMS */

export async function setContentStatus(
  contentId: string,
  status: 'draft' | 'published' | 'scheduled' | 'archived',
  publishAt?: string,
): Promise<ActionResult> {
  try {
    await apiFetch(`/v1/cms/content/${contentId}/status`, {
      method: 'POST',
      body: { status, ...(publishAt ? { publishAt } : {}) },
    });
    revalidatePath('/content');
    revalidatePath(`/content/${contentId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export interface ContentPayload {
  readonly title: string;
  readonly excerpt: string;
  readonly document: { sections: unknown[] };
  readonly seo?: {
    readonly title: string;
    readonly description: string;
    readonly canonicalUrl: string;
    readonly noindex: boolean;
    readonly nofollow: boolean;
  };
}

export async function saveContent(
  contentId: string,
  payload: ContentPayload,
  options: { autosave?: boolean } = {},
): Promise<ActionResult> {
  const title = payload.title.trim();
  if (!title) return { ok: false, message: 'A page needs a title.' };

  try {
    const result = await apiFetch<{ warnings?: string[] }>(`/v1/cms/content/${contentId}`, {
      method: 'PATCH',
      body: {
        title,
        excerpt: payload.excerpt.trim(),
        document: payload.document,
        ...(payload.seo
          ? {
              seo: {
                title: payload.seo.title.trim() || undefined,
                description: payload.seo.description.trim() || undefined,
                canonicalUrl: payload.seo.canonicalUrl.trim() || undefined,
                noindex: payload.seo.noindex,
                nofollow: payload.seo.nofollow,
              },
            }
          : {}),
      },
    });

    /*
     * Autosaves do not revalidate: refreshing the RSC tree under an editor
     * mid-thought replaces the form they are typing into. The explicit save
     * refreshes the list and detail views like any other mutation.
     */
    if (!options.autosave) {
      revalidatePath(`/content/${contentId}`);
      revalidatePath('/content');
    }

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

export async function createContent(input: {
  type: string;
  title: string;
  slug: string;
  path: string;
  locale: string;
}): Promise<ActionResult & { id?: string }> {
  try {
    const created = await apiFetch<{ id: string }>('/v1/cms/content', {
      method: 'POST',
      body: {
        type: input.type,
        title: input.title,
        slug: input.slug,
        path: input.path,
        locale: input.locale,
        document: { sections: [] },
      },
    });
    revalidatePath('/content');
    return { ok: true, id: created.id };
  } catch (error) {
    return { ok: false, message: describe(error), ...fieldErrorsFrom(error) };
  }
}

export async function duplicateContent(contentId: string): Promise<ActionResult & { id?: string }> {
  try {
    const source = await apiFetch<{
      type: string;
      title: string;
      slug: string;
      path: string;
      locale: string;
      excerpt: string | null;
      document: unknown;
    }>(`/v1/cms/content/${contentId}`);

    const suffix = `-copy-${Date.now().toString(36).slice(-4)}`;
    const created = await apiFetch<{ id: string }>('/v1/cms/content', {
      method: 'POST',
      body: {
        type: source.type,
        title: `${source.title} (copy)`,
        slug: `${source.slug}${suffix}`,
        path: `${source.path}${suffix}`,
        locale: source.locale,
        excerpt: source.excerpt ?? undefined,
        document: source.document,
      },
    });
    revalidatePath('/content');
    return { ok: true, id: created.id, message: 'Page duplicated as a draft.' };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export async function archiveContent(contentId: string): Promise<ActionResult> {
  try {
    await apiFetch(`/v1/cms/content/${contentId}/status`, {
      method: 'POST',
      body: { status: 'archived' },
    });
    revalidatePath('/content');
    revalidatePath(`/content/${contentId}`);
    return { ok: true, message: 'Page archived.' };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export async function restoreRevision(contentId: string, revision: number): Promise<ActionResult> {
  try {
    await apiFetch(`/v1/cms/content/${contentId}/revisions/${revision}/restore`, {
      method: 'POST',
      body: {},
    });
    revalidatePath(`/content/${contentId}`);
    return { ok: true, message: `Revision ${revision} restored.` };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/**
 * Mint a preview link for a draft.
 *
 * Returns the URL in `message` — the one field ActionResult carries — so the
 * client can open it. The token inside it dies on its own in minutes.
 */
export async function createPreview(contentId: string): Promise<ActionResult> {
  try {
    const minted = await apiFetch<{ token: string }>(`/v1/cms/content/${contentId}/preview-token`, {
      method: 'POST',
      body: {},
    });
    const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/+$/, '');
    return { ok: true, message: `${siteUrl}/preview?token=${encodeURIComponent(minted.token)}` };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/* -------------------------------------------------------------- services */

export interface ServicePayload {
  readonly name: string;
  readonly slug: string;
  readonly summary: string | null;
  readonly status: 'draft' | 'scheduled' | 'published' | 'archived';
  readonly priceAmount: number | null;
  readonly priceCurrency: string | null;
  readonly priceNote: string | null;
  readonly durationMinutes: number | null;
  readonly turnaroundNote: string | null;
  readonly requirements: string[];
  readonly bookable: boolean;
}

export async function saveService(
  serviceId: string | null,
  input: ServicePayload,
): Promise<ActionResult & { id?: string }> {
  if (!input.name.trim()) return { ok: false, message: 'A service needs a name.' };
  if (!input.slug.trim()) return { ok: false, message: 'A service needs a URL slug.' };

  try {
    const result = await apiFetch<{ service: { id: string } }>(
      serviceId ? `/v1/services/${serviceId}` : '/v1/services',
      {
        method: serviceId ? 'PATCH' : 'POST',
        body: {
          ...input,
          name: input.name.trim(),
          slug: input.slug.trim().toLowerCase(),
          summary: input.summary?.trim() || null,
          priceNote: input.priceNote?.trim() || null,
          turnaroundNote: input.turnaroundNote?.trim() || null,
          requirements: input.requirements.map((item) => item.trim()).filter(Boolean),
        },
      },
    );
    revalidatePath('/services');
    if (serviceId) revalidatePath(`/services/${serviceId}`);
    return { ok: true, id: result.service.id, message: 'Service saved.' };
  } catch (error) {
    return { ok: false, message: describe(error), ...fieldErrorsFrom(error) };
  }
}

export async function archiveService(serviceId: string): Promise<ActionResult> {
  try {
    await apiFetch(`/v1/services/${serviceId}/archive`, { method: 'POST', body: {} });
    revalidatePath('/services');
    revalidatePath(`/services/${serviceId}`);
    return { ok: true, message: 'Service archived.' };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export async function duplicateService(serviceId: string): Promise<ActionResult & { id?: string }> {
  try {
    const result = await apiFetch<{ service: { id: string } }>(
      `/v1/services/${serviceId}/duplicate`,
      {
        method: 'POST',
        body: {},
      },
    );
    revalidatePath('/services');
    return { ok: true, id: result.service.id, message: 'Service duplicated as a draft.' };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/* ------------------------------------------------------------- locations */

export interface LocationPayload {
  readonly slug: string;
  readonly legalName: string;
  readonly displayName: string;
  readonly streetAddress: string;
  readonly addressLocality: string;
  readonly addressRegion: string | null;
  readonly postalCode: string | null;
  readonly addressCountry: string;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly telephone: string;
  readonly whatsapp: string | null;
  readonly email: string;
  readonly openingHours: string[];
  readonly areaServed: string[];
  readonly sameAs: string[];
  readonly googleBusinessProfileUrl: string | null;
  readonly isPrimary: boolean;
}

export async function saveLocation(
  locationId: string | null,
  input: LocationPayload,
): Promise<ActionResult & { id?: string }> {
  if (!input.displayName.trim()) return { ok: false, message: 'A location needs a display name.' };
  try {
    const result = await apiFetch<{ location: { id: string } }>(
      locationId ? `/v1/locations/${locationId}` : '/v1/locations',
      {
        method: locationId ? 'PATCH' : 'POST',
        body: {
          ...input,
          slug: input.slug.trim().toLowerCase(),
          legalName: input.legalName.trim(),
          displayName: input.displayName.trim(),
          streetAddress: input.streetAddress.trim(),
          addressLocality: input.addressLocality.trim(),
          addressRegion: input.addressRegion?.trim() || null,
          postalCode: input.postalCode?.trim() || null,
          addressCountry: input.addressCountry.trim().toUpperCase(),
          telephone: input.telephone.trim(),
          whatsapp: input.whatsapp?.trim() || null,
          email: input.email.trim(),
          latitude: input.latitude?.trim() || null,
          longitude: input.longitude?.trim() || null,
          openingHours: input.openingHours.map((item) => item.trim()).filter(Boolean),
          areaServed: input.areaServed.map((item) => item.trim()).filter(Boolean),
          sameAs: input.sameAs.map((item) => item.trim()).filter(Boolean),
          googleBusinessProfileUrl: input.googleBusinessProfileUrl?.trim() || null,
        },
      },
    );
    revalidatePath('/local-seo');
    if (locationId) revalidatePath(`/local-seo/${locationId}`);
    return { ok: true, id: result.location.id, message: 'Location saved.' };
  } catch (error) {
    return { ok: false, message: describe(error), ...fieldErrorsFrom(error) };
  }
}

export async function archiveLocation(locationId: string): Promise<ActionResult> {
  try {
    await apiFetch(`/v1/locations/${locationId}/archive`, { method: 'POST', body: {} });
    revalidatePath('/local-seo');
    revalidatePath(`/local-seo/${locationId}`);
    return { ok: true, message: 'Location archived.' };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/* --------------------------------------------------------- communications */

export async function sendLeadWhatsapp(
  leadId: string,
  templateSlug: string,
  variables: readonly string[],
): Promise<ActionResult> {
  try {
    await apiFetch(`/v1/crm/leads/${leadId}/whatsapp`, {
      method: 'POST',
      body: { templateSlug, variables },
    });
    revalidatePath(`/leads/${leadId}`);
    return { ok: true, message: 'Message sent.' };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/* -------------------------------------------------------------- documents */

/**
 * Mint a download link for a clean document.
 *
 * The URL comes back in `message`; it lives for minutes and every issuance is
 * audited server-side before the URL exists.
 */
export async function requestDocumentDownload(documentId: string): Promise<ActionResult> {
  try {
    const minted = await apiFetch<{ url: string }>(`/v1/documents/${documentId}/download-url`, {
      method: 'POST',
      body: {},
    });
    return { ok: true, message: minted.url };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export async function removeDocument(documentId: string): Promise<ActionResult> {
  try {
    await apiFetch(`/v1/documents/${documentId}`, { method: 'DELETE' });
    revalidatePath('/documents');
    return { ok: true, message: 'Document deleted. The file is gone from storage.' };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/* ------------------------------------------------------------------ media */

export async function uploadMedia(formData: FormData): Promise<ActionResult & { id?: string }> {
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'Choose an image to upload.' };
  }

  try {
    const body = new FormData();
    body.set('file', file, file.name);
    const created = await apiUpload<{ id: string; deduplicated?: boolean }>('/v1/cms/media', body);
    revalidatePath('/media');
    return {
      ok: true,
      id: created.id,
      message: created.deduplicated
        ? 'That exact image was already in the library.'
        : 'Image uploaded.',
    };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export async function updateMedia(
  mediaId: string,
  input: { alt?: string; caption?: string },
): Promise<ActionResult> {
  try {
    await apiFetch(`/v1/cms/media/${mediaId}`, { method: 'PATCH', body: input });
    revalidatePath('/media');
    return { ok: true, message: 'Saved.' };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export async function deleteMedia(mediaId: string): Promise<ActionResult> {
  try {
    await apiFetch(`/v1/cms/media/${mediaId}`, { method: 'DELETE' });
    revalidatePath('/media');
    return { ok: true, message: 'Image deleted.' };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/* ------------------------------------------------------------------ forms */

export async function saveForm(
  formId: string | null,
  definition: Record<string, unknown>,
): Promise<ActionResult & { id?: string }> {
  try {
    if (formId) {
      await apiFetch(`/v1/cms/forms/${formId}`, { method: 'PATCH', body: definition });
      revalidatePath(`/forms/${formId}`);
      revalidatePath('/forms');
      return { ok: true, id: formId, message: 'Form saved.' };
    }
    const created = await apiFetch<{ id: string }>('/v1/cms/forms', {
      method: 'POST',
      body: definition,
    });
    revalidatePath('/forms');
    return { ok: true, id: created.id, message: 'Form created.' };
  } catch (error) {
    return { ok: false, message: describe(error), ...fieldErrorsFrom(error) };
  }
}

/* ------------------------------------------------------------ automations */

interface BuilderPredicateInput {
  path: string;
  comparator: string;
  value: string;
}

interface BuilderConditionInput {
  match: 'all' | 'any';
  predicates: BuilderPredicateInput[];
}

type BuilderStepInput =
  | {
      id: string;
      type: 'action';
      action: string;
      config: Record<string, string>;
      retry: { maxAttempts: number; backoffSeconds: number };
    }
  | { id: string; type: 'wait'; seconds: number }
  | {
      id: string;
      type: 'wait_for_event';
      event: string;
      correlateOn: string;
      timeoutSeconds: number;
    }
  | {
      id: string;
      type: 'branch';
      condition: BuilderConditionInput;
      then: BuilderStepInput[];
      otherwise: BuilderStepInput[];
    };

export interface BuilderDefinitionInput {
  name: string;
  description: string;
  triggerEvent: string;
  condition: BuilderConditionInput | null;
  steps: BuilderStepInput[];
  reentry: 'once_per_contact' | 'once_per_entity' | 'always';
}

function apiCondition(condition: BuilderConditionInput): Record<string, unknown> {
  return {
    match: condition.match,
    predicates: condition.predicates.map((predicate) => ({
      path: predicate.path,
      comparator: predicate.comparator,
      // is_set / is_not_set take no value; sending one would be noise.
      ...(predicate.comparator === 'is_set' || predicate.comparator === 'is_not_set'
        ? {}
        : { value: predicate.value }),
    })),
  };
}

/** Translate a builder step into the definition language the API stores. */
function apiStep(step: BuilderStepInput): Record<string, unknown> {
  switch (step.type) {
    case 'wait':
      return { id: step.id, type: 'wait', seconds: step.seconds };
    case 'wait_for_event':
      return {
        id: step.id,
        type: 'wait_for_event',
        event: step.event,
        correlateOn: step.correlateOn,
        timeoutSeconds: step.timeoutSeconds,
      };
    case 'branch':
      return {
        id: step.id,
        type: 'branch',
        condition: apiCondition(step.condition),
        then: step.then.map(apiStep),
        otherwise: step.otherwise.map(apiStep),
      };
    case 'action': {
      const raw = step.config;
      let config: Record<string, unknown>;
      switch (step.action) {
        case 'send_whatsapp': {
          // The builder stores variable1..variableN; the engine wants an array.
          const indexes = Object.keys(raw)
            .map((key) => /^variable(\d+)$/.exec(key)?.[1])
            .filter((index): index is string => index !== undefined)
            .map(Number);
          const count = indexes.length > 0 ? Math.max(...indexes) : 0;
          config = {
            templateSlug: raw.templateSlug ?? '',
            variables: Array.from({ length: count }, (_, i) => raw[`variable${i + 1}`] ?? ''),
          };
          break;
        }
        case 'send_email':
        case 'notify_admin':
          config = {
            ...(raw.to ? { to: raw.to } : {}),
            subject: raw.subject ?? '',
            body: raw.body ?? '',
          };
          break;
        case 'create_task':
          config = {
            title: raw.title ?? '',
            ...(raw.dueInHours ? { dueInHours: Number(raw.dueInHours) || 0 } : {}),
            ...(raw.assignedToUserId ? { assignedToUserId: raw.assignedToUserId } : {}),
          };
          break;
        case 'update_lead':
          config = {
            ...(raw.stageId ? { stageId: raw.stageId } : {}),
            ...(raw.status ? { status: raw.status } : {}),
          };
          break;
        default:
          config = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== ''));
      }
      return { id: step.id, type: 'action', action: step.action, config, retry: step.retry };
    }
  }
}

export async function saveAutomation(
  automationId: string | null,
  builder: BuilderDefinitionInput,
): Promise<ActionResult & { id?: string }> {
  const body = {
    name: builder.name,
    ...(builder.description ? { description: builder.description } : {}),
    trigger: { kind: 'event', event: builder.triggerEvent },
    ...(builder.condition && builder.condition.predicates.some((p) => p.path)
      ? { condition: apiCondition(builder.condition) }
      : {}),
    steps: builder.steps.map(apiStep),
    reentry: builder.reentry,
  };

  try {
    if (automationId) {
      await apiFetch(`/v1/automations/${automationId}`, { method: 'PUT', body });
      revalidatePath(`/automations/${automationId}`);
      revalidatePath('/automations');
      return { ok: true, id: automationId, message: 'Automation saved as a new version.' };
    }
    const created = await apiFetch<{ id: string }>('/v1/automations', { method: 'POST', body });
    revalidatePath('/automations');
    return { ok: true, id: created.id, message: 'Automation created. Turn it on when ready.' };
  } catch (error) {
    return { ok: false, message: describe(error), ...fieldErrorsFrom(error) };
  }
}

export async function setAutomationEnabled(
  automationId: string,
  enabled: boolean,
): Promise<ActionResult> {
  try {
    await apiFetch(`/v1/automations/${automationId}`, { method: 'PATCH', body: { enabled } });
    revalidatePath(`/automations/${automationId}`);
    revalidatePath('/automations');
    return { ok: true, message: enabled ? 'Automation turned on.' : 'Automation turned off.' };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export async function deleteAutomation(automationId: string): Promise<ActionResult> {
  try {
    await apiFetch(`/v1/automations/${automationId}`, { method: 'DELETE' });
    revalidatePath('/automations');
    return { ok: true, message: 'Automation deleted.' };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export async function retryAutomationRun(
  automationId: string,
  runId: string,
): Promise<ActionResult> {
  try {
    await apiFetch(`/v1/automations/runs/${runId}/retry`, { method: 'POST', body: {} });
    revalidatePath(`/automations/${automationId}`);
    return { ok: true, message: 'Run resumed from the failed step.' };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export interface SeoSuggestions {
  readonly metaTitle?: string;
  readonly metaDescription?: string;
  readonly questionsToAnswer: readonly string[];
  readonly internalLinkSuggestions: readonly { toPath: string; anchor: string }[];
  readonly improvements: readonly string[];
}

export async function suggestSeoImprovements(
  contentId: string,
): Promise<ActionResult & { suggestions?: SeoSuggestions | null; notes?: string }> {
  try {
    const result = await apiFetch<{
      suggestions: SeoSuggestions | null;
      notes?: string;
      provider: string;
    }>('/v1/seo/suggestions', { method: 'POST', body: { contentId } });
    return {
      ok: true,
      suggestions: result.suggestions,
      ...(result.notes ? { notes: result.notes } : {}),
      message: `Suggestions from ${result.provider} — review before applying anything.`,
    };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/* --------------------------------------------------------------- reviews */

export interface ReviewPayload {
  readonly source: 'internal' | 'google' | 'facebook' | 'other';
  readonly externalId: string | null;
  readonly authorName: string;
  readonly rating: number;
  readonly title: string | null;
  readonly body: string | null;
  readonly contactId: string | null;
  readonly response: string | null;
  readonly reviewedAt?: string;
}

export async function saveReview(
  reviewId: string | null,
  input: ReviewPayload,
): Promise<ActionResult & { id?: string }> {
  if (!input.authorName.trim()) return { ok: false, message: 'A review needs an author name.' };
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
    return { ok: false, message: 'Rating must be between one and five.' };
  }

  try {
    const result = await apiFetch<{ review: { id: string } }>(
      reviewId ? `/v1/reviews/${reviewId}` : '/v1/reviews',
      {
        method: reviewId ? 'PATCH' : 'POST',
        body: {
          ...input,
          authorName: input.authorName.trim(),
          externalId: input.externalId?.trim() || null,
          title: input.title?.trim() || null,
          body: input.body?.trim() || null,
          contactId: input.contactId?.trim() || null,
          response: input.response?.trim() || null,
        },
      },
    );
    revalidatePath('/reviews');
    if (reviewId) revalidatePath(`/reviews/${reviewId}`);
    return { ok: true, id: result.review.id, message: 'Review saved.' };
  } catch (error) {
    return { ok: false, message: describe(error), ...fieldErrorsFrom(error) };
  }
}

export async function moderateReview(reviewId: string, approved: boolean): Promise<ActionResult> {
  try {
    await apiFetch(`/v1/reviews/${reviewId}/${approved ? 'approve' : 'reject'}`, {
      method: 'POST',
      body: {},
    });
    revalidatePath('/reviews');
    revalidatePath(`/reviews/${reviewId}`);
    return { ok: true, message: approved ? 'Review approved.' : 'Review rejected.' };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/* ----------------------------------------------------------- appointments */

export interface AppointmentPayload {
  readonly contactId: string;
  readonly leadId: string | null;
  readonly serviceId: string | null;
  readonly staffProfileId: string | null;
  readonly locationId: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
  readonly channel: 'on_site' | 'phone' | 'video' | 'whatsapp';
  readonly meetingUrl: string | null;
  readonly notes: string | null;
  readonly status?: 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
}

export async function saveAppointment(
  appointmentId: string | null,
  input: AppointmentPayload,
): Promise<ActionResult & { id?: string }> {
  if (!input.contactId.trim()) return { ok: false, message: 'A contact is required.' };
  if (!input.startsAt || !input.endsAt)
    return { ok: false, message: 'Start and end times are required.' };

  try {
    const startsAt = new Date(input.startsAt).toISOString();
    const endsAt = new Date(input.endsAt).toISOString();
    const result = await apiFetch<{ appointment: { id: string } }>(
      appointmentId ? `/v1/appointments/${appointmentId}` : '/v1/appointments',
      {
        method: appointmentId ? 'PATCH' : 'POST',
        body: {
          ...input,
          startsAt,
          endsAt,
          contactId: input.contactId.trim(),
          leadId: input.leadId?.trim() || null,
          serviceId: input.serviceId?.trim() || null,
          staffProfileId: input.staffProfileId?.trim() || null,
          locationId: input.locationId?.trim() || null,
          meetingUrl: input.meetingUrl?.trim() || null,
          notes: input.notes?.trim() || null,
        },
      },
    );
    revalidatePath('/appointments');
    if (appointmentId) revalidatePath(`/appointments/${appointmentId}`);
    return { ok: true, id: result.appointment.id, message: 'Appointment saved.' };
  } catch (error) {
    return { ok: false, message: describe(error), ...fieldErrorsFrom(error) };
  }
}

export async function cancelAppointment(
  appointmentId: string,
  reason?: string,
): Promise<ActionResult> {
  try {
    await apiFetch(`/v1/appointments/${appointmentId}/cancel`, {
      method: 'POST',
      body: { reason: reason?.trim() || null },
    });
    revalidatePath('/appointments');
    revalidatePath(`/appointments/${appointmentId}`);
    return { ok: true, message: 'Appointment cancelled.' };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/* ----------------------------------------------------------------- orders */

export interface OrderItemPayload {
  readonly serviceId: string | null;
  readonly name: string;
  readonly quantity: number;
  readonly unitAmount: number;
}

export interface OrderPayload {
  readonly contactId: string;
  readonly leadId: string | null;
  readonly currency: string;
  readonly discountAmount: number;
  readonly notes: string | null;
  readonly items: OrderItemPayload[];
}

export async function saveOrder(
  orderId: string | null,
  input: OrderPayload,
  options: { readonly notesOnly?: boolean } = {},
): Promise<ActionResult & { id?: string }> {
  if (!orderId && !input.contactId.trim()) {
    return { ok: false, message: 'An order needs a contact.' };
  }
  if (!options.notesOnly && input.items.length === 0) {
    return { ok: false, message: 'An order needs at least one line.' };
  }

  const items = input.items.map((item) => ({
    serviceId: item.serviceId?.trim() || null,
    name: item.name.trim() || undefined,
    quantity: item.quantity,
    unitAmount: item.unitAmount,
  }));

  try {
    const result = await apiFetch<{ order: { id: string } }>(
      orderId ? `/v1/orders/${orderId}` : '/v1/orders',
      {
        method: orderId ? 'PATCH' : 'POST',
        body: orderId
          ? options.notesOnly
            ? { notes: input.notes?.trim() || null }
            : { notes: input.notes?.trim() || null, discountAmount: input.discountAmount, items }
          : {
              contactId: input.contactId.trim(),
              leadId: input.leadId?.trim() || null,
              currency: input.currency.trim().toUpperCase(),
              discountAmount: input.discountAmount,
              notes: input.notes?.trim() || null,
              items,
            },
      },
    );
    revalidatePath('/orders');
    if (orderId) revalidatePath(`/orders/${orderId}`);
    return { ok: true, id: result.order.id, message: 'Order saved.' };
  } catch (error) {
    return { ok: false, message: describe(error), ...fieldErrorsFrom(error) };
  }
}

export async function setOrderStatus(
  orderId: string,
  status: string,
  reason?: string,
): Promise<ActionResult> {
  try {
    await apiFetch(`/v1/orders/${orderId}/status`, {
      method: 'POST',
      body: { status, reason: reason?.trim() || null },
    });
    revalidatePath('/orders');
    revalidatePath(`/orders/${orderId}`);
    return { ok: true, message: `Order moved to ${status.replace('_', ' ')}.` };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export async function recordOrderPayment(
  orderId: string,
  input: {
    readonly method: string;
    readonly amount: number;
    readonly reference: string | null;
    readonly notes: string | null;
  },
): Promise<ActionResult> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    return { ok: false, message: 'The amount must be a positive whole number in minor units.' };
  }
  try {
    await apiFetch(`/v1/orders/${orderId}/payments`, {
      method: 'POST',
      body: {
        method: input.method,
        amount: input.amount,
        reference: input.reference?.trim() || null,
        notes: input.notes?.trim() || null,
        verified: true,
      },
    });
    revalidatePath(`/orders/${orderId}`);
    return { ok: true, message: 'Payment recorded.' };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export async function refundOrderPayment(
  orderId: string,
  paymentId: string,
): Promise<ActionResult> {
  try {
    await apiFetch(`/v1/orders/${orderId}/payments/${paymentId}/refund`, {
      method: 'POST',
      body: {},
    });
    revalidatePath(`/orders/${orderId}`);
    return { ok: true, message: 'Payment marked refunded.' };
  } catch (error) {
    return { ok: false, message: describe(error) };
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
