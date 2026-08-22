import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace } from '@bos/database';
import { ApiError } from '../lib/errors.ts';
import { requirePermission } from '../lib/permissions.ts';
import { requireWorkspace } from '../lib/context.ts';
import { runSeoAudit } from '../services/seo-audit.ts';
import { createAiProvider } from '../services/ai-provider.ts';
import type { AppContext } from '../app.ts';

/**
 * SEO intelligence: the audit, and AI suggestions a human reviews.
 *
 * The suggestions endpoint is deliberately read-only with respect to
 * content: it returns proposals, the dashboard shows them, and applying any
 * of them is a person editing the page. There is no code path from a model's
 * output into a published page — that is a policy, not an accident.
 */

const suggestionsSchema = z.object({
  metaTitle: z.string().max(200).optional(),
  metaDescription: z.string().max(400).optional(),
  questionsToAnswer: z.array(z.string().max(300)).max(10).default([]),
  internalLinkSuggestions: z
    .array(z.object({ toPath: z.string().max(500), anchor: z.string().max(200) }))
    .max(10)
    .default([]),
  improvements: z.array(z.string().max(500)).max(10).default([]),
});

export function registerSeoRoutes(app: FastifyInstance, context: AppContext): void {
  const { db, config } = context;

  app.get(
    '/v1/seo/audit',
    { config: { bosAccess: requirePermission('seo.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const audit = await runSeoAudit(db, workspace.workspaceId);
      // Which provider (if any) backs the suggestions feature — the screen
      // uses it to show setup guidance instead of a dead button.
      return { ...audit, aiProvider: createAiProvider(config)?.name ?? null };
    },
  );

  app.post(
    '/v1/seo/suggestions',
    { config: { bosAccess: requirePermission('seo.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { contentId } = z.object({ contentId: z.uuid() }).parse(request.body);

      const provider = createAiProvider(config);
      if (!provider) {
        throw ApiError.badRequest(
          'No AI provider is configured. Set AI_PROVIDER (anthropic, openai or workers_ai) and AI_API_KEY in the API environment.',
        );
      }

      const { entry, queries } = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [entry] = await tx
          .select({
            id: schema.contentEntries.id,
            path: schema.contentEntries.path,
            title: schema.contentEntries.title,
            excerpt: schema.contentEntries.excerpt,
            type: schema.contentEntries.type,
            seoTitle: schema.seoMetadata.title,
            seoDescription: schema.seoMetadata.description,
            document: schema.contentEntries.document,
          })
          .from(schema.contentEntries)
          .leftJoin(
            schema.seoMetadata,
            eq(schema.seoMetadata.contentEntryId, schema.contentEntries.id),
          )
          .where(
            and(eq(schema.contentEntries.id, contentId), isNull(schema.contentEntries.deletedAt)),
          )
          .limit(1);

        const since = new Date(Date.now() - 28 * 86_400_000).toISOString().slice(0, 10);
        const queries = entry
          ? await tx
              .select({
                value: schema.searchConsoleDaily.dimensionValue,
                clicks: schema.searchConsoleDaily.clicks,
                impressions: schema.searchConsoleDaily.impressions,
              })
              .from(schema.searchConsoleDaily)
              .where(
                and(
                  eq(schema.searchConsoleDaily.dimension, 'query'),
                  gte(schema.searchConsoleDaily.date, since),
                ),
              )
              .orderBy(desc(schema.searchConsoleDaily.impressions))
              .limit(20)
          : [];

        return { entry, queries };
      });
      if (!entry) throw ApiError.hidden('Content');

      // Plain text of the page, capped — the model needs the gist, not the DOM.
      const text = JSON.stringify(entry.document)
        .replace(/<[^>]+>/g, ' ')
        .replace(/["{}[\],]/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 6000);

      const seo = { title: entry.seoTitle, description: entry.seoDescription };
      const system = [
        'You are an SEO assistant for a small business website.',
        'Respond with STRICT JSON only, no prose, matching:',
        '{"metaTitle": string, "metaDescription": string, "questionsToAnswer": string[],',
        ' "internalLinkSuggestions": [{"toPath": string, "anchor": string}], "improvements": string[]}',
        'Rules: metaTitle <= 60 chars; metaDescription <= 155 chars; write in plain, direct language.',
        'NEVER invent facts about the business — prices, addresses, phone numbers, credentials,',
        'turnaround times or statistics. Where a fact would help, phrase the suggestion so the',
        'owner fills it in, e.g. "State your actual processing time here".',
      ].join('\n');

      const user = [
        `Page type: ${entry.type}`,
        `Path: ${entry.path}`,
        `Current title: ${seo.title ?? entry.title}`,
        `Current description: ${seo.description ?? entry.excerpt ?? '(none)'}`,
        queries.length > 0
          ? `Search queries this site already appears for (query, clicks, impressions): ${queries
              .map((query) => `"${query.value}" ${query.clicks}/${query.impressions}`)
              .join('; ')}`
          : 'No Search Console data available.',
        `Page text (truncated): ${text}`,
      ].join('\n\n');

      const raw = await provider.complete(system, user).catch((error: unknown) => {
        request.log.warn({ err: String(error) }, 'AI suggestion call failed');
        throw ApiError.badRequest(
          'The AI provider did not answer. Check the key and model, then try again.',
        );
      });

      // Models wrap JSON in fences or prose despite instructions; extract the
      // first object literal and validate it. A parse failure returns the raw
      // text as notes rather than pretending there were no suggestions.
      const match = /\{[\s\S]*\}/.exec(raw);
      let suggestions: z.infer<typeof suggestionsSchema> | null = null;
      if (match) {
        try {
          suggestions = suggestionsSchema.parse(JSON.parse(match[0]));
        } catch {
          suggestions = null;
        }
      }

      return {
        contentId: entry.id,
        path: entry.path,
        provider: provider.name,
        suggestions,
        ...(suggestions ? {} : { notes: raw.slice(0, 4000) }),
      };
    },
  );
}
