import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace } from '@bos/database';
import { ApiError } from '../lib/errors.ts';
import { requirePermission } from '../lib/permissions.ts';
import { requireWorkspace } from '../lib/context.ts';
import type { AppContext } from '../app.ts';

const source = z.enum(schema.reviewSource.enumValues);
const reviewInput = z.object({
  source: source.optional(),
  externalId: z.string().max(255).nullable().optional(),
  authorName: z.string().min(1).max(200),
  rating: z.number().int().min(1).max(5),
  title: z.string().max(300).nullable().optional(),
  body: z.string().max(10000).nullable().optional(),
  contactId: z.uuid().nullable().optional(),
  reviewedAt: z.iso.datetime({ offset: true }).optional(),
});

const reviewPatch = reviewInput.partial().extend({
  approved: z.boolean().optional(),
  response: z.string().max(10000).nullable().optional(),
});

const reviewQuery = z.object({
  status: z.enum(['pending', 'approved', 'all']).default('all'),
  source: source.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

function present(row: typeof schema.reviews.$inferSelect) {
  return {
    id: row.id,
    source: row.source,
    externalId: row.externalId,
    authorName: row.authorName,
    rating: row.rating,
    title: row.title,
    body: row.body,
    contactId: row.contactId,
    approved: Boolean(row.approvedAt),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    response: row.response,
    respondedAt: row.respondedAt?.toISOString() ?? null,
    reviewedAt: row.reviewedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function registerReviewRoutes(app: FastifyInstance, context: AppContext): void {
  const { db } = context;

  app.get(
    '/v1/reviews',
    { config: { bosAccess: requirePermission('reviews.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const query = reviewQuery.parse(request.query);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const conditions = [
          query.status === 'approved'
            ? isNotNull(schema.reviews.approvedAt)
            : query.status === 'pending'
              ? isNull(schema.reviews.approvedAt)
              : undefined,
          query.source ? eq(schema.reviews.source, query.source) : undefined,
        ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));

        const rows = await tx
          .select()
          .from(schema.reviews)
          .where(conditions.length ? and(...conditions) : undefined)
          .orderBy(desc(schema.reviews.reviewedAt))
          .limit(query.limit);

        return { items: rows.map(present) };
      });
    },
  );

  app.get(
    '/v1/reviews/:id',
    { config: { bosAccess: requirePermission('reviews.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.reviews)
          .where(eq(schema.reviews.id, id))
          .limit(1);
        if (!row) throw ApiError.hidden('Review');
        return { review: present(row) };
      });
    },
  );

  app.post(
    '/v1/reviews',
    { config: { bosAccess: requirePermission('reviews.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const input = reviewInput.parse(request.body);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        if (input.contactId) {
          const [contact] = await tx
            .select({ id: schema.contacts.id })
            .from(schema.contacts)
            .where(and(eq(schema.contacts.id, input.contactId), isNull(schema.contacts.deletedAt)))
            .limit(1);
          if (!contact) throw ApiError.badRequest('The selected contact is not in this workspace.');
        }

        const [row] = await tx
          .insert(schema.reviews)
          .values({
            workspaceId: workspace.workspaceId,
            source: input.source ?? 'internal',
            externalId: input.externalId ?? null,
            authorName: input.authorName,
            rating: input.rating,
            title: input.title ?? null,
            body: input.body ?? null,
            contactId: input.contactId ?? null,
            reviewedAt: input.reviewedAt ? new Date(input.reviewedAt) : new Date(),
          })
          .returning();

        return { review: present(row!) };
      });
    },
  );

  app.patch(
    '/v1/reviews/:id',
    { config: { bosAccess: requirePermission('reviews.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const input = reviewPatch.parse(request.body);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [current] = await tx
          .select()
          .from(schema.reviews)
          .where(eq(schema.reviews.id, id))
          .limit(1);
        if (!current) throw ApiError.hidden('Review');

        if (input.contactId) {
          const [contact] = await tx
            .select({ id: schema.contacts.id })
            .from(schema.contacts)
            .where(and(eq(schema.contacts.id, input.contactId), isNull(schema.contacts.deletedAt)))
            .limit(1);
          if (!contact) throw ApiError.badRequest('The selected contact is not in this workspace.');
        }

        const now = new Date();
        const [row] = await tx
          .update(schema.reviews)
          .set({
            ...(input.source !== undefined ? { source: input.source } : {}),
            ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
            ...(input.authorName !== undefined ? { authorName: input.authorName } : {}),
            ...(input.rating !== undefined ? { rating: input.rating } : {}),
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.body !== undefined ? { body: input.body } : {}),
            ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
            ...(input.reviewedAt !== undefined ? { reviewedAt: new Date(input.reviewedAt) } : {}),
            ...(input.approved !== undefined
              ? { approvedAt: input.approved ? (current.approvedAt ?? now) : null }
              : {}),
            ...(input.response !== undefined
              ? { response: input.response, respondedAt: input.response ? now : null }
              : {}),
            updatedAt: now,
          })
          .where(eq(schema.reviews.id, id))
          .returning();

        return { review: present(row!) };
      });
    },
  );

  app.post(
    '/v1/reviews/:id/approve',
    { config: { bosAccess: requirePermission('reviews.write') } },
    async (request) => moderateReview(db, request, true),
  );

  app.post(
    '/v1/reviews/:id/reject',
    { config: { bosAccess: requirePermission('reviews.write') } },
    async (request) => moderateReview(db, request, false),
  );
}

async function moderateReview(db: AppContext['db'], request: FastifyRequest, approved: boolean) {
  const workspace = requireWorkspace(request);
  const { id } = z.object({ id: z.uuid() }).parse(request.params);
  return withWorkspace(db, workspace.workspaceId, async (tx) => {
    const [row] = await tx
      .update(schema.reviews)
      .set({ approvedAt: approved ? new Date() : null, updatedAt: new Date() })
      .where(eq(schema.reviews.id, id))
      .returning();
    if (!row) throw ApiError.hidden('Review');
    return { review: present(row), message: approved ? 'Review approved.' : 'Review rejected.' };
  });
}
