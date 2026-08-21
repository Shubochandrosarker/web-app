import { readFile } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import {
  closeDatabase,
  createDatabase,
  schema,
  withWorkspace,
  withoutTenantScope,
} from '@bos/database';

/**
 * Redirect import and verification.
 *
 *   pnpm redirects:import nuesheba redirects.csv
 *   pnpm redirects:verify nuesheba --base https://staging.nuesheba.com
 *
 * The CSV is `from,to,status` — one row per old URL, with `status` either 301
 * or 410. It is produced by the audit described in
 * `docs/deployment/url-migration.md`, from the live site's own sitemap, Search
 * Console and analytics. It is **not** generated here, and cannot be: the
 * mapping is an editorial judgement about which new page answers each old
 * URL's question, and a machine guessing at it produces exactly the
 * redirect-everything-to-the-homepage pattern that loses the signal.
 *
 * What this does provide is everything mechanical: parsing, validation,
 * chain detection, an idempotent import, and a verifier that checks the
 * deployed site actually behaves the way the map says.
 */

interface RedirectRow {
  readonly from: string;
  readonly to: string;
  readonly status: 301 | 410;
  readonly line: number;
}

interface ParseResult {
  readonly rows: readonly RedirectRow[];
  readonly problems: readonly string[];
}

/**
 * Parse and validate the map.
 *
 * Every problem is collected rather than thrown on, so one run tells somebody
 * everything that is wrong with a two-thousand-row file instead of the first
 * thing.
 */
function parseCsv(content: string): ParseResult {
  const rows: RedirectRow[] = [];
  const problems: string[] = [];
  const seen = new Map<string, number>();

  const lines = content.split(/\r?\n/);

  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    const text = raw.trim();

    if (!text || text.startsWith('#')) continue;
    if (line === 1 && /^from\s*,/i.test(text)) continue;

    const parts = text.split(',').map((part) => part.trim());
    const [fromRaw, toRaw, statusRaw] = parts;

    if (!fromRaw) {
      problems.push(`line ${line}: no source path`);
      continue;
    }

    // A full URL is accepted and reduced to its path: an export from Search
    // Console or a crawler gives absolute URLs, and making somebody strip the
    // origin by hand is an invitation to do it wrong.
    const from = toPath(fromRaw);
    if (!from) {
      problems.push(`line ${line}: "${fromRaw}" is not a path or an absolute URL`);
      continue;
    }

    const status = statusRaw ? Number(statusRaw) : 301;
    if (status !== 301 && status !== 410) {
      problems.push(`line ${line}: status must be 301 or 410, got "${statusRaw}"`);
      continue;
    }

    /*
     * 410 means "this is gone and there is no equivalent". It is the right
     * answer far less often than people reach for it, and it must not carry a
     * destination — a 410 with a target is a contradiction.
     */
    if (status === 410) {
      if (toRaw) problems.push(`line ${line}: a 410 must not have a destination`);
      rows.push({ from, to: '', status, line });
    } else {
      if (!toRaw) {
        problems.push(`line ${line}: a 301 needs a destination`);
        continue;
      }
      const to = toPath(toRaw) ?? toRaw;

      if (from === to) {
        problems.push(`line ${line}: "${from}" redirects to itself`);
        continue;
      }
      rows.push({ from, to, status, line });
    }

    const previous = seen.get(from);
    if (previous !== undefined) {
      problems.push(`line ${line}: "${from}" was already mapped on line ${previous}`);
    }
    seen.set(from, line);
  }

  /*
   * Chains.
   *
   * `/a → /b` and `/b → /c` costs an extra round trip for every visitor and
   * dilutes the signal at each hop. The fix is always the same — point `/a`
   * straight at `/c` — so it is worth naming precisely rather than leaving to
   * a crawler to discover later.
   */
  const destinations = new Map(
    rows.filter((row) => row.status === 301).map((row) => [row.from, row.to]),
  );
  for (const row of rows) {
    if (row.status !== 301) continue;
    const next = destinations.get(row.to);
    if (next !== undefined) {
      problems.push(
        `line ${row.line}: "${row.from}" → "${row.to}" → "${next}" is a chain. ` +
          `Point it directly at "${next}".`,
      );
    }
  }

  return { rows, problems };
}

function toPath(value: string): string | null {
  if (value.startsWith('/')) return normalise(value);
  try {
    return normalise(new URL(value).pathname);
  } catch {
    return null;
  }
}

/** One canonical form, so `/a/` and `/a` cannot both be mapped differently. */
function normalise(path: string): string {
  const withoutTrailing = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return withoutTrailing || '/';
}

async function importRedirects(slug: string, file: string): Promise<void> {
  const content = await readFile(file, 'utf8');
  const { rows, problems } = parseCsv(content);

  if (problems.length > 0) {
    console.error(`${problems.length} problem(s) in ${file}:\n`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error('\nNothing was imported. Fix these and run again.');
    process.exit(1);
  }

  if (rows.length === 0) {
    console.error('No redirects in the file.');
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set.');
  const db = createDatabase({ connectionString, maxConnections: 2 });

  try {
    const workspaceId = await withoutTenantScope(db, async (tx) => {
      const [row] = await tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.slug, slug))
        .limit(1);
      if (!row) throw new Error(`No workspace "${slug}". Run pnpm workspace:provision first.`);
      return row.id;
    });

    let created = 0;
    let updated = 0;

    await withWorkspace(db, workspaceId, async (tx) => {
      for (const row of rows) {
        const [existing] = await tx
          .select({ id: schema.redirects.id, toPath: schema.redirects.toPath })
          .from(schema.redirects)
          .where(
            and(
              eq(schema.redirects.workspaceId, workspaceId),
              eq(schema.redirects.fromPath, row.from),
            ),
          )
          .limit(1);

        // A 410 is stored with its own path as the destination and a 410
        // status; the site's proxy reads the status, not the target.
        const toPathValue = row.status === 410 ? row.from : row.to;

        if (existing) {
          await tx
            .update(schema.redirects)
            .set({
              toPath: toPathValue,
              statusCode: row.status,
              enabled: true,
              updatedAt: new Date(),
            })
            .where(eq(schema.redirects.id, existing.id));
          updated += 1;
        } else {
          await tx.insert(schema.redirects).values({
            workspaceId,
            fromPath: row.from,
            toPath: toPathValue,
            statusCode: row.status,
            enabled: true,
          });
          created += 1;
        }
      }
    });

    console.log(`Imported ${rows.length} redirect(s): ${created} created, ${updated} updated.`);
    console.log('\nVerify against the deployed site before the cutover:');
    console.log(`  pnpm redirects:verify ${slug} --base https://staging.nuesheba.com`);
  } finally {
    await closeDatabase();
  }
}

/**
 * Check the deployed site behaves the way the table says.
 *
 * A redirect that exists in the database and not in the response is the
 * failure mode that matters, and it is invisible until somebody follows an old
 * link. Each request is made with redirects unfollowed, so a chain shows up as
 * a second hop rather than being silently resolved.
 */
async function verifyRedirects(slug: string, base: string): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set.');
  const db = createDatabase({ connectionString, maxConnections: 2 });

  try {
    const workspaceId = await withoutTenantScope(db, async (tx) => {
      const [row] = await tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.slug, slug))
        .limit(1);
      if (!row) throw new Error(`No workspace "${slug}".`);
      return row.id;
    });

    const rows = await withWorkspace(db, workspaceId, (tx) =>
      tx
        .select({
          fromPath: schema.redirects.fromPath,
          toPath: schema.redirects.toPath,
          statusCode: schema.redirects.statusCode,
        })
        .from(schema.redirects)
        .where(eq(schema.redirects.enabled, true)),
    );

    console.log(`Verifying ${rows.length} redirect(s) against ${base}\n`);

    const failures: string[] = [];

    for (const row of rows) {
      const url = `${base.replace(/\/+$/, '')}${row.fromPath}`;

      try {
        const response = await fetch(url, {
          redirect: 'manual',
          signal: AbortSignal.timeout(15_000),
          headers: { 'user-agent': 'bos-redirects/1.0' },
        });

        if (row.statusCode === 410) {
          if (response.status !== 410 && response.status !== 404) {
            failures.push(`${row.fromPath}: expected 410, got ${response.status}`);
          }
          continue;
        }

        if (response.status !== 301 && response.status !== 308) {
          failures.push(`${row.fromPath}: expected 301, got ${response.status}`);
          continue;
        }

        const location = response.headers.get('location') ?? '';
        const landed = toPath(location) ?? location;
        if (landed !== row.toPath) {
          failures.push(`${row.fromPath}: redirected to "${landed}", expected "${row.toPath}"`);
          continue;
        }

        // One hop. A destination that is itself a redirect is a chain, and the
        // whole point of importing a flattened map is not to have any.
        const destination = await fetch(`${base.replace(/\/+$/, '')}${row.toPath}`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(15_000),
          headers: { 'user-agent': 'bos-redirects/1.0' },
        });

        if (destination.status >= 300 && destination.status < 400) {
          failures.push(
            `${row.fromPath} → ${row.toPath} → ${destination.headers.get('location')} (chain)`,
          );
        } else if (destination.status >= 400) {
          failures.push(`${row.fromPath} → ${row.toPath}, which is a ${destination.status}`);
        }
      } catch (error) {
        failures.push(`${row.fromPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (failures.length === 0) {
      console.log(`All ${rows.length} redirect(s) resolve in one hop to a live page.`);
      return;
    }

    console.error(`${failures.length} problem(s):\n`);
    for (const failure of failures) console.error(`  ${failure}`);
    console.error('\nThese are URLs that currently rank. Fix them before the cutover, not after.');
    process.exit(1);
  } finally {
    await closeDatabase();
  }
}

async function main(): Promise<void> {
  const [command, slug, ...rest] = process.argv.slice(2);

  if (!command || !slug) {
    console.error(
      'Usage:\n' +
        '  pnpm redirects:import <workspace> <file.csv>\n' +
        '  pnpm redirects:verify <workspace> --base <url>',
    );
    process.exit(1);
  }

  if (command === 'import') {
    const file = rest.find((arg) => !arg.startsWith('--'));
    if (!file) throw new Error('Give the CSV file to import.');
    await importRedirects(slug, file);
    return;
  }

  if (command === 'verify') {
    const baseIndex = rest.indexOf('--base');
    const base = baseIndex >= 0 ? rest[baseIndex + 1] : undefined;
    if (!base) throw new Error('Give --base <url> to verify against.');
    await verifyRedirects(slug, base);
    return;
  }

  throw new Error(`Unknown command "${command}". Use import or verify.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
