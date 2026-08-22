import { createSign } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { schema, withWorkspace, type Database } from '@bos/database';
import type { ApiConfig } from '../lib/env.ts';

/**
 * Google Search Console ingestion.
 *
 * A service account (no OAuth dance, no refresh tokens to babysit): the owner
 * grants the account read access to the property once, and the nightly job
 * pulls query/page/device/country rows for a trailing window. The window
 * matters — GSC finalises data roughly two days late, so each run re-ingests
 * the last {@link TRAILING_DAYS} days and the unique key turns that into an
 * overwrite rather than double counting.
 *
 * Auth is a plain signed JWT exchanged for an access token; the two Google
 * endpoints involved are stable, public and documented, and doing it with
 * `node:crypto` keeps a whole SDK out of the dependency tree.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const TRAILING_DAYS = 3;
const DIMENSIONS = ['query', 'page', 'device', 'country'] as const;

export interface SearchConsoleDeps {
  readonly db: Database;
  readonly config: ApiConfig;
  readonly resolveWorkspaceId: (slug: string) => Promise<string>;
  readonly logger: {
    info(payload: Record<string, unknown>, message: string): void;
    warn(payload: Record<string, unknown>, message: string): void;
  };
  /** Test seam: replaces the network round-trips. */
  readonly fetchImpl?: typeof fetch;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Mint an access token from the service-account key. */
export async function mintAccessToken(
  clientEmail: string,
  privateKeyPem: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  // Env files carry the key with literal \n; both forms must work.
  const signature = signer.sign(privateKeyPem.replace(/\\n/g, '\n')).toString('base64url');

  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Google token endpoint answered ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error('Google token response carried no access_token.');
  return body.access_token;
}

interface GscRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  position?: number;
}

async function queryDimension(
  property: string,
  token: string,
  dimension: (typeof DIMENSIONS)[number],
  startDate: string,
  endDate: string,
  fetchImpl: typeof fetch,
): Promise<
  { date: string; value: string; clicks: number; impressions: number; position: number }[]
> {
  const response = await fetchImpl(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        startDate,
        endDate,
        dimensions: ['date', dimension],
        rowLimit: 5000,
        dataState: 'all',
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Search Console query (${dimension}) answered ${response.status}: ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { rows?: GscRow[] };
  return (body.rows ?? []).flatMap((row) => {
    const [date, value] = row.keys ?? [];
    if (!date || value === undefined) return [];
    return [
      {
        date,
        value: value.slice(0, 1024),
        clicks: Math.round(row.clicks ?? 0),
        impressions: Math.round(row.impressions ?? 0),
        position: row.position ?? 0,
      },
    ];
  });
}

/**
 * Ingest the trailing window for the configured workspace.
 *
 * Returns row counts per dimension, or null when Search Console is not
 * configured — which is a normal state, not an error: the dashboard's search
 * screen explains what to set up.
 */
export async function ingestSearchConsole(
  deps: SearchConsoleDeps,
): Promise<Record<string, number> | null> {
  const { config, db, logger } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (!config.GSC_CLIENT_EMAIL || !config.GSC_PRIVATE_KEY || !config.GSC_WORKSPACE) {
    return null;
  }

  const workspaceId = await deps.resolveWorkspaceId(config.GSC_WORKSPACE).catch(() => null);
  if (!workspaceId) {
    logger.warn({ slug: config.GSC_WORKSPACE }, 'Search Console ingest: workspace not found');
    return null;
  }

  const property =
    config.GSC_PROPERTY ??
    (await withWorkspace(db, workspaceId, async (tx) => {
      const [row] = await tx
        .select({ siteUrl: schema.workspaces.siteUrl })
        .from(schema.workspaces)
        .where(sql`${schema.workspaces.id} = ${workspaceId}`)
        .limit(1);
      return row ? `${row.siteUrl.replace(/\/+$/, '')}/` : null;
    }));
  if (!property) return null;

  const token = await mintAccessToken(config.GSC_CLIENT_EMAIL, config.GSC_PRIVATE_KEY, fetchImpl);

  const end = new Date();
  const start = new Date(end.getTime() - TRAILING_DAYS * 86_400_000);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);

  const counts: Record<string, number> = {};
  for (const dimension of DIMENSIONS) {
    const rows = await queryDimension(property, token, dimension, startDate, endDate, fetchImpl);
    counts[dimension] = rows.length;
    if (rows.length === 0) continue;

    await withWorkspace(db, workspaceId, async (tx) => {
      for (const row of rows) {
        await tx
          .insert(schema.searchConsoleDaily)
          .values({
            workspaceId,
            date: row.date,
            dimension,
            dimensionValue: row.value,
            clicks: row.clicks,
            impressions: row.impressions,
            positionTimes100: Math.round(row.position * 100),
          })
          .onConflictDoUpdate({
            target: [
              schema.searchConsoleDaily.workspaceId,
              schema.searchConsoleDaily.date,
              schema.searchConsoleDaily.dimension,
              schema.searchConsoleDaily.dimensionValue,
            ],
            set: {
              clicks: row.clicks,
              impressions: row.impressions,
              positionTimes100: Math.round(row.position * 100),
              updatedAt: new Date(),
            },
          });
      }
    });
  }

  logger.info({ property, ...counts }, 'Search Console ingested');
  return counts;
}
