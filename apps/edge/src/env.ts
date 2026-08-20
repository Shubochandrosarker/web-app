export interface Env {
  readonly ENVIRONMENT: string;
  readonly API_BASE_URL: string;
  /** Signs Worker → API calls so the API can distinguish them from the public. */
  readonly EDGE_SHARED_SECRET: string;
  readonly INDEXNOW_KEY?: string;
  readonly EVENT_QUEUE: Queue<unknown>;
  readonly PUBLIC_ASSETS: R2Bucket;
}
