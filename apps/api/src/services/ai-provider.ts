import type { ApiConfig } from '../lib/env.ts';

/**
 * Pluggable AI completion provider.
 *
 * One method, three adapters, no SDKs. The platform's only AI use is
 * *suggestions a human reviews* — meta rewrites, questions worth answering,
 * internal links — so the interface is a single completion call and the
 * providers are interchangeable by environment variable. `none` is the
 * default and a first-class state: every feature built on this must render a
 * useful explanation instead of an error when no provider is configured.
 *
 * Nothing here ever writes content. The callers return suggestions to the
 * dashboard; publishing stays a human action, always.
 */

export interface AiProvider {
  readonly name: string;
  /** One completion: a system framing and a user prompt in, text out. */
  complete(system: string, user: string): Promise<string>;
}

class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, model: string, fetchImpl: typeof fetch) {
    this.apiKey = apiKey;
    this.model = model;
    this.fetchImpl = fetchImpl;
  }

  async complete(system: string, user: string): Promise<string> {
    const response = await this.fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1500,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`Anthropic answered ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as { content?: { type: string; text?: string }[] };
    return (body.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
  }
}

class OpenAiProvider implements AiProvider {
  readonly name = 'openai';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, model: string, fetchImpl: typeof fetch) {
    this.apiKey = apiKey;
    this.model = model;
    this.fetchImpl = fetchImpl;
  }

  async complete(system: string, user: string): Promise<string> {
    const response = await this.fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`OpenAI answered ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return body.choices?.[0]?.message?.content ?? '';
  }
}

class WorkersAiProvider implements AiProvider {
  readonly name = 'workers_ai';
  private readonly accountId: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(accountId: string, apiKey: string, model: string, fetchImpl: typeof fetch) {
    this.accountId = accountId;
    this.apiKey = apiKey;
    this.model = model;
    this.fetchImpl = fetchImpl;
  }

  async complete(system: string, user: string): Promise<string> {
    const response = await this.fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.model}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Workers AI answered ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as { result?: { response?: string } };
    return body.result?.response ?? '';
  }
}

/** Null when AI_PROVIDER is `none` — callers explain instead of erroring. */
export function createAiProvider(
  config: ApiConfig,
  fetchImpl: typeof fetch = fetch,
): AiProvider | null {
  switch (config.AI_PROVIDER) {
    case 'anthropic':
      return new AnthropicProvider(
        config.AI_API_KEY ?? '',
        config.AI_MODEL ?? 'claude-haiku-4-5-20251001',
        fetchImpl,
      );
    case 'openai':
      return new OpenAiProvider(
        config.AI_API_KEY ?? '',
        config.AI_MODEL ?? 'gpt-4o-mini',
        fetchImpl,
      );
    case 'workers_ai':
      return new WorkersAiProvider(
        config.CF_ACCOUNT_ID ?? '',
        config.AI_API_KEY ?? '',
        config.AI_MODEL ?? '@cf/meta/llama-3.1-8b-instruct',
        fetchImpl,
      );
    case 'none':
    default:
      return null;
  }
}
