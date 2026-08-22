import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace, withoutTenantScope } from '@bos/database';
import { ApiError } from '../lib/errors.ts';
import { consumeRateLimit } from '../lib/redis.ts';
import { requirePermission, WORKSPACE_ROLES } from '../lib/permissions.ts';
import { requestContext, requireUserId, requireWorkspace } from '../lib/context.ts';
import type { AppContext } from '../app.ts';

/**
 * Team operations: who is in the workspace, with what role, whether they
 * have MFA — and the lifecycle around that: invite, change role, suspend.
 *
 * Two guards matter more than the rest. The last owner can never be
 * demoted or suspended — a workspace nobody owns is a support ticket with
 * no one to file it. And an invitation never contains a password: it
 * creates an invited user and sends the set-password flow, so credentials
 * are chosen by their owner and never transit email.
 */

const inviteInput = z.object({
  email: z.string().email().max(320),
  fullName: z.string().min(1).max(200),
  role: z.enum(['admin', 'manager', 'staff', 'viewer']),
});

const memberPatch = z
  .object({
    role: z.enum(['owner', 'admin', 'manager', 'staff', 'viewer']).optional(),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .refine((patch) => patch.role !== undefined || patch.status !== undefined, {
    message: 'Nothing to change.',
  });

export interface MemberRouteDependencies {
  readonly sendAuthEmail: (input: {
    kind: 'password_reset' | 'invitation';
    to: string;
    token: string;
  }) => Promise<void>;
}

export function registerMemberRoutes(
  app: FastifyInstance,
  context: AppContext,
  deps: MemberRouteDependencies,
): void {
  const { db } = context;

  app.get(
    '/v1/members',
    { config: { bosAccess: requirePermission('members.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const rows = await tx
          .select({
            userId: schema.users.id,
            email: schema.users.email,
            fullName: schema.users.fullName,
            status: schema.users.status,
            mfaEnabledAt: schema.users.mfaEnabledAt,
            role: schema.workspaceMembers.role,
            joinedAt: schema.workspaceMembers.createdAt,
          })
          .from(schema.workspaceMembers)
          .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
          .orderBy(desc(schema.workspaceMembers.createdAt));

        // Active sessions per member — visible security posture, not content.
        const sessions = await withoutTenantScope(db, (stx) =>
          stx
            .select({
              userId: schema.sessions.userId,
              count: sql<number>`count(*)::int`,
            })
            .from(schema.sessions)
            .where(
              and(
                sql`${schema.sessions.revokedAt} is null`,
                gte(schema.sessions.expiresAt, new Date()),
              ),
            )
            .groupBy(schema.sessions.userId),
        );
        const sessionsByUser = new Map(sessions.map((row) => [row.userId, row.count]));

        return {
          items: rows.map((row) => ({
            userId: row.userId,
            email: row.email,
            fullName: row.fullName,
            status: row.status,
            role: row.role,
            mfaEnabled: row.mfaEnabledAt !== null,
            activeSessions: sessionsByUser.get(row.userId) ?? 0,
            joinedAt: row.joinedAt.toISOString(),
          })),
        };
      });
    },
  );

  app.post(
    '/v1/members/invite',
    {
      config: {
        bosAccess: requirePermission('members.invite'),
        rateLimit: { max: 30, timeWindow: '1 hour' },
      },
    },
    async (request, reply) => {
      const workspace = requireWorkspace(request);
      const actorId = requireUserId(request);
      const input = inviteInput.parse(request.body);
      const email = input.email.trim().toLowerCase();

      // Inviting creates users and sends email — an abused admin session
      // must not become a mail cannon or a user-table flood. Per actor and
      // per workspace, because either alone can be the runaway dimension.
      const rate = await consumeRateLimit(
        context.redis,
        `rl:invite:${workspace.workspaceId}:${actorId}`,
        20,
        3600,
      );
      if (!rate.allowed) {
        return reply
          .status(429)
          .header('retry-after', String(rate.resetSeconds))
          .send({
            error: {
              code: 'too_many_requests',
              message: 'Too many invitations this hour. Please try again later.',
            },
          });
      }

      const userId = await withoutTenantScope(db, async (tx) => {
        const [existing] = await tx
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.email, email))
          .limit(1);

        const id =
          existing?.id ??
          (
            await tx
              .insert(schema.users)
              .values({
                email,
                fullName: input.fullName.trim(),
                // No password: the invite email carries the set-password flow.
                passwordHash: `invited:${randomUUID()}`,
                status: 'invited',
              })
              .returning({ id: schema.users.id })
          )[0]!.id;

        await tx
          .insert(schema.workspaceMembers)
          .values({ workspaceId: workspace.workspaceId, userId: id, role: input.role })
          .onConflictDoNothing();
        return id;
      });

      // The set-password email. In log mode this records instead of sending —
      // which is also what makes it testable without a provider.
      const reset = await context.auth.createPasswordResetToken(email);
      if (reset) {
        await deps
          .sendAuthEmail({ kind: 'invitation', to: email, token: reset.token })
          .catch(() => undefined);
      }

      await context.auth.audit(
        workspace.workspaceId,
        actorId,
        'member.invited',
        requestContext(request),
        {
          invitedUserId: userId,
          role: input.role,
        },
      );

      return reply.status(201).send({
        userId,
        message: `Invitation created. ${email} sets their own password through the emailed link.`,
      });
    },
  );

  app.patch(
    '/v1/members/:userId',
    {
      config: {
        bosAccess: requirePermission('members.manage'),
        rateLimit: { max: 90, timeWindow: '1 hour' },
      },
    },
    async (request) => {
      const workspace = requireWorkspace(request);
      const actorId = requireUserId(request);
      const { userId } = z.object({ userId: z.uuid() }).parse(request.params);
      const patch = memberPatch.parse(request.body);

      // Role and status changes revoke sessions and rewrite authorization;
      // a runaway client must be a 429, not a hundred audit entries.
      const rate = await consumeRateLimit(
        context.redis,
        `rl:member-manage:${workspace.workspaceId}:${actorId}`,
        60,
        3600,
      );
      if (!rate.allowed) {
        throw ApiError.tooManyRequests('Too many membership changes this hour.');
      }

      const result = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [member] = await tx
          .select({ role: schema.workspaceMembers.role })
          .from(schema.workspaceMembers)
          .where(eq(schema.workspaceMembers.userId, userId))
          .limit(1);
        if (!member) throw ApiError.hidden('Member');

        // The last owner is immovable: demotion and suspension both refuse.
        if (member.role === 'owner' && (patch.role !== undefined || patch.status === 'suspended')) {
          const [owners] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(schema.workspaceMembers)
            .where(eq(schema.workspaceMembers.role, 'owner'));
          if ((owners?.count ?? 0) <= 1) {
            throw ApiError.badRequest(
              'This is the only owner. Give someone else the owner role first.',
            );
          }
        }

        if (patch.role !== undefined) {
          await tx
            .update(schema.workspaceMembers)
            .set({ role: patch.role, updatedAt: new Date() })
            .where(eq(schema.workspaceMembers.userId, userId));
        }
        return { previousRole: member.role };
      });

      if (patch.status !== undefined) {
        // User status is global (identity), not workspace-scoped.
        await withoutTenantScope(db, (tx) =>
          tx
            .update(schema.users)
            .set({ status: patch.status!, updatedAt: new Date() })
            .where(eq(schema.users.id, userId)),
        );
        if (patch.status === 'suspended') {
          await context.auth.logoutAll(userId).catch(() => undefined);
        }
      }

      await context.auth.audit(
        workspace.workspaceId,
        actorId,
        patch.status === 'suspended'
          ? 'member.suspended'
          : patch.status === 'active'
            ? 'member.reactivated'
            : 'member.role_changed',
        requestContext(request),
        { targetUserId: userId, previousRole: result.previousRole, ...patch },
      );

      return { ok: true };
    },
  );

  /* The role list, so the UI never hardcodes it. */
  app.get(
    '/v1/members/roles',
    { config: { bosAccess: requirePermission('members.read') } },
    async () => ({ roles: WORKSPACE_ROLES }),
  );
}
