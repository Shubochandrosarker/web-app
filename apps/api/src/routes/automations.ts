import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace } from '@bos/database';
import {
  automationDefinitionSchema,
  automationStepSchema,
  conditionSchema,
  parseCron,
  type AutomationStep,
} from '@bos/automation';
import { EVENT_NAMES } from '@bos/events';
import { ApiError } from '../lib/errors.ts';
import { requirePermission } from '../lib/permissions.ts';
import { requestContext, requireUserId, requireWorkspace } from '../lib/context.ts';
import type { AutomationEngine } from '../services/automation-engine.ts';
import type { AppContext } from '../app.ts';

/**
 * The automation builder's API.
 *
 * The one non-obvious rule: **editing never touches a stored version.** Every
 * save writes a new `automation_versions` row and moves `current_version`
 * forward; runs pin the version they started on, so a customer halfway
 * through a three-day sequence finishes the sequence they entered, not the
 * one somebody edited on day two.
 *
 * Event and schedule triggers are accepted — the two kinds the engine
 * honours (events enroll from the outbox; schedules from the dispatcher's
 * minute sweep). Webhook triggers stay out of the menu until the engine
 * enrolls from them: offering a trigger that silently never runs is worse
 * than a smaller menu. A schedule's cron is validated at save time, loudly.
 */

const eventTrigger = z.object({ kind: z.literal('event'), event: z.enum(EVENT_NAMES) });
const scheduleTrigger = z.object({
  kind: z.literal('schedule'),
  /** Five-field cron, evaluated in the workspace's time zone. */
  cron: z.string().min(9).max(120),
});

const automationTrigger = z
  .discriminatedUnion('kind', [eventTrigger, scheduleTrigger])
  .superRefine((trigger, context) => {
    if (trigger.kind !== 'schedule') return;
    try {
      parseCron(trigger.cron);
    } catch (error) {
      context.addIssue({
        code: 'custom',
        path: ['cron'],
        message: error instanceof Error ? error.message : 'Invalid cron expression.',
      });
    }
  });

const automationInput = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,139}$/, 'must be lowercase letters, digits and hyphens')
    .optional(),
  description: z.string().max(1000).optional(),
  trigger: automationTrigger,
  condition: conditionSchema.optional(),
  steps: z.array(automationStepSchema).min(1).max(100),
  reentry: z.enum(['once_per_contact', 'once_per_entity', 'always']).default('once_per_entity'),
  maxRunSeconds: z
    .number()
    .int()
    .min(60)
    .max(31_536_000)
    .default(30 * 24 * 3600),
});

/**
 * Invariants beyond field shape: step ids must be unique across the whole
 * tree (the run records progress by step id), and branch nesting is capped —
 * a five-deep decision tree is a definition nobody can reason about, and
 * unbounded recursion is a stack problem waiting for an author.
 */
function assertStepInvariants(steps: readonly AutomationStep[]): void {
  const seen = new Set<string>();
  let total = 0;

  const walk = (list: readonly AutomationStep[], depth: number): void => {
    if (depth > 5) {
      throw ApiError.badRequest('Branches may nest at most five levels deep.');
    }
    for (const step of list) {
      total += 1;
      if (total > 200) throw ApiError.badRequest('An automation may have at most 200 steps.');
      if (seen.has(step.id)) {
        throw ApiError.badRequest('Every step needs its own id; one appears twice.');
      }
      seen.add(step.id);
      if (step.type === 'branch') {
        walk(step.then, depth + 1);
        walk(step.otherwise, depth + 1);
      }
    }
  };

  walk(steps, 1);
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 140) || 'automation'
  );
}

export interface AutomationRouteDependencies {
  readonly engine: AutomationEngine;
}

export function registerAutomationRoutes(
  app: FastifyInstance,
  context: AppContext,
  deps: AutomationRouteDependencies,
): void {
  const { db } = context;

  /* ---------------------------------------------------------------- listing */

  app.get(
    '/v1/automations',
    { config: { bosAccess: requirePermission('automations.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);

      const { rows, stats } = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const rows = await tx
          .select({
            id: schema.automations.id,
            slug: schema.automations.slug,
            name: schema.automations.name,
            description: schema.automations.description,
            enabled: schema.automations.enabled,
            currentVersion: schema.automations.currentVersion,
            triggerEvent: schema.automations.triggerEvent,
            updatedAt: schema.automations.updatedAt,
          })
          .from(schema.automations)
          .where(isNull(schema.automations.deletedAt))
          .orderBy(desc(schema.automations.updatedAt));

        // Aggregated separately and merged in code: a correlated subquery is
        // where Drizzle renders embedded columns unqualified (see crm.ts).
        const stats = await tx
          .select({
            automationId: schema.automationRuns.automationId,
            total: sql<number>`count(*)::int`,
            active: sql<number>`count(*) filter (where ${schema.automationRuns.status} in ('running', 'waiting'))::int`,
            failed: sql<number>`count(*) filter (where ${schema.automationRuns.status} = 'failed')::int`,
            lastRunAt: sql<string | null>`max(${schema.automationRuns.startedAt})`,
          })
          .from(schema.automationRuns)
          .groupBy(schema.automationRuns.automationId);

        return { rows, stats };
      });

      const byAutomation = new Map(stats.map((stat) => [stat.automationId, stat]));
      return {
        items: rows.map((row) => {
          const stat = byAutomation.get(row.id);
          return {
            ...row,
            updatedAt: row.updatedAt.toISOString(),
            runCount: stat?.total ?? 0,
            activeRunCount: stat?.active ?? 0,
            failedRunCount: stat?.failed ?? 0,
            lastRunAt: stat?.lastRunAt ?? null,
          };
        }),
      };
    },
  );

  app.get(
    '/v1/automations/:id',
    { config: { bosAccess: requirePermission('automations.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);

      const result = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.automations)
          .where(and(eq(schema.automations.id, id), isNull(schema.automations.deletedAt)))
          .limit(1);
        if (!row) return null;

        const [version] = await tx
          .select({ definition: schema.automationVersions.definition })
          .from(schema.automationVersions)
          .where(
            and(
              eq(schema.automationVersions.automationId, id),
              eq(schema.automationVersions.version, row.currentVersion),
            ),
          )
          .limit(1);

        // Definition history: every save is a version, and runs pin theirs,
        // so the list is the full audit trail of what could have executed.
        const versions = await tx
          .select({
            version: schema.automationVersions.version,
            createdAt: schema.automationVersions.createdAt,
          })
          .from(schema.automationVersions)
          .where(eq(schema.automationVersions.automationId, id))
          .orderBy(desc(schema.automationVersions.version))
          .limit(50);

        const [metrics] = await tx
          .select({
            total: sql<number>`count(*)::int`,
            completed: sql<number>`count(*) filter (where ${schema.automationRuns.status} = 'completed')::int`,
            failed: sql<number>`count(*) filter (where ${schema.automationRuns.status} = 'failed')::int`,
            active: sql<number>`count(*) filter (where ${schema.automationRuns.status} in ('running', 'waiting'))::int`,
            lastRunAt: sql<string | null>`max(${schema.automationRuns.startedAt})`,
          })
          .from(schema.automationRuns)
          .where(eq(schema.automationRuns.automationId, id));

        return { row, definition: version?.definition ?? null, versions, metrics };
      });
      if (!result) throw ApiError.hidden('Automation');

      const { row, definition, versions, metrics } = result;
      return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        enabled: row.enabled,
        currentVersion: row.currentVersion,
        definition,
        versions: versions.map((entry) => ({
          version: entry.version,
          createdAt: entry.createdAt.toISOString(),
        })),
        metrics: {
          total: metrics?.total ?? 0,
          completed: metrics?.completed ?? 0,
          failed: metrics?.failed ?? 0,
          active: metrics?.active ?? 0,
          lastRunAt: metrics?.lastRunAt ?? null,
        },
        updatedAt: row.updatedAt.toISOString(),
      };
    },
  );

  /**
   * The failed-run queue, across every automation: what needs a person, with
   * enough context to decide between replaying and fixing the definition.
   */
  app.get(
    '/v1/automations/runs',
    { config: { bosAccess: requirePermission('automations.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const query = z
        .object({
          status: z.enum(['failed', 'running', 'waiting', 'completed', 'cancelled']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);

      return withWorkspace(db, workspace.workspaceId, async (tx) => {
        const conditions = query.status ? [eq(schema.automationRuns.status, query.status)] : [];
        const rows = await tx
          .select({
            id: schema.automationRuns.id,
            automationId: schema.automationRuns.automationId,
            automationName: schema.automations.name,
            status: schema.automationRuns.status,
            failureReason: schema.automationRuns.failureReason,
            startedAt: schema.automationRuns.startedAt,
            completedAt: schema.automationRuns.completedAt,
          })
          .from(schema.automationRuns)
          .innerJoin(
            schema.automations,
            eq(schema.automations.id, schema.automationRuns.automationId),
          )
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(schema.automationRuns.startedAt))
          .limit(query.limit);

        return {
          items: rows.map((row) => ({
            ...row,
            startedAt: row.startedAt.toISOString(),
            completedAt: row.completedAt?.toISOString() ?? null,
          })),
        };
      });
    },
  );

  /* ---------------------------------------------------------------- writing */

  app.post(
    '/v1/automations',
    { config: { bosAccess: requirePermission('automations.write') } },
    async (request, reply) => {
      const workspace = requireWorkspace(request);
      const input = automationInput.parse(request.body);
      assertStepInvariants(input.steps);

      const created = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [automation] = await tx
          .insert(schema.automations)
          .values({
            workspaceId: workspace.workspaceId,
            slug: input.slug ?? slugify(input.name),
            name: input.name,
            description: input.description ?? null,
            enabled: false,
            currentVersion: 1,
            triggerKind: input.trigger.kind,
            triggerEvent: input.trigger.kind === 'event' ? input.trigger.event : null,
            createdBy: requireUserId(request),
          })
          .returning({ id: schema.automations.id });
        const automationId = automation!.id;

        const definition = automationDefinitionSchema.parse({
          id: automationId,
          workspaceId: workspace.workspaceId,
          version: 1,
          name: input.name,
          ...(input.description ? { description: input.description } : {}),
          enabled: false,
          trigger: input.trigger,
          ...(input.condition ? { condition: input.condition } : {}),
          steps: input.steps,
          reentry: input.reentry,
          maxRunSeconds: input.maxRunSeconds,
        });

        await tx.insert(schema.automationVersions).values({
          workspaceId: workspace.workspaceId,
          automationId,
          version: 1,
          definition,
          createdBy: requireUserId(request),
        });

        return automationId;
      }).catch((error: unknown) => {
        if ((error as { cause?: { code?: string } }).cause?.code === '23505') {
          throw ApiError.conflict('Another automation already uses that slug.');
        }
        throw error;
      });

      await context.auth.audit(
        workspace.workspaceId,
        requireUserId(request),
        'automation.created',
        requestContext(request),
        { automationId: created, name: input.name },
      );

      return reply.status(201).send({ id: created });
    },
  );

  app.put(
    '/v1/automations/:id',
    { config: { bosAccess: requirePermission('automations.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const input = automationInput.parse(request.body);
      assertStepInvariants(input.steps);

      const version = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [row] = await tx
          .select({
            id: schema.automations.id,
            enabled: schema.automations.enabled,
            currentVersion: schema.automations.currentVersion,
          })
          .from(schema.automations)
          .where(and(eq(schema.automations.id, id), isNull(schema.automations.deletedAt)))
          .limit(1);
        if (!row) return null;

        const nextVersion = row.currentVersion + 1;
        const definition = automationDefinitionSchema.parse({
          id,
          workspaceId: workspace.workspaceId,
          version: nextVersion,
          name: input.name,
          ...(input.description ? { description: input.description } : {}),
          enabled: row.enabled,
          trigger: input.trigger,
          ...(input.condition ? { condition: input.condition } : {}),
          steps: input.steps,
          reentry: input.reentry,
          maxRunSeconds: input.maxRunSeconds,
        });

        await tx.insert(schema.automationVersions).values({
          workspaceId: workspace.workspaceId,
          automationId: id,
          version: nextVersion,
          definition,
          createdBy: requireUserId(request),
        });

        await tx
          .update(schema.automations)
          .set({
            name: input.name,
            description: input.description ?? null,
            currentVersion: nextVersion,
            triggerKind: input.trigger.kind,
            triggerEvent: input.trigger.kind === 'event' ? input.trigger.event : null,
            updatedAt: new Date(),
          })
          .where(eq(schema.automations.id, id));

        return nextVersion;
      });
      if (version === null) throw ApiError.hidden('Automation');

      await context.auth.audit(
        workspace.workspaceId,
        requireUserId(request),
        'automation.updated',
        requestContext(request),
        { automationId: id, version },
      );

      return { id, version };
    },
  );

  app.patch(
    '/v1/automations/:id',
    { config: { bosAccess: requirePermission('automations.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);

      const updated = await withWorkspace(db, workspace.workspaceId, (tx) =>
        tx
          .update(schema.automations)
          .set({ enabled, updatedAt: new Date() })
          .where(and(eq(schema.automations.id, id), isNull(schema.automations.deletedAt)))
          .returning({ id: schema.automations.id }),
      );
      if (updated.length === 0) throw ApiError.hidden('Automation');

      await context.auth.audit(
        workspace.workspaceId,
        requireUserId(request),
        enabled ? 'automation.enabled' : 'automation.disabled',
        requestContext(request),
        { automationId: id },
      );

      return { id, enabled };
    },
  );

  /**
   * Clone: a disabled copy of the current version under a fresh slug. The
   * safe way to iterate on a live sequence — edit the copy, enable it, then
   * disable the original — without a mid-flight version change.
   */
  app.post(
    '/v1/automations/:id/clone',
    { config: { bosAccess: requirePermission('automations.write') } },
    async (request, reply) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const userId = requireUserId(request);

      const created = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [source] = await tx
          .select()
          .from(schema.automations)
          .where(and(eq(schema.automations.id, id), isNull(schema.automations.deletedAt)))
          .limit(1);
        if (!source) return null;

        const [versionRow] = await tx
          .select({ definition: schema.automationVersions.definition })
          .from(schema.automationVersions)
          .where(
            and(
              eq(schema.automationVersions.automationId, id),
              eq(schema.automationVersions.version, source.currentVersion),
            ),
          )
          .limit(1);
        if (!versionRow) return null;

        const baseSlug = `${source.slug}-copy`.slice(0, 140);
        let nextSlug = baseSlug;
        for (let suffix = 2; suffix < 100; suffix += 1) {
          const [taken] = await tx
            .select({ id: schema.automations.id })
            .from(schema.automations)
            .where(and(eq(schema.automations.slug, nextSlug), isNull(schema.automations.deletedAt)))
            .limit(1);
          if (!taken) break;
          const suffixText = `-${suffix}`;
          nextSlug = `${baseSlug.slice(0, 140 - suffixText.length)}${suffixText}`;
        }

        const [clone] = await tx
          .insert(schema.automations)
          .values({
            workspaceId: workspace.workspaceId,
            slug: nextSlug,
            name: `${source.name} (copy)`,
            description: source.description,
            enabled: false,
            currentVersion: 1,
            triggerKind: source.triggerKind,
            triggerEvent: source.triggerEvent,
            createdBy: userId,
          })
          .returning({ id: schema.automations.id });

        const sourceDefinition = automationDefinitionSchema.parse(versionRow.definition);
        const definition = automationDefinitionSchema.parse({
          ...sourceDefinition,
          id: clone!.id,
          workspaceId: workspace.workspaceId,
          version: 1,
          name: `${source.name} (copy)`,
          enabled: false,
        });

        await tx.insert(schema.automationVersions).values({
          workspaceId: workspace.workspaceId,
          automationId: clone!.id,
          version: 1,
          definition,
          createdBy: userId,
        });

        return clone!.id;
      });
      if (!created) throw ApiError.hidden('Automation');

      await context.auth.audit(
        workspace.workspaceId,
        userId,
        'automation.cloned',
        requestContext(request),
        { sourceId: id, automationId: created },
      );

      return reply.status(201).send({ id: created, message: 'Cloned as a disabled draft.' });
    },
  );

  app.delete(
    '/v1/automations/:id',
    { config: { bosAccess: requirePermission('automations.write') } },
    async (request, reply) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);

      // Soft-deleted and disabled together: the definition and run history
      // stay for the audit trail, but nothing enrolls again.
      const updated = await withWorkspace(db, workspace.workspaceId, (tx) =>
        tx
          .update(schema.automations)
          .set({ enabled: false, deletedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(schema.automations.id, id), isNull(schema.automations.deletedAt)))
          .returning({ id: schema.automations.id }),
      );
      if (updated.length === 0) throw ApiError.hidden('Automation');

      await context.auth.audit(
        workspace.workspaceId,
        requireUserId(request),
        'automation.deleted',
        requestContext(request),
        { automationId: id },
      );

      return reply.status(204).send();
    },
  );

  /* ------------------------------------------------------------ run history */

  app.get(
    '/v1/automations/:id/runs',
    { config: { bosAccess: requirePermission('automations.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const query = z
        .object({
          status: z.enum(['running', 'waiting', 'completed', 'failed', 'cancelled']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(request.query);

      const items = await withWorkspace(db, workspace.workspaceId, (tx) =>
        tx
          .select({
            id: schema.automationRuns.id,
            status: schema.automationRuns.status,
            entityType: schema.automationRuns.entityType,
            entityId: schema.automationRuns.entityId,
            contactId: schema.automationRuns.contactId,
            contactName: schema.contacts.fullName,
            startedAt: schema.automationRuns.startedAt,
            completedAt: schema.automationRuns.completedAt,
            resumeAt: schema.automationRuns.resumeAt,
            waitingForEvent: schema.automationRuns.waitingForEvent,
            failureReason: schema.automationRuns.failureReason,
          })
          .from(schema.automationRuns)
          .leftJoin(schema.contacts, eq(schema.contacts.id, schema.automationRuns.contactId))
          .where(
            and(
              eq(schema.automationRuns.automationId, id),
              query.status ? eq(schema.automationRuns.status, query.status) : undefined,
            ),
          )
          .orderBy(desc(schema.automationRuns.startedAt))
          .limit(query.limit),
      );

      return {
        items: items.map((run) => ({
          ...run,
          startedAt: run.startedAt.toISOString(),
          completedAt: run.completedAt?.toISOString() ?? null,
          resumeAt: run.resumeAt?.toISOString() ?? null,
        })),
      };
    },
  );

  app.get(
    '/v1/automations/runs/:runId',
    { config: { bosAccess: requirePermission('automations.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { runId } = z.object({ runId: z.uuid() }).parse(request.params);

      const result = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [run] = await tx
          .select()
          .from(schema.automationRuns)
          .where(eq(schema.automationRuns.id, runId))
          .limit(1);
        if (!run) return null;

        const steps = await tx
          .select()
          .from(schema.automationRunSteps)
          .where(eq(schema.automationRunSteps.runId, runId))
          .orderBy(schema.automationRunSteps.sequence);

        const [version] = await tx
          .select({ definition: schema.automationVersions.definition })
          .from(schema.automationVersions)
          .where(eq(schema.automationVersions.id, run.automationVersionId))
          .limit(1);

        return { run, steps, definition: version?.definition ?? null };
      });
      if (!result) throw ApiError.hidden('Run');

      const { run, steps, definition } = result;
      return {
        id: run.id,
        automationId: run.automationId,
        status: run.status,
        entityType: run.entityType,
        entityId: run.entityId,
        contactId: run.contactId,
        context: run.context,
        startedAt: run.startedAt.toISOString(),
        completedAt: run.completedAt?.toISOString() ?? null,
        resumeAt: run.resumeAt?.toISOString() ?? null,
        waitingForEvent: run.waitingForEvent,
        failureReason: run.failureReason,
        definition,
        steps: steps.map((step) => ({
          id: step.id,
          stepId: step.stepId,
          sequence: step.sequence,
          type: step.type,
          action: step.action,
          status: step.status,
          attempt: step.attempt,
          startedAt: step.startedAt?.toISOString() ?? null,
          completedAt: step.completedAt?.toISOString() ?? null,
          output: step.output,
          failureReason: step.failureReason,
        })),
      };
    },
  );

  app.post(
    '/v1/automations/runs/:runId/retry',
    { config: { bosAccess: requirePermission('automations.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { runId } = z.object({ runId: z.uuid() }).parse(request.params);

      const retried = await deps.engine.retryRun(workspace.workspaceId, runId);
      if (!retried) {
        throw ApiError.badRequest('Only a failed run can be retried.');
      }

      await context.auth.audit(
        workspace.workspaceId,
        requireUserId(request),
        'automation.run_retried',
        requestContext(request),
        { runId },
      );

      return { id: runId, retried: true };
    },
  );
}
