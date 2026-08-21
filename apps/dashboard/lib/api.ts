import { cookies } from 'next/headers';

/**
 * The dashboard's one way of talking to the API.
 *
 * Every call is made **server-side**, from a Server Component or a Server
 * Action, and the session cookie is forwarded rather than read. That has three
 * consequences worth stating, because they are the reason this file exists
 * rather than a browser fetch wrapper:
 *
 *  1. The access token never reaches client JavaScript. It is `HttpOnly`, so
 *     an injected script cannot read it even if one runs.
 *  2. There is no CORS preflight and no token refresh dance in the browser.
 *  3. The API's permission check is the *only* authorisation in the system.
 *     The dashboard hides what a user cannot do, but hiding is a courtesy —
 *     every request is re-checked server-side, and a hand-crafted one is
 *     refused the same way.
 */

const ACCESS_COOKIE = 'bos_access';
const REFRESH_COOKIE = 'bos_refresh';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** True when the session is gone and the caller should redirect to sign-in. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

function apiUrl(): string {
  const url = process.env.NEXT_PUBLIC_API_URL;
  if (!url) throw new Error('NEXT_PUBLIC_API_URL is not set — the dashboard has no API to call.');
  return url.replace(/\/+$/, '');
}

function workspaceSlug(): string {
  const slug = process.env.BOS_WORKSPACE_SLUG;
  if (!slug) throw new Error('BOS_WORKSPACE_SLUG is not set.');
  return slug;
}

export interface ApiCallOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  /** Send the workspace header. Off for account-level calls such as `/me`. */
  readonly workspaceScoped?: boolean;
  readonly accessToken?: string;
}

/**
 * Multipart variant of {@link apiFetch}, for the media upload.
 *
 * Separate rather than a flag because the two share almost nothing: no JSON
 * content type (the boundary header must come from the body), a longer
 * timeout, and a FormData body passed through untouched.
 */
export async function apiUpload<T>(path: string, formData: FormData): Promise<T> {
  const jar = await cookies();
  const token = jar.get(ACCESS_COOKIE)?.value;

  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  headers['x-bos-workspace'] = workspaceSlug();

  const response = await fetch(`${apiUrl()}${path}`, {
    method: 'POST',
    headers,
    body: formData,
    cache: 'no-store',
    signal: AbortSignal.timeout(60_000),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string; details?: unknown };
  };

  if (!response.ok) {
    throw new ApiRequestError(
      response.status,
      payload.error?.code ?? 'request_failed',
      payload.error?.message ?? `The API responded ${response.status}.`,
      payload.error?.details,
    );
  }

  return payload as T;
}

export async function apiFetch<T>(path: string, options: ApiCallOptions = {}): Promise<T> {
  const jar = await cookies();
  const token = options.accessToken ?? jar.get(ACCESS_COOKIE)?.value;

  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.workspaceScoped !== false) headers['x-bos-workspace'] = workspaceSlug();
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${apiUrl()}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    // The dashboard shows live operational data. A cached lead list is a lead
    // somebody has already picked up being handed to a second person.
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });

  if (response.status === 204) return undefined as T;

  const payload = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string; details?: unknown };
  };

  if (!response.ok) {
    throw new ApiRequestError(
      response.status,
      payload.error?.code ?? 'request_failed',
      payload.error?.message ?? `The API responded ${response.status}.`,
      payload.error?.details,
    );
  }

  return payload as T;
}

/* --------------------------------------------------------------- session */

export interface SessionUser {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string | null;
  readonly mfaEnabled: boolean;
}

export interface SessionWorkspace {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly role: string;
  readonly permissions: readonly string[];
  readonly enabledModules: readonly string[];
}

export interface Session {
  readonly user: SessionUser;
  readonly workspaces: readonly SessionWorkspace[];
  /** The workspace this deployment serves, when the user belongs to it. */
  readonly workspace: SessionWorkspace | undefined;
}

/**
 * Resolve the current session, or null.
 *
 * Returns null rather than redirecting so a caller can choose: a page
 * redirects to sign-in, while a layout may want to render a shell.
 */
export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  if (!jar.get(ACCESS_COOKIE)?.value) return null;

  try {
    const body = await apiFetch<{ user: SessionUser; workspaces: SessionWorkspace[] }>(
      '/v1/auth/me',
      { workspaceScoped: false },
    );

    const slug = process.env.BOS_WORKSPACE_SLUG;
    return {
      user: body.user,
      workspaces: body.workspaces,
      workspace: body.workspaces.find((candidate) => candidate.slug === slug),
    };
  } catch (error) {
    if (error instanceof ApiRequestError && error.isUnauthenticated) return null;
    throw error;
  }
}

/**
 * Whether the signed-in user holds a permission in the active workspace.
 *
 * Used to hide navigation and buttons. It is not an authorisation check — the
 * API is — and treating it as one is how a UI-only check becomes the only
 * check.
 */
export function can(session: Session | null, permission: string): boolean {
  return session?.workspace?.permissions.includes(permission) ?? false;
}

export { ACCESS_COOKIE, REFRESH_COOKIE };
