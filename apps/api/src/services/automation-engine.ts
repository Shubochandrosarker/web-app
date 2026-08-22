import { createHmac } from 'node:crypto';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { schema, withWorkspace, withoutTenantScope, type Database } from '@bos/database';
import {
  automationDefinitionSchema,
  evaluateCondition,
  readPath,
  type AutomationDefinition,
  type AutomationStep,
  type RunContext,
} from '@bos/automation';
import type { ApiConfig } from '../lib/env.ts';
import type { EmailProvider, WhatsappProvider } from '../providers/notifications.ts';

/**
 * The automation engine — a durable interpreter over stored definitions.
 *
 * Rules it lives by:
 *
 *  - **Durable, not clever.** Every pause — a wait step, a retry backoff, a
 *    wait-for-event — is a row (`status = waiting`, `resume_at`, or
 *    `waiting_for_event`), never a timer in memory. A deploy mid-run loses
 *    nothing; the resume sweep picks the run up where the row says it was.
 *  - **Idempotent at every layer.** Enrollment dedupes on the definition's
 *    re-entry policy via a partial unique index; message-sending actions key
 *    on `auto:{runId}:{stepId}` so a retried step cannot send twice; branch
 *    decisions are recorded in the run context and replayed on resume rather
 *    than re-evaluated, so a resumed run cannot take a different path than
 *    the one it committed to.
 *  - **Fail closed, visibly.** A step that exhausts its retries fails the
 *    run with the reason on the row — the dead-letter state a person can see
 *    and retry from the dashboard. Nothing is silently dropped.
 *  - **Bounded.** A run executes at most {@link MAX_STEP_EXECUTIONS} step
 *    executions and lives at most its definition's `maxRunSeconds`; both are
 *    loop protection against a definition that cycles.
 */

const MAX_STEP_EXECUTIONS = 200;

/**
 * What the engine needs from an event — a structural subset of both the
 * outbox's dispatched row and the full `EventEnvelope`, so either can be
 * offered without adapter code.
 */
export interface EngineEvent {
  readonly workspaceId: string;
  readonly name: string;
  readonly payload: Record<string, unknown>;
}

export interface AutomationEngineDeps {
  readonly db: Database;
  readonly config: ApiConfig;
  readonly email: EmailProvider;
  readonly whatsapp: WhatsappProvider;
  readonly logger: {
    info(payload: Record<string, unknown>, message: string): void;
    warn(payload: Record<string, unknown>, message: string): void;
    error(payload: Record<string, unknown>, message: string): void;
  };
}

type RunRow = typeof schema.automationRuns.$inferSelect;

interface MutableContext extends Record<string, unknown> {
  _branches?: Record<string, 'then' | 'otherwise'>;
  _retryStepId?: string | null;
  steps?: Record<string, unknown>;
}

export function createAutomationEngine(deps: AutomationEngineDeps) {
  const { db, logger } = deps;

  /* ------------------------------------------------------------ enrolment */

  /**
   * Offer an event to every enabled automation whose trigger names it.
   * Called by the outbox handler for each dispatched event, which gives
   * enrollment the outbox's at-least-once guarantee — the dedupe index turns
   * that into exactly-one run.
   */
  async function enrollFromEvent(event: EngineEvent): Promise<void> {
    const candidates = await withWorkspace(db, event.workspaceId, (tx) =>
      tx
        .select({
          id: schema.automations.id,
          currentVersion: schema.automations.currentVersion,
        })
        .from(schema.automations)
        .where(
          and(
            eq(schema.automations.enabled, true),
            eq(schema.automations.triggerKind, 'event'),
            eq(schema.automations.triggerEvent, event.name),
            isNull(schema.automations.deletedAt),
          ),
        ),
    );

    for (const candidate of candidates) {
      try {
        await enrollOne(candidate.id, candidate.currentVersion, event);
      } catch (error) {
        // One broken automation must not stop the others from enrolling.
        logger.error(
          { automationId: candidate.id, event: event.name, err: String(error) },
          'Automation enrollment failed',
        );
      }
    }
  }

  async function enrollOne(
    automationId: string,
    version: number,
    event: EngineEvent,
  ): Promise<void> {
    const definition = await loadDefinition(event.workspaceId, automationId, version);
    if (!definition) return;

    const payload = event.payload as Record<string, unknown>;
    const contactId = typeof payload.contactId === 'string' ? payload.contactId : null;
    const leadId = typeof payload.leadId === 'string' ? payload.leadId : null;
    const entityType = leadId ? 'lead' : contactId ? 'contact' : null;
    const entityId = leadId ?? contactId;

    const dedupeKey =
      definition.reentry === 'always'
        ? null
        : definition.reentry === 'once_per_contact'
          ? contactId
            ? `contact:${contactId}`
            : null
          : entityId
            ? `${entityType}:${entityId}`
            : null;

    const context = await buildInitialContext(event, contactId, leadId);

    if (definition.condition && !evaluateCondition(context, definition.condition)) {
      return;
    }

    const runId = await withWorkspace(db, event.workspaceId, async (tx) => {
      const [versionRow] = await tx
        .select({ id: schema.automationVersions.id })
        .from(schema.automationVersions)
        .where(
          and(
            eq(schema.automationVersions.automationId, automationId),
            eq(schema.automationVersions.version, version),
          ),
        )
        .limit(1);
      if (!versionRow) return null;

      const inserted = await tx
        .insert(schema.automationRuns)
        .values({
          workspaceId: event.workspaceId,
          automationId,
          automationVersionId: versionRow.id,
          status: 'running',
          entityType,
          entityId,
          contactId,
          context,
          dedupeKey,
        })
        // The dedupe index is partial (WHERE dedupe_key IS NOT NULL), which a
        // column-targeted ON CONFLICT cannot name without repeating the
        // predicate; the untargeted form catches it all the same.
        .onConflictDoNothing()
        .returning({ id: schema.automationRuns.id });

      return inserted[0]?.id ?? null;
    });

    // Conflict means the re-entry policy already enrolled this entity.
    if (!runId) return;

    await continueRun(runId, event.workspaceId);
  }

  async function buildInitialContext(
    event: EngineEvent,
    contactId: string | null,
    leadId: string | null,
  ): Promise<MutableContext> {
    const context: MutableContext = {
      event: { name: event.name, payload: event.payload },
      trigger: event.payload,
      steps: {},
    };

    await withWorkspace(db, event.workspaceId, async (tx) => {
      if (contactId) {
        const [contact] = await tx
          .select({
            id: schema.contacts.id,
            fullName: schema.contacts.fullName,
            email: schema.contacts.email,
            phone: schema.contacts.phone,
            whatsapp: schema.contacts.whatsapp,
            locale: schema.contacts.locale,
          })
          .from(schema.contacts)
          .where(eq(schema.contacts.id, contactId))
          .limit(1);
        if (contact) context.contact = contact;
      }
      if (leadId) {
        const [lead] = await tx
          .select({
            id: schema.leads.id,
            title: schema.leads.title,
            status: schema.leads.status,
            stageId: schema.leads.stageId,
            serviceId: schema.leads.serviceId,
            assignedToUserId: schema.leads.assignedToUserId,
            source: schema.leads.source,
          })
          .from(schema.leads)
          .where(eq(schema.leads.id, leadId))
          .limit(1);
        if (lead) context.lead = lead;
      }
    });

    return context;
  }

  async function loadDefinition(
    workspaceId: string,
    automationId: string,
    version: number,
  ): Promise<AutomationDefinition | null> {
    const row = await withWorkspace(db, workspaceId, async (tx) => {
      const [versionRow] = await tx
        .select({ definition: schema.automationVersions.definition })
        .from(schema.automationVersions)
        .where(
          and(
            eq(schema.automationVersions.automationId, automationId),
            eq(schema.automationVersions.version, version),
          ),
        )
        .limit(1);
      return versionRow;
    });
    if (!row) return null;

    const parsed = automationDefinitionSchema.safeParse(row.definition);
    if (!parsed.success) {
      logger.error({ automationId, version }, 'Stored automation definition failed validation');
      return null;
    }
    return parsed.data;
  }

  /* ------------------------------------------------------------ execution */

  /**
   * The execution path as currently decidable: branch nodes with a recorded
   * decision are expanded into their chosen side; a branch not yet decided
   * ends the resolution (it is the next thing to execute).
   */
  function resolvePath(
    steps: readonly AutomationStep[],
    branches: Record<string, 'then' | 'otherwise'>,
  ): AutomationStep[] {
    const path: AutomationStep[] = [];
    for (const step of steps) {
      path.push(step);
      if (step.type === 'branch') {
        const decision = branches[step.id];
        if (!decision) return path;
        path.push(...resolvePath(decision === 'then' ? step.then : step.otherwise, branches));
      }
    }
    return path;
  }

  /** Drive a run forward until it waits, completes or fails. */
  async function continueRun(runId: string, workspaceId: string): Promise<void> {
    const run = await withWorkspace(db, workspaceId, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.automationRuns)
        .where(eq(schema.automationRuns.id, runId))
        .limit(1);
      return row;
    });
    if (!run || (run.status !== 'running' && run.status !== 'waiting')) return;

    const [versionRow] = await withWorkspace(db, workspaceId, (tx) =>
      tx
        .select({
          definition: schema.automationVersions.definition,
        })
        .from(schema.automationVersions)
        .where(eq(schema.automationVersions.id, run.automationVersionId))
        .limit(1),
    );
    const parsed = versionRow ? automationDefinitionSchema.safeParse(versionRow.definition) : null;
    if (!parsed?.success) {
      await failRun(run, 'The stored definition no longer validates.');
      return;
    }
    const definition = parsed.data;

    // Ceiling on run lifetime, checked every time the run wakes.
    if (Date.now() - run.startedAt.getTime() > definition.maxRunSeconds * 1000) {
      await failRun(run, `The run exceeded its ${definition.maxRunSeconds}s ceiling.`);
      return;
    }

    const context = { ...(run.context as MutableContext) };
    context._branches ??= {};
    context.steps ??= {};

    let executed = await countExecutedSteps(workspaceId, runId);
    let currentStepId = run.currentStepId;
    let retryStepId = context._retryStepId ?? null;

    for (;;) {
      if (executed >= MAX_STEP_EXECUTIONS) {
        await failRun(run, `The run exceeded ${MAX_STEP_EXECUTIONS} step executions.`);
        return;
      }

      const path = resolvePath(definition.steps, context._branches);
      const step = retryStepId
        ? path.find((candidate) => candidate.id === retryStepId)
        : nextAfter(path, currentStepId);
      retryStepId = null;
      context._retryStepId = null;

      if (!step) {
        await completeRun(run, context);
        return;
      }

      if (step.type === 'branch') {
        const decision = evaluateCondition(context as RunContext, step.condition)
          ? ('then' as const)
          : ('otherwise' as const);
        context._branches[step.id] = decision;
        await recordStep(workspaceId, run.id, step.id, ++executed, 'branch', null, 'completed', {
          decision,
        });
        currentStepId = step.id;
        await persistProgress(run, context, currentStepId);
        continue;
      }

      if (step.type === 'wait') {
        await withWorkspace(db, workspaceId, (tx) =>
          tx
            .update(schema.automationRuns)
            .set({
              status: 'waiting',
              resumeAt: new Date(Date.now() + step.seconds * 1000),
              waitingForEvent: null,
              currentStepId: step.id,
              context,
              updatedAt: new Date(),
            })
            .where(eq(schema.automationRuns.id, run.id)),
        );
        await recordStep(workspaceId, run.id, step.id, ++executed, 'wait', null, 'completed', {
          seconds: step.seconds,
        });
        return;
      }

      if (step.type === 'wait_for_event') {
        // `correlateOn` names a field of the awaited event's payload; the
        // run's own value for it usually lives in its triggering payload.
        const correlateValue =
          readPath(context as RunContext, `trigger.${step.correlateOn}`) ??
          readPath(context as RunContext, step.correlateOn);
        (context.steps as Record<string, unknown>)[step.id] = {
          waitingFor: step.event,
          correlateOn: step.correlateOn,
          correlateValue: correlateValue ?? null,
        };
        await withWorkspaceUpdate(run, {
          status: 'waiting',
          resumeAt: new Date(Date.now() + step.timeoutSeconds * 1000),
          waitingForEvent: step.event,
          currentStepId: step.id,
          context,
        });
        await recordStep(
          workspaceId,
          run.id,
          step.id,
          ++executed,
          'wait_for_event',
          null,
          'completed',
          { event: step.event },
        );
        return;
      }

      // An action step.
      const attempt = await beginActionAttempt(workspaceId, run.id, step, ++executed);
      try {
        const output = await executeAction(deps, run, step, context as RunContext);
        (context.steps as Record<string, unknown>)[step.id] = output;
        await finishActionAttempt(workspaceId, run.id, step.id, 'completed', output, null);
        currentStepId = step.id;
        await persistProgress(run, context, currentStepId);
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 2000) : 'action failed';
        await finishActionAttempt(workspaceId, run.id, step.id, 'failed', {}, reason);

        if (attempt < step.retry.maxAttempts) {
          const backoff = step.retry.backoffSeconds * attempt;
          context._retryStepId = step.id;
          await withWorkspaceUpdate(run, {
            status: 'waiting',
            resumeAt: new Date(Date.now() + backoff * 1000),
            waitingForEvent: null,
            currentStepId,
            context,
          });
          logger.warn(
            { runId: run.id, stepId: step.id, attempt, backoff },
            'Automation step failed; retry scheduled',
          );
          return;
        }

        await failRun(run, `Step "${step.action}" failed after ${attempt} attempts: ${reason}`);
        return;
      }
    }
  }

  function nextAfter(
    path: readonly AutomationStep[],
    currentStepId: string | null,
  ): AutomationStep | undefined {
    if (!currentStepId) return path[0];
    const index = path.findIndex((step) => step.id === currentStepId);
    return index === -1 ? undefined : path[index + 1];
  }

  async function countExecutedSteps(workspaceId: string, runId: string): Promise<number> {
    const [row] = await withWorkspace(db, workspaceId, (tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.automationRunSteps)
        .where(eq(schema.automationRunSteps.runId, runId)),
    );
    return row?.count ?? 0;
  }

  async function recordStep(
    workspaceId: string,
    runId: string,
    stepId: string,
    sequence: number,
    type: string,
    action: string | null,
    status: 'completed' | 'failed',
    output: Record<string, unknown>,
  ): Promise<void> {
    await withWorkspace(db, workspaceId, (tx) =>
      tx
        .insert(schema.automationRunSteps)
        .values({
          workspaceId,
          runId,
          stepId,
          sequence,
          type,
          action,
          status,
          attempt: 1,
          startedAt: new Date(),
          completedAt: new Date(),
          output,
        })
        .onConflictDoNothing(),
    );
  }

  async function beginActionAttempt(
    workspaceId: string,
    runId: string,
    step: Extract<AutomationStep, { type: 'action' }>,
    sequence: number,
  ): Promise<number> {
    return withWorkspace(db, workspaceId, async (tx) => {
      const [existing] = await tx
        .select({ id: schema.automationRunSteps.id, attempt: schema.automationRunSteps.attempt })
        .from(schema.automationRunSteps)
        .where(
          and(
            eq(schema.automationRunSteps.runId, runId),
            eq(schema.automationRunSteps.stepId, step.id),
          ),
        )
        .limit(1);

      if (existing) {
        const attempt = existing.attempt + 1;
        await tx
          .update(schema.automationRunSteps)
          .set({ attempt, status: 'running', startedAt: new Date() })
          .where(eq(schema.automationRunSteps.id, existing.id));
        return attempt;
      }

      await tx.insert(schema.automationRunSteps).values({
        workspaceId,
        runId,
        stepId: step.id,
        sequence,
        type: 'action',
        action: step.action,
        status: 'running',
        attempt: 1,
        startedAt: new Date(),
      });
      return 1;
    });
  }

  async function finishActionAttempt(
    workspaceId: string,
    runId: string,
    stepId: string,
    status: 'completed' | 'failed',
    output: Record<string, unknown>,
    failureReason: string | null,
  ): Promise<void> {
    await withWorkspace(db, workspaceId, (tx) =>
      tx
        .update(schema.automationRunSteps)
        .set({ status, completedAt: new Date(), output, failureReason })
        .where(
          and(
            eq(schema.automationRunSteps.runId, runId),
            eq(schema.automationRunSteps.stepId, stepId),
          ),
        ),
    );
  }

  async function persistProgress(
    run: RunRow,
    context: MutableContext,
    currentStepId: string | null,
  ): Promise<void> {
    await withWorkspaceUpdate(run, {
      status: 'running',
      resumeAt: null,
      waitingForEvent: null,
      currentStepId,
      context,
    });
  }

  async function withWorkspaceUpdate(
    run: RunRow,
    values: Partial<typeof schema.automationRuns.$inferInsert>,
  ): Promise<void> {
    await withWorkspace(db, run.workspaceId, (tx) =>
      tx
        .update(schema.automationRuns)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(schema.automationRuns.id, run.id)),
    );
  }

  async function completeRun(run: RunRow, context: MutableContext): Promise<void> {
    await withWorkspaceUpdate(run, {
      status: 'completed',
      completedAt: new Date(),
      resumeAt: null,
      waitingForEvent: null,
      context,
    });
  }

  async function failRun(run: RunRow, reason: string): Promise<void> {
    logger.error({ runId: run.id, reason }, 'Automation run failed');
    await withWorkspaceUpdate(run, {
      status: 'failed',
      completedAt: new Date(),
      resumeAt: null,
      waitingForEvent: null,
      failureReason: reason,
    });
  }

  /* -------------------------------------------------------------- resuming */

  /** Wake every run whose sleep, backoff or wait-timeout has come due. */
  async function resumeDueRuns(limit = 100): Promise<number> {
    const due = await withoutTenantScope(db, (tx) =>
      tx
        .select({
          id: schema.automationRuns.id,
          workspaceId: schema.automationRuns.workspaceId,
          waitingForEvent: schema.automationRuns.waitingForEvent,
          currentStepId: schema.automationRuns.currentStepId,
          context: schema.automationRuns.context,
        })
        .from(schema.automationRuns)
        .where(
          and(
            eq(schema.automationRuns.status, 'waiting'),
            lte(schema.automationRuns.resumeAt, new Date()),
          ),
        )
        .limit(limit),
    );

    let resumed = 0;
    for (const run of due) {
      // A wait-for-event whose resumeAt fired is a timeout: record it so a
      // branch can test `steps.<id>.timedOut`, then continue.
      const values: Partial<typeof schema.automationRuns.$inferInsert> = {
        status: 'running',
        waitingForEvent: null,
        resumeAt: null,
      };
      if (run.waitingForEvent && run.currentStepId) {
        const context = run.context as MutableContext;
        const stepState =
          ((context.steps as Record<string, unknown>)?.[run.currentStepId] as
            | Record<string, unknown>
            | undefined) ?? {};
        (context.steps as Record<string, unknown>)[run.currentStepId] = {
          ...stepState,
          timedOut: true,
        };
        values.context = context;
      }

      // The status predicate makes the wake a claim: when two instances race,
      // exactly one flips waiting → running and only it continues the run.
      const claimed = await withWorkspace(db, run.workspaceId, (tx) =>
        tx
          .update(schema.automationRuns)
          .set(values)
          .where(
            and(
              eq(schema.automationRuns.id, run.id),
              eq(schema.automationRuns.status, 'waiting'),
            ),
          )
          .returning({ id: schema.automationRuns.id }),
      );
      if (claimed.length === 0) continue;

      resumed += 1;
      await continueRun(run.id, run.workspaceId).catch((error: unknown) => {
        logger.error({ runId: run.id, err: String(error) }, 'Automation resume failed');
      });
    }

    return resumed;
  }

  /** Deliver an event to runs waiting for it, matched on the correlate path. */
  async function resumeWaitingForEvent(event: EngineEvent): Promise<void> {
    const waiting = await withWorkspace(db, event.workspaceId, (tx) =>
      tx
        .select({
          id: schema.automationRuns.id,
          workspaceId: schema.automationRuns.workspaceId,
          currentStepId: schema.automationRuns.currentStepId,
          context: schema.automationRuns.context,
        })
        .from(schema.automationRuns)
        .where(
          and(
            eq(schema.automationRuns.status, 'waiting'),
            eq(schema.automationRuns.waitingForEvent, event.name),
          ),
        )
        .limit(200),
    );

    const payload = event.payload as Record<string, unknown>;

    for (const run of waiting) {
      if (!run.currentStepId) continue;
      const context = run.context as MutableContext;
      const stepState = (context.steps as Record<string, unknown>)?.[run.currentStepId] as
        | { correlateOn?: string; correlateValue?: unknown }
        | undefined;

      const correlatePath = stepState?.correlateOn ?? 'contactId';
      const expected = stepState?.correlateValue ?? null;
      const actual = readPath(payload as RunContext, correlatePath) ?? null;

      // A snapshot with no value matches anything; with one, the event must
      // carry the same value — a different contact's reply must not wake this
      // run.
      if (expected !== null && expected !== actual) continue;

      (context.steps as Record<string, unknown>)[run.currentStepId] = {
        ...stepState,
        received: { name: event.name, payload: event.payload },
      };

      // Same claim shape as the timer resume: only the instance that flips
      // waiting → running gets to continue the run.
      const claimed = await withWorkspace(db, run.workspaceId, (tx) =>
        tx
          .update(schema.automationRuns)
          .set({ status: 'running', waitingForEvent: null, resumeAt: null, context })
          .where(
            and(
              eq(schema.automationRuns.id, run.id),
              eq(schema.automationRuns.status, 'waiting'),
            ),
          )
          .returning({ id: schema.automationRuns.id }),
      );
      if (claimed.length === 0) continue;

      await continueRun(run.id, run.workspaceId).catch((error: unknown) => {
        logger.error({ runId: run.id, err: String(error) }, 'Automation event resume failed');
      });
    }
  }

  /** Put a failed run back on its feet at the failed step, by hand. */
  async function retryRun(workspaceId: string, runId: string): Promise<boolean> {
    const run = await withWorkspace(db, workspaceId, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.automationRuns)
        .where(
          and(eq(schema.automationRuns.id, runId), eq(schema.automationRuns.status, 'failed')),
        )
        .limit(1);
      return row;
    });
    if (!run) return false;

    const context = run.context as MutableContext;
    // Re-run whichever step last failed; a run failed at its lifetime ceiling
    // resumes after its last completed step instead.
    const failedStep = await withWorkspace(db, workspaceId, async (tx) => {
      const [row] = await tx
        .select({ stepId: schema.automationRunSteps.stepId })
        .from(schema.automationRunSteps)
        .where(
          and(
            eq(schema.automationRunSteps.runId, runId),
            eq(schema.automationRunSteps.status, 'failed'),
          ),
        )
        .limit(1);
      return row;
    });
    if (failedStep) context._retryStepId = failedStep.stepId;

    await withWorkspaceUpdate(run, {
      status: 'running',
      failureReason: null,
      completedAt: null,
      context,
    });
    await continueRun(runId, workspaceId);
    return true;
  }

  return {
    enrollFromEvent,
    resumeDueRuns,
    resumeWaitingForEvent,
    retryRun,
    continueRun,
  };
}

export type AutomationEngine = ReturnType<typeof createAutomationEngine>;

/* ------------------------------------------------------------------ actions */

/** `{{path.into.context}}` interpolation for action config strings. */
export function renderContextTemplate(template: string, context: RunContext): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, path: string) => {
    const value = readPath(context, path);
    return value === undefined || value === null ? match : String(value);
  });
}

async function executeAction(
  deps: AutomationEngineDeps,
  run: RunRow,
  step: Extract<AutomationStep, { type: 'action' }>,
  context: RunContext,
): Promise<Record<string, unknown>> {
  const { db, email, whatsapp, config } = deps;
  const workspaceId = run.workspaceId;
  const stepConfig = step.config as Record<string, unknown>;
  const idempotencyKey = `auto:${run.id}:${step.id}`;

  switch (step.action) {
    case 'send_email': {
      const to =
        typeof stepConfig.to === 'string' && stepConfig.to.includes('@')
          ? stepConfig.to
          : (readPath(context, 'contact.email') as string | null);
      if (!to) throw new Error('The contact has no email address to send to.');

      const subject = renderContextTemplate(String(stepConfig.subject ?? ''), context);
      const body = renderContextTemplate(String(stepConfig.body ?? ''), context);
      if (!subject || !body) throw new Error('send_email needs a subject and a body.');

      const reserved = await reserveAutomationMessage(db, run, 'email', idempotencyKey, to, subject, body);
      if (!reserved) return { skipped: 'already sent' };

      try {
        const sent = await email.send({ to, subject, text: body });
        await markAutomationMessage(db, workspaceId, reserved, 'sent', sent.providerMessageId, null);
        return { sentTo: to, providerMessageId: sent.providerMessageId };
      } catch (error) {
        await markAutomationMessage(
          db,
          workspaceId,
          reserved,
          'failed',
          null,
          error instanceof Error ? error.message : 'send failed',
        );
        throw error;
      }
    }

    case 'send_whatsapp': {
      const to = readPath(context, 'contact.whatsapp') ?? readPath(context, 'contact.phone');
      if (typeof to !== 'string' || !to) {
        throw new Error('The contact has no WhatsApp number to send to.');
      }

      const templateSlug = String(stepConfig.templateSlug ?? '');
      if (!templateSlug) throw new Error('send_whatsapp needs a template.');

      const template = await withWorkspace(db, workspaceId, async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.messageTemplates)
          .where(
            and(
              eq(schema.messageTemplates.slug, templateSlug),
              eq(schema.messageTemplates.channel, 'whatsapp'),
              isNull(schema.messageTemplates.deletedAt),
            ),
          )
          .limit(1);
        return row;
      });
      if (!template) throw new Error(`WhatsApp template "${templateSlug}" does not exist.`);

      const variables = (Array.isArray(stepConfig.variables) ? stepConfig.variables : []).map(
        (variable) => renderContextTemplate(String(variable), context),
      );

      const body = renderContextTemplate(
        template.body.replace(/\{\{(\d+)\}\}/g, (match, index: string) => {
          return variables[Number(index) - 1] ?? match;
        }),
        context,
      );

      const reserved = await reserveAutomationMessage(
        db, run, 'whatsapp', idempotencyKey, to, null, body,
      );
      if (!reserved) return { skipped: 'already sent' };

      try {
        const sent = await whatsapp.send({
          to,
          template: template.providerTemplateId ?? template.slug,
          languageCode: template.locale === 'bn' ? 'bn' : 'en',
          variables,
        });
        await markAutomationMessage(db, workspaceId, reserved, 'sent', sent.providerMessageId, null);
        return { sentTo: to, providerMessageId: sent.providerMessageId };
      } catch (error) {
        await markAutomationMessage(
          db,
          workspaceId,
          reserved,
          'failed',
          null,
          error instanceof Error ? error.message : 'send failed',
        );
        throw error;
      }
    }

    case 'create_task': {
      const title = renderContextTemplate(String(stepConfig.title ?? ''), context);
      if (!title) throw new Error('create_task needs a title.');
      const dueInHours = Number(stepConfig.dueInHours ?? 0);
      const assignedToUserId =
        typeof stepConfig.assignedToUserId === 'string' && stepConfig.assignedToUserId
          ? stepConfig.assignedToUserId
          : ((readPath(context, 'lead.assignedToUserId') as string | null) ?? null);

      const taskId = await withWorkspace(db, workspaceId, async (tx) => {
        const [row] = await tx
          .insert(schema.tasks)
          .values({
            workspaceId,
            title: title.slice(0, 300),
            status: 'open',
            ...(dueInHours > 0
              ? { dueAt: new Date(Date.now() + dueInHours * 3600 * 1000) }
              : {}),
            assignedToUserId,
            entityType: run.entityType,
            entityId: run.entityId,
            createdByAutomationId: run.automationId,
          })
          .returning({ id: schema.tasks.id });
        return row!.id;
      });
      return { taskId };
    }

    case 'assign_user': {
      const userId = String(stepConfig.userId ?? '');
      if (!userId) throw new Error('assign_user needs a user.');
      const leadId = readPath(context, 'lead.id');
      if (typeof leadId !== 'string') throw new Error('assign_user needs a lead in context.');

      await withWorkspace(db, workspaceId, async (tx) => {
        await tx
          .update(schema.leads)
          .set({ assignedToUserId: userId, updatedAt: new Date() })
          .where(eq(schema.leads.id, leadId));
        await tx.insert(schema.activities).values({
          workspaceId,
          leadId,
          contactId: run.contactId,
          type: 'automation_assigned',
          summary: 'Assigned automatically',
          occurredAt: new Date(),
        });
      });
      return { assignedTo: userId };
    }

    case 'update_lead': {
      const leadId = readPath(context, 'lead.id');
      if (typeof leadId !== 'string') throw new Error('update_lead needs a lead in context.');
      const stageId = typeof stepConfig.stageId === 'string' ? stepConfig.stageId : undefined;
      const status = typeof stepConfig.status === 'string' ? stepConfig.status : undefined;
      if (!stageId && !status) throw new Error('update_lead needs a stage or a status.');

      await withWorkspace(db, workspaceId, (tx) =>
        tx
          .update(schema.leads)
          .set({
            ...(stageId ? { stageId, stageChangedAt: new Date() } : {}),
            ...(status ? { status: status as 'open' | 'won' | 'lost' | 'archived' } : {}),
            updatedAt: new Date(),
          })
          .where(eq(schema.leads.id, leadId)),
      );
      return { stageId: stageId ?? null, status: status ?? null };
    }

    case 'add_tag':
    case 'remove_tag': {
      const tagName = String(stepConfig.tag ?? '').trim();
      if (!tagName) throw new Error('The tag action needs a tag name.');
      if (!run.entityType || !run.entityId) throw new Error('The run has no entity to tag.');

      await withWorkspace(db, workspaceId, async (tx) => {
        const [existing] = await tx
          .select({ id: schema.tags.id })
          .from(schema.tags)
          .where(eq(schema.tags.name, tagName))
          .limit(1);

        let tagId = existing?.id;
        if (!tagId && step.action === 'add_tag') {
          const [created] = await tx
            .insert(schema.tags)
            .values({ workspaceId, name: tagName, slug: tagName.toLowerCase().replace(/\s+/g, '-') })
            .onConflictDoNothing()
            .returning({ id: schema.tags.id });
          tagId = created?.id;
        }
        if (!tagId) return;

        if (step.action === 'add_tag') {
          await tx
            .insert(schema.taggables)
            .values({
              workspaceId,
              tagId,
              entityType: run.entityType!,
              entityId: run.entityId!,
            })
            .onConflictDoNothing();
        } else {
          await tx
            .delete(schema.taggables)
            .where(
              and(
                eq(schema.taggables.tagId, tagId),
                eq(schema.taggables.entityType, run.entityType!),
                eq(schema.taggables.entityId, run.entityId!),
              ),
            );
        }
      });
      return { tag: tagName };
    }

    case 'call_webhook': {
      const url = String(stepConfig.url ?? '');
      if (!/^https:\/\//.test(url)) {
        throw new Error('call_webhook needs an https:// URL.');
      }

      const payload = JSON.stringify({
        runId: run.id,
        automationId: run.automationId,
        entityType: run.entityType,
        entityId: run.entityId,
        context: { event: context.event, contact: context.contact, lead: context.lead },
      });
      const secret = typeof stepConfig.secret === 'string' ? stepConfig.secret : '';
      const signature = secret
        ? createHmac('sha256', secret).update(payload).digest('hex')
        : undefined;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(signature ? { 'x-bos-signature': signature } : {}),
        },
        body: payload,
        signal: AbortSignal.timeout(15_000),
      });

      // The run step's own output row is the delivery record — status and
      // attempts live there, visible in run history.
      if (!response.ok) throw new Error(`The webhook answered ${response.status}.`);
      return { status: response.status, url };
    }

    case 'notify_admin': {
      const to = String(stepConfig.to ?? config.EMAIL_FROM_ADDRESS);
      const subject = renderContextTemplate(
        String(stepConfig.subject ?? 'Automation notification'),
        context,
      );
      const body = renderContextTemplate(String(stepConfig.body ?? ''), context);

      const reserved = await reserveAutomationMessage(db, run, 'email', idempotencyKey, to, subject, body);
      if (!reserved) return { skipped: 'already sent' };
      const sent = await email.send({ to, subject, text: body });
      await markAutomationMessage(db, workspaceId, reserved, 'sent', sent.providerMessageId, null);
      return { sentTo: to };
    }

    default:
      throw new Error(`The "${step.action}" action is not available yet.`);
  }
}

async function reserveAutomationMessage(
  db: Database,
  run: RunRow,
  channel: 'email' | 'whatsapp',
  idempotencyKey: string,
  to: string,
  subject: string | null,
  body: string,
): Promise<string | null> {
  return withWorkspace(db, run.workspaceId, async (tx) => {
    const [row] = await tx
      .insert(schema.messages)
      .values({
        workspaceId: run.workspaceId,
        contactId: run.contactId,
        leadId: run.entityType === 'lead' ? run.entityId : null,
        channel,
        direction: 'outbound',
        status: 'queued',
        toAddress: to,
        fromAddress: channel === 'email' ? 'automation' : 'whatsapp',
        subject,
        body,
        automationRunId: run.id,
        idempotencyKey,
      })
      .onConflictDoNothing({
        target: [schema.messages.workspaceId, schema.messages.idempotencyKey],
      })
      .returning({ id: schema.messages.id });
    return row?.id ?? null;
  });
}

async function markAutomationMessage(
  db: Database,
  workspaceId: string,
  messageId: string,
  status: 'sent' | 'failed',
  providerMessageId: string | null,
  failureReason: string | null,
): Promise<void> {
  await withWorkspace(db, workspaceId, (tx) =>
    tx
      .update(schema.messages)
      .set({
        status,
        providerMessageId,
        failureReason,
        sentAt: status === 'sent' ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(schema.messages.id, messageId)),
  );
}
