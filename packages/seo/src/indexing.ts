/**
 * Search-engine notification.
 *
 * Publishing runs: update sitemap → purge CDN → notify → record the attempt.
 * The recording matters as much as the notification: without it there is no
 * way to tell "we never submitted this URL" from "we submitted it and it was
 * not indexed", and those call for completely different responses.
 *
 * Submitting a URL is a request, not a guarantee of indexing or ranking.
 */

export interface IndexNowSubmission {
  readonly host: string;
  readonly key: string;
  /** Defaults to `https://<host>/<key>.txt` when omitted. */
  readonly keyLocation?: string;
  readonly urlList: readonly string[];
}

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

/** IndexNow accepts up to 10,000 URLs per request. */
export const INDEXNOW_MAX_URLS = 10_000;

export type IndexingOutcome =
  | { readonly status: 'submitted'; readonly urlCount: number; readonly httpStatus: number }
  | {
      readonly status: 'rejected';
      readonly urlCount: number;
      readonly httpStatus: number;
      readonly reason: string;
    }
  | { readonly status: 'error'; readonly urlCount: number; readonly reason: string };

export function buildIndexNowPayload(submission: IndexNowSubmission): {
  readonly host: string;
  readonly key: string;
  readonly keyLocation: string;
  readonly urlList: readonly string[];
} {
  if (submission.urlList.length === 0) {
    throw new Error('IndexNow submission requires at least one URL');
  }
  if (submission.urlList.length > INDEXNOW_MAX_URLS) {
    throw new Error(`IndexNow accepts at most ${INDEXNOW_MAX_URLS} URLs per request`);
  }

  const foreign = submission.urlList.filter((url) => new URL(url).host !== submission.host);
  if (foreign.length > 0) {
    // Every URL must be on the host that owns the key, or the whole batch is
    // rejected — fail here rather than losing the batch at the endpoint.
    throw new Error(`IndexNow URLs must all belong to ${submission.host}; got ${foreign[0]}`);
  }

  return {
    host: submission.host,
    key: submission.key,
    keyLocation: submission.keyLocation ?? `https://${submission.host}/${submission.key}.txt`,
    urlList: submission.urlList,
  };
}

export async function submitToIndexNow(
  submission: IndexNowSubmission,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<IndexingOutcome> {
  const payload = buildIndexNowPayload(submission);

  try {
    const response = await fetchImpl(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    });

    if (response.ok || response.status === 202) {
      return { status: 'submitted', urlCount: payload.urlList.length, httpStatus: response.status };
    }

    return {
      status: 'rejected',
      urlCount: payload.urlList.length,
      httpStatus: response.status,
      reason: `${response.status} ${response.statusText}`,
    };
  } catch (error) {
    return {
      status: 'error',
      urlCount: payload.urlList.length,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Split a large publish batch into requests the endpoint will accept. */
export function chunkUrls(urls: readonly string[], size = INDEXNOW_MAX_URLS): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < urls.length; index += size) {
    chunks.push(urls.slice(index, index + size));
  }
  return chunks;
}
