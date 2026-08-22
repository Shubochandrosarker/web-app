import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace } from '@bos/database';
import { ApiError } from '../lib/errors.ts';
import { requirePermission } from '../lib/permissions.ts';
import { requireUserId, requireWorkspace } from '../lib/context.ts';
import type { AppContext } from '../app.ts';

/**
 * The notifications centre. Rows are per recipient, so every query here is
 * `userId = me` inside the workspace transaction — no member can read
 * another's queue, and marking read is scoped the same way.
 */
export function registerNotificationRoutes(app: FastifyInstance, context: AppContext): void {
  const { db } = context;

  app.get(
    '/v1/notifications',
    { config: { bosAccess: requirePermission('settings.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const userId = requireUserId(request);
      const query = z
        .object({
          unread: z.coerce.boolean().default(false),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        })
        .parse(request.query);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const conditions = [eq(schema.notifications.userId, userId)];
        if (query.unread) conditions.push(isNull(schema.notifications.readAt));

        const rows = await tx
          .select()
          .from(schema.notifications)
          .where(and(...conditions))
          .orderBy(desc(schema.notifications.createdAt))
          .limit(query.limit);

        const [unreadCount] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(schema.notifications)
          .where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)));

        return {
          unreadCount: unreadCount?.count ?? 0,
          items: rows.map((row) => ({
            id: row.id,
            kind: row.kind,
            severity: row.severity,
            title: row.title,
            body: row.body,
            href: row.href,
            readAt: row.readAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
          })),
        };
      });
    },
  );

  app.post(
    '/v1/notifications/:id/read',
    { config: { bosAccess: requirePermission('settings.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const userId = requireUserId(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [row] = await tx
          .update(schema.notifications)
          .set({ readAt: new Date() })
          .where(
            and(
              eq(schema.notifications.id, id),
              eq(schema.notifications.userId, userId),
              isNull(schema.notifications.readAt),
            ),
          )
          .returning({ id: schema.notifications.id });
        if (!row) throw ApiError.hidden('Notification');
        return { ok: true };
      });
    },
  );

  app.post(
    '/v1/notifications/read-all',
    { config: { bosAccess: requirePermission('settings.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const userId = requireUserId(request);
      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        await tx
          .update(schema.notifications)
          .set({ readAt: new Date() })
          .where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)));
        return { ok: true };
      });
    },
  );
}
