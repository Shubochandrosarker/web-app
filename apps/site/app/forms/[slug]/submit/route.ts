import type { NextRequest } from 'next/server';

/**
 * The no-JavaScript submission path.
 *
 * The form's markup posts here natively (`action`/`method`); with JavaScript
 * available the client handler intercepts and calls the API directly, so this
 * route only ever serves visitors without script. It normalises the
 * urlencoded body into the **same JSON contract** the API enforces — one
 * validation surface, two transports — and answers with a plain HTML page,
 * because a JSON body is meaningless to a browser that ran no script.
 *
 * File uploads and Turnstile both require JavaScript by nature; without it,
 * the submission simply omits them and the server-side spam heuristics
 * (honeypot, timing) still apply. If the tenant enforces Turnstile, the API
 * refuses and the refusal is shown honestly.
 */

export const dynamic = 'force-dynamic';

function page(title: string, bodyHtml: string, backHref: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem 1rem; background: #f8fafc; color: #111827; }
  main { max-width: 32rem; margin: 10vh auto; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 2rem; }
  h1 { font-size: 1.35rem; margin-top: 0; }
  a { color: #1a56db; }
  ul { padding-left: 1.2rem; }
</style>
</head>
<body>
<main>
${bodyHtml}
<p><a href="${escapeHtml(backHref)}">← Go back</a></p>
</main>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const apiUrl = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/+$/, '');
  const workspace = process.env.BOS_WORKSPACE_SLUG ?? '';

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return page('Something went wrong', '<h1>That submission could not be read.</h1>', '/');
  }

  // The form declares which of its fields are checkboxes — the one type
  // whose urlencoded value ("on"/absent) is not its JSON value (boolean).
  const checkboxNames = new Set(
    String(formData.get('_bos_checkboxes') ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
  // A same-origin native POST sends the full referring path (the default
  // strict-origin-when-cross-origin policy only trims it cross-origin), which
  // is exactly the landing page the visitor submitted from.
  const referer = request.headers.get('referer');
  let landingPath = '/';
  if (referer) {
    try {
      landingPath = new URL(referer).pathname || '/';
    } catch {
      landingPath = '/';
    }
  }
  const locale = String(formData.get('_bos_locale') ?? '') || undefined;

  const values: Record<string, string | boolean> = {};
  for (const [name, raw] of formData.entries()) {
    if (name.startsWith('_bos_') || name === 'consent' || name === 'cf-turnstile-response') {
      continue;
    }
    if (typeof raw !== 'string') continue; // No-JS cannot upload files.
    if (checkboxNames.has(name)) continue; // Handled below, absent = false.
    values[name] = raw;
  }
  for (const name of checkboxNames) {
    values[name] = formData.get(name) === 'on';
  }

  const response = await fetch(
    `${apiUrl}/v1/forms/${encodeURIComponent(slug)}/submissions?workspace=${encodeURIComponent(workspace)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        values,
        consent: formData.get('consent') === 'on',
        landingPath,
        ...(locale ? { locale } : {}),
        // No elapsedMs and no Turnstile token: neither exists without script.
        // The API weighs what it does have (honeypot, content) accordingly.
      }),
      signal: AbortSignal.timeout(15_000),
    },
  ).catch(() => null);

  if (!response) {
    return page(
      'Please try again',
      '<h1>We could not reach the server.</h1><p>Nothing was sent. Please go back and try again in a moment.</p>',
      landingPath,
    );
  }

  const body = (await response.json().catch(() => ({}))) as {
    message?: string;
    error?: { message?: string; details?: { path: string; message: string }[] };
  };

  if (response.ok) {
    return page(
      'Request received',
      `<h1>Thank you — your request has been received.</h1><p>${escapeHtml(
        body.message ?? 'We will get back to you as soon as possible.',
      )}</p>`,
      landingPath,
    );
  }

  const details = body.error?.details ?? [];
  const items = details.map((detail) => `<li>${escapeHtml(detail.message)}</li>`).join('');
  return page(
    'Please check the form',
    `<h1>The form could not be submitted.</h1><p>${escapeHtml(
      body.error?.message ?? 'Please check your answers and try again.',
    )}</p>${items ? `<ul>${items}</ul>` : ''}<p>Use your browser's back button — what you typed is still there.</p>`,
    landingPath,
  );
}
