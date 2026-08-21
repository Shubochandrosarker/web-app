/**
 * Deployment smoke test.
 *
 *   pnpm smoke -- --site https://staging.nuesheba.com \
 *                 --api  https://api.nuesheba.com \
 *                 --dashboard https://app.nuesheba.com
 *
 * Run against staging before every production cutover, and against production
 * immediately after. A non-zero exit means the release does not ship.
 *
 * What this checks and what it deliberately does not: it verifies the things a
 * deploy breaks — a missing environment variable, an unreachable database, a
 * header that stopped being sent, a staging site that became indexable. It is
 * not a functional test suite; the API's own tests cover behaviour, and
 * repeating them here would mean two places to update when behaviour changes.
 *
 * By default it makes no writes. `--submit-form` additionally posts a real
 * service request, which is the only way to prove the conversion path end to
 * end — so it is opt-in, and it says loudly that it creates a lead.
 */

interface Options {
  readonly site: string;
  readonly api: string;
  readonly dashboard: string | undefined;
  readonly workspace: string;
  readonly expectIndexable: boolean;
  readonly submitForm: boolean;
  readonly servicePath: string | undefined;
}

type Outcome = 'pass' | 'fail' | 'skip';

interface Result {
  readonly name: string;
  readonly outcome: Outcome;
  readonly detail: string;
}

const results: Result[] = [];

function record(name: string, outcome: Outcome, detail: string): void {
  results.push({ name, outcome, detail });
  const mark = outcome === 'pass' ? '  ok  ' : outcome === 'skip' ? ' skip ' : ' FAIL ';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    record(name, 'pass', await fn());
  } catch (error) {
    record(name, 'fail', error instanceof Error ? error.message : String(error));
  }
}

function parseArgs(argv: readonly string[]): Options {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  // A bare positional URL is accepted so `pnpm smoke -- https://…` works, which
  // is what somebody types first.
  const positional = argv.find((arg) => arg.startsWith('http'));
  const site = flag('site') ?? positional;
  if (!site) {
    throw new Error(
      'Usage: pnpm smoke -- --site <url> [--api <url>] [--dashboard <url>] ' +
        '[--workspace <slug>] [--expect-indexable] [--submit-form]',
    );
  }

  return {
    site: site.replace(/\/+$/, ''),
    api: (flag('api') ?? `${site.replace('https://', 'https://api.')}`).replace(/\/+$/, ''),
    dashboard: flag('dashboard')?.replace(/\/+$/, ''),
    workspace: flag('workspace') ?? process.env.BOS_WORKSPACE_SLUG ?? 'nuesheba',
    // Staging must be non-indexable and production must be indexable. Both are
    // failures in the other direction, which is why this is a flag rather than
    // an assumption.
    expectIndexable: argv.includes('--expect-indexable'),
    submitForm: argv.includes('--submit-form'),
    servicePath: flag('service-path'),
  };
}

async function get(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
    headers: { 'user-agent': 'bos-smoke/1.0', ...(init.headers ?? {}) },
  });
}

function must(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  console.log(`Smoke test\n  site      ${options.site}\n  api       ${options.api}`);
  if (options.dashboard) console.log(`  dashboard ${options.dashboard}`);
  console.log(`  indexable ${options.expectIndexable ? 'expected' : 'must be off'}\n`);

  /* ------------------------------------------------------------------ API */

  await check('API liveness', async () => {
    const response = await get(`${options.api}/health`);
    must(response.ok, `/health responded ${response.status}`);
    const body = (await response.json()) as { status?: string };
    must(body.status === 'ok', `/health said "${body.status}"`);
    return 'ok';
  });

  await check('API readiness (database and cache reachable)', async () => {
    const response = await get(`${options.api}/ready`);
    const body = (await response.json()) as {
      status?: string;
      checks?: Record<string, string>;
      outbox?: { pending: number; dead: number };
    };

    must(response.ok, `/ready responded ${response.status}: ${JSON.stringify(body.checks ?? {})}`);

    // A backed-up outbox is not a reason to fail a deploy, but it is the first
    // thing worth knowing after one.
    const outbox = body.outbox
      ? ` · outbox ${body.outbox.pending} pending, ${body.outbox.dead} dead`
      : '';
    return `${Object.entries(body.checks ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')}${outbox}`;
  });

  await check('API rejects an anonymous call to a protected route', async () => {
    const response = await get(`${options.api}/v1/cms/content`, {
      headers: { 'x-bos-workspace': options.workspace },
    });
    must(response.status === 401, `expected 401, got ${response.status}`);
    return '401';
  });

  await check('API rejects an unsigned internal call', async () => {
    const response = await get(`${options.api}/v1/internal/jobs/outbox.dispatch`, {
      method: 'POST',
    });
    must(response.status === 401, `expected 401, got ${response.status}`);
    return '401';
  });

  await check('Public content API serves only published content', async () => {
    const response = await get(`${options.api}/v1/content?workspace=${options.workspace}&limit=5`);
    must(response.ok, `responded ${response.status}`);
    const body = (await response.json()) as { items: { status: string }[] };
    const leaked = body.items.filter((item) => item.status !== 'published');
    must(leaked.length === 0, `${leaked.length} non-published entries in a public response`);
    return `${body.items.length} entries, all published`;
  });

  /* ----------------------------------------------------------------- site */

  let homeBody = '';

  await check('Homepage responds 200', async () => {
    const response = await get(options.site);
    must(response.ok, `responded ${response.status}`);
    homeBody = await response.text();
    return `${response.status} · ${Math.round(homeBody.length / 1024)} KB`;
  });

  await check('Security headers are present', async () => {
    const response = await get(options.site);
    const required = [
      'content-security-policy',
      'x-content-type-options',
      'x-frame-options',
      'referrer-policy',
    ];

    const missing = required.filter((header) => !response.headers.get(header));
    must(missing.length === 0, `missing: ${missing.join(', ')}`);

    const csp = response.headers.get('content-security-policy') ?? '';
    // The two directives whose absence quietly defeats the policy.
    must(!csp.includes('script-src') || !csp.includes("'unsafe-eval'"), 'CSP allows unsafe-eval');
    must(csp.includes("frame-ancestors 'none'"), 'CSP does not forbid framing');

    return 'CSP, nosniff, frame options, referrer policy';
  });

  await check('robots.txt matches the indexing switch', async () => {
    const response = await get(`${options.site}/robots.txt`);
    must(response.ok, `responded ${response.status}`);
    const body = await response.text();
    const disallowsEverything = /Disallow:\s*\/\s*$/m.test(body);

    if (options.expectIndexable) {
      must(!disallowsEverything, 'robots.txt disallows everything on a site meant to be indexed');
      return 'allows crawling';
    }

    /*
     * The check that matters most on staging. A staging site that became
     * indexable competes with production for the same queries, and the damage
     * outlasts the fix.
     */
    must(disallowsEverything, 'robots.txt allows crawling on a site that must not be indexed');
    return 'disallows everything';
  });

  await check('Pages carry the right robots directive', async () => {
    const hasNoindex = /<meta[^>]+name="robots"[^>]+noindex/i.test(homeBody);

    if (options.expectIndexable) {
      must(!hasNoindex, 'the homepage is marked noindex on a site meant to be indexed');
      return 'indexable';
    }

    // robots.txt alone is not enough: a URL already known to a crawler can be
    // indexed without robots.txt being re-read.
    must(hasNoindex, 'the homepage has no noindex directive on a non-indexable deployment');
    return 'noindex';
  });

  await check('Canonical URL is present and absolute', async () => {
    const match = homeBody.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i);
    must(Boolean(match), 'no canonical link');
    const href = match?.[1] ?? '';
    must(href.startsWith('https://'), `canonical is not absolute: ${href}`);
    return href;
  });

  await check('JSON-LD parses and matches the page', async () => {
    const match = homeBody.match(
      /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i,
    );
    must(Boolean(match), 'no JSON-LD block');

    const graph = JSON.parse(match?.[1] ?? '{}') as { '@graph'?: { '@type': string }[] };
    const nodes = graph['@graph'] ?? [];
    must(nodes.length > 0, 'the JSON-LD graph is empty');

    const types = nodes.map((node) => node['@type']);
    must(types.includes('Organization'), 'no Organization node');
    must(types.includes('WebSite'), 'no WebSite node');

    // A FAQPage node with no visible questions is the mismatch that gets
    // structured data discounted across a whole site.
    if (types.includes('FAQPage')) {
      must(/<summary/i.test(homeBody), 'FAQPage schema with no visible questions');
    }

    return types.join(', ');
  });

  await check('Sitemap index responds and lists sitemaps', async () => {
    const response = await get(`${options.site}/sitemap.xml`);
    must(response.ok, `responded ${response.status}`);
    const body = await response.text();
    must(body.includes('<sitemapindex'), 'not a sitemap index');
    const count = (body.match(/<sitemap>/g) ?? []).length;
    return `${count} sitemap(s)`;
  });

  await check('An unknown path returns 404', async () => {
    const response = await get(`${options.site}/definitely-not-a-real-page-${Date.now()}`);
    must(response.status === 404, `expected 404, got ${response.status}`);
    return '404';
  });

  /* ------------------------------------------------------- conversion path */

  const servicePath = options.servicePath;

  if (servicePath) {
    await check(`Service page ${servicePath} responds 200 and renders a form`, async () => {
      const response = await get(`${options.site}${servicePath}`);
      must(response.ok, `responded ${response.status}`);
      const body = await response.text();
      must(body.includes('<form'), 'no form on the service page');
      must(/<h1[^>]*>/.test(body), 'no H1 on the service page');
      return 'form and H1 present';
    });
  } else {
    record('Service page', 'skip', 'pass --service-path to check one');
  }

  if (options.submitForm) {
    await check('Submitting the service request form creates a lead', async () => {
      must(Boolean(servicePath), '--submit-form needs --service-path, to find the form definition');

      /*
       * Read the form's real field definitions rather than assuming them.
       *
       * A form is tenant data: which fields exist and which are required is
       * configuration, and a smoke test that hard-codes a payload tests a form
       * nobody deployed. It also means adding a required field to the form
       * does not silently start failing this check for the wrong reason.
       */
      const page = await get(
        `${options.api}/v1/content/by-path?workspace=${options.workspace}` +
          `&path=${encodeURIComponent(servicePath!)}&locale=en`,
      );
      must(page.ok, `could not read ${servicePath}: ${page.status}`);

      const entry = (await page.json()) as {
        references?: {
          forms?: {
            slug: string;
            requiresConsent: boolean;
            fields: {
              name: string;
              type: string;
              required: boolean;
              options: { value: string }[];
            }[];
          }[];
        };
      };

      const form = entry.references?.forms?.[0];
      must(Boolean(form), `no form is resolved on ${servicePath}`);

      const marker = `smoke-${Date.now()}`;
      const values: Record<string, string | boolean> = {};

      for (const field of form!.fields) {
        if (!field.required) continue;

        switch (field.type) {
          case 'tel':
            values[field.name] = '01700000001';
            break;
          case 'email':
            values[field.name] = `smoke-${marker}@example.test`;
            break;
          case 'checkbox':
            values[field.name] = true;
            break;
          case 'number':
            values[field.name] = '1';
            break;
          case 'select': {
            const option = field.options[0]?.value;
            // A required select with no options is a misconfigured form, and
            // saying so is more useful than a 422 the reader has to decode.
            must(Boolean(option), `required select "${field.name}" has no options`);
            values[field.name] = option!;
            break;
          }
          default:
            values[field.name] = `Automated smoke test ${marker} — safe to delete`;
        }
      }

      const response = await fetch(
        `${options.api}/v1/forms/${form!.slug}/submissions?workspace=${options.workspace}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            values,
            consent: form!.requiresConsent,
            landingPath: servicePath,
            // Above the minimum fill time, so the submission is not scored as
            // a bot for being too fast.
            elapsedMs: 9_000,
          }),
          signal: AbortSignal.timeout(20_000),
        },
      );

      const body = (await response.json().catch(() => ({}))) as {
        reference?: string;
        error?: { message?: string; details?: unknown };
      };

      must(
        response.status === 201,
        `expected 201, got ${response.status}: ${body.error?.message ?? ''} ` +
          `${JSON.stringify(body.error?.details ?? '')}`,
      );
      must(Boolean(body.reference), 'no reference returned');

      return `created, reference ${body.reference} — DELETE THIS LEAD`;
    });
  } else {
    record('Form submission', 'skip', 'pass --submit-form to check it (creates a real lead)');
  }

  await check('Private documents are not readable anonymously', async () => {
    const response = await get(
      `${options.api}/v1/documents/00000000-0000-4000-8000-000000000000/download-url`,
      { method: 'POST' },
    );
    must(response.status === 401, `expected 401, got ${response.status}`);
    return '401';
  });

  /* ------------------------------------------------------------ dashboard */

  if (options.dashboard) {
    await check('Dashboard redirects an anonymous visitor to sign-in', async () => {
      const response = await get(options.dashboard!);
      must(
        response.status >= 300 && response.status < 400,
        `expected a redirect, got ${response.status}`,
      );
      const location = response.headers.get('location') ?? '';
      must(location.includes('sign-in'), `redirected to ${location}`);
      return `→ ${location}`;
    });

    await check('Dashboard sign-in page renders and is not cacheable', async () => {
      const response = await get(`${options.dashboard!}/sign-in`);
      must(response.ok, `responded ${response.status}`);
      const cacheControl = response.headers.get('cache-control') ?? '';
      must(cacheControl.includes('no-store'), `cache-control is "${cacheControl}"`);
      return 'no-store';
    });
  } else {
    record('Dashboard', 'skip', 'pass --dashboard to check it');
  }

  /* --------------------------------------------------------------- report */

  const failed = results.filter((result) => result.outcome === 'fail');
  const passed = results.filter((result) => result.outcome === 'pass');
  const skipped = results.filter((result) => result.outcome === 'skip');

  console.log(`\n${passed.length} passed · ${failed.length} failed · ${skipped.length} skipped`);

  if (failed.length > 0) {
    console.error('\nThis release must not ship:');
    for (const failure of failed) console.error(`  - ${failure.name}: ${failure.detail}`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
