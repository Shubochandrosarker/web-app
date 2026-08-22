import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { schema, withWorkspace, type Database } from '@bos/database';
import type { Attribution } from '@bos/validation';
import { ApiError } from '../lib/errors.ts';
import { appendOutboxEvent } from '../lib/outbox.ts';
import { claimOnce, type RedisClient } from '../lib/redis.ts';
import type { ApiConfig } from '../lib/env.ts';

/**
 * Lead capture.
 *
 * This is the transaction the whole vertical slice exists for, and its shape
 * is the point:
 *
 *     BEGIN
 *       upsert contact
 *       insert lead
 *       insert activity
 *       insert form_submission
 *       insert outbox event  ← in the same transaction
 *     COMMIT
 *
 * Nothing is sent from inside it. The confirmation email and the WhatsApp
 * acknowledgement are consequences of the outbox row, dispatched afterwards,
 * so a slow email provider cannot make a visitor's form submission time out
 * and a rolled-back transaction cannot send a confirmation for a lead that
 * does not exist.
 */

export interface CaptureLeadInput {
  readonly workspaceId: string;
  readonly formId: string | null;
  readonly fullName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly whatsapp: string | null;
  readonly serviceId: string | null;
  readonly message: string | null;
  /** Everything the form collected, exactly as validated. */
  readonly payload: Record<string, unknown>;
  readonly attribution: Attribution;
  readonly landingPath: string | null;
  readonly locale: string;
  readonly consentGiven: boolean;
  readonly ipPrefix: string;
  readonly userAgent: string;
  readonly spamScore: number;
  /**
   * Stable per logical submission.
   *
   * Derived from the form and the submitted values so a double-click, a retry
   * after a flaky connection and a duplicated queue delivery all produce the
   * same key — and therefore one lead.
   */
  readonly idempotencyKey: string;
}

export interface CaptureLeadResult {
  readonly leadId: string;
  readonly contactId: string;
  readonly submissionId: string;
  /** False when this submission was recognised as a repeat of an earlier one. */
  readonly created: boolean;
}

export interface LeadServiceDependencies {
  readonly db: Database;
  readonly redis: RedisClient;
  readonly config: ApiConfig;
}

export function createLeadService({ db, redis, config }: LeadServiceDependencies) {
  return {
    captureLead: (input: CaptureLeadInput) => captureLead(db, redis, input),
    listPipelines: (workspaceId: string) => listPipelines(db, workspaceId),
    config,
  };
}

/**
 * Deduplicate at two levels.
 *
 * Redis catches the fast repeat — the double-click, the retried fetch — within
 * seconds and without touching Postgres. The unique index on the outbox's
 * idempotency key catches everything else, including a repeat that arrives
 * after the Redis key expired. Neither alone is enough: Redis can be flushed,
 * and reaching Postgres on every bot submission is what the first layer is
 * for.
 */
const DEDUPE_WINDOW_SECONDS = 900;

async function captureLead(
  db: Database,
  redis: RedisClient,
  input: CaptureLeadInput,
): Promise<CaptureLeadResult> {
  const dedupeKey = `lead:dedupe:${input.workspaceId}:${input.idempotencyKey}`;
  const first = await claimOnce(redis, dedupeKey, DEDUPE_WINDOW_SECONDS).catch(() => true);

  if (!first) {
    const existing = await findExistingSubmission(db, input.workspaceId, input.idempotencyKey);
    if (existing) return { ...existing, created: false };
    // The claim was taken but no row exists yet — an in-flight duplicate. Tell
    // the caller to try again rather than racing it into a second lead.
    throw ApiError.conflict('That submission is already being processed.');
  }

  const correlationId = randomUUID();

  return withWorkspace(db, input.workspaceId, async (tx) => {
    const contactId = await upsertContact(tx, input);

    const pipeline = await defaultPipeline(tx, input.workspaceId);

    const [lead] = await tx
      .insert(schema.leads)
      .values({
        workspaceId: input.workspaceId,
        contactId,
        ...(pipeline ? { pipelineId: pipeline.pipelineId, stageId: pipeline.firstStageId } : {}),
        ...(input.serviceId ? { serviceId: input.serviceId } : {}),
        status: 'open',
        title: input.message?.slice(0, 300) ?? `Enquiry from ${input.fullName}`.slice(0, 300),
        source: 'website_form',
        attribution: input.attribution,
        landingPath: input.landingPath,
        customFields: {},
      })
      .returning({ id: schema.leads.id });

    const leadId = lead!.id;

    const [submission] = await tx
      .insert(schema.formSubmissions)
      .values({
        workspaceId: input.workspaceId,
        formId: input.formId ?? '',
        contactId,
        leadId,
        payload: input.payload,
        attribution: input.attribution,
        landingPath: input.landingPath,
        ipPrefix: input.ipPrefix,
        userAgent: input.userAgent.slice(0, 1000),
        spamScore: input.spamScore,
        isSpam: false,
        consentGivenAt: input.consentGiven ? new Date() : null,
      })
      .returning({ id: schema.formSubmissions.id });

    await tx.insert(schema.activities).values({
      workspaceId: input.workspaceId,
      contactId,
      leadId,
      type: 'lead.created',
      summary: `Service request submitted${input.serviceId ? '' : ''} by ${input.fullName}`.slice(
        0,
        500,
      ),
      // The activity records *that* a request arrived and what it was about.
      // The submitted values live on the submission row, which is reachable
      // from the lead and governed by `forms.submissions.read`.
      detail: {
        submissionId: submission!.id,
        landingPath: input.landingPath,
        channel: input.attribution.lastTouch?.channel ?? 'direct',
      },
    });

    // Attribution as a first-class row, so a conversion can later be credited
    // under first-touch, last-touch or linear without recomputing from
    // sessions.
    const touches = [
      { touch: input.attribution.firstTouch, isFirst: true },
      { touch: input.attribution.lastTouch, isFirst: false },
    ].filter((entry) => entry.touch !== undefined);

    for (const [index, entry] of touches.entries()) {
      await tx.insert(schema.attributionTouches).values({
        workspaceId: input.workspaceId,
        contactId,
        leadId,
        position: index,
        isFirstTouch: entry.isFirst,
        isLastTouch: !entry.isFirst || touches.length === 1,
        channel: entry.touch!.channel.slice(0, 40),
        ...(entry.touch!.utm.source ? { sourceKey: entry.touch!.utm.source.slice(0, 64) } : {}),
        landingPath: entry.touch!.landingPath,
        occurredAt: new Date(entry.touch!.occurredAt),
      });
    }

    /*
     * The event, in the same transaction. This is the line that makes "a lead
     * is never created without its event, and an event never fires for a lead
     * that failed to save" true rather than aspirational.
     */
    await appendOutboxEvent(tx, input.workspaceId, {
      name: 'lead.created',
      correlationId,
      idempotencyKey: `lead.created:${input.idempotencyKey}`,
      payload: {
        leadId,
        contactId,
        // The catalog documents `source` on lead.created; automations branch
        // on it. It mirrors the lead row's source.
        source: 'website_form',
        submissionId: submission!.id,
        formId: input.formId,
        serviceId: input.serviceId,
        fullName: input.fullName,
        email: input.email,
        phone: input.phone,
        whatsapp: input.whatsapp,
        locale: input.locale,
        landingPath: input.landingPath,
      },
    });

    return { leadId, contactId, submissionId: submission!.id, created: true };
  });
}

/**
 * Find or create the person behind the enquiry.
 *
 * A contact is a person and a lead is one enquiry, so somebody asking about a
 * transcript in March and a certificate in July is one contact with two leads.
 * Matching is on email first, then phone — both are unique per workspace by a
 * partial index, which is what makes the upsert safe under concurrency rather
 * than a check-then-insert race.
 */
async function upsertContact(tx: Database, input: CaptureLeadInput): Promise<string> {
  const conditions = [];
  if (input.email) conditions.push(eq(schema.contacts.email, input.email));
  if (input.phone) conditions.push(eq(schema.contacts.phone, input.phone));

  if (conditions.length > 0) {
    const [existing] = await tx
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(
        and(
          isNull(schema.contacts.deletedAt),
          conditions.length === 1 ? conditions[0] : sql`(${conditions[0]} OR ${conditions[1]})`,
        ),
      )
      .limit(1);

    if (existing) {
      await tx
        .update(schema.contacts)
        .set({
          // Fill gaps, never overwrite. Someone who first gave only a phone
          // number and now gives an email should gain the email; someone who
          // typos their name on a second form should not lose the first one.
          ...(input.fullName ? { fullName: input.fullName.slice(0, 200) } : {}),
          ...(input.whatsapp ? { whatsapp: input.whatsapp } : {}),
          lastActivityAt: new Date(),
          ...(input.consentGiven ? { marketingConsentAt: new Date() } : {}),
        })
        .where(eq(schema.contacts.id, existing.id));
      return existing.id;
    }
  }

  const [created] = await tx
    .insert(schema.contacts)
    .values({
      workspaceId: input.workspaceId,
      fullName: input.fullName.slice(0, 200),
      email: input.email,
      phone: input.phone,
      whatsapp: input.whatsapp,
      locale: input.locale,
      attribution: input.attribution,
      lastActivityAt: new Date(),
      marketingConsentAt: input.consentGiven ? new Date() : null,
    })
    .returning({ id: schema.contacts.id });

  return created!.id;
}

async function defaultPipeline(
  tx: Database,
  workspaceId: string,
): Promise<{ pipelineId: string; firstStageId: string } | null> {
  const [pipeline] = await tx
    .select({ id: schema.pipelines.id })
    .from(schema.pipelines)
    .where(and(eq(schema.pipelines.workspaceId, workspaceId), eq(schema.pipelines.isDefault, true)))
    .limit(1);

  if (!pipeline) return null;

  const [stage] = await tx
    .select({ id: schema.pipelineStages.id })
    .from(schema.pipelineStages)
    .where(eq(schema.pipelineStages.pipelineId, pipeline.id))
    .orderBy(asc(schema.pipelineStages.position))
    .limit(1);

  return stage ? { pipelineId: pipeline.id, firstStageId: stage.id } : null;
}

/** Resolve a repeat submission back to the lead it originally created. */
async function findExistingSubmission(
  db: Database,
  workspaceId: string,
  idempotencyKey: string,
): Promise<{ leadId: string; contactId: string; submissionId: string } | null> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const [event] = await tx
      .select({ payload: schema.eventOutbox.payload })
      .from(schema.eventOutbox)
      .where(eq(schema.eventOutbox.idempotencyKey, `lead.created:${idempotencyKey}`))
      .limit(1);

    if (!event) return null;

    const payload = event.payload as {
      leadId?: string;
      contactId?: string;
      submissionId?: string;
    };
    if (!payload.leadId || !payload.contactId || !payload.submissionId) return null;

    return {
      leadId: payload.leadId,
      contactId: payload.contactId,
      submissionId: payload.submissionId,
    };
  });
}

export async function listPipelines(db: Database, workspaceId: string) {
  return withWorkspace(db, workspaceId, async (tx) => {
    const pipelines = await tx
      .select()
      .from(schema.pipelines)
      .where(eq(schema.pipelines.workspaceId, workspaceId))
      .orderBy(asc(schema.pipelines.name));

    const stages = await tx
      .select()
      .from(schema.pipelineStages)
      .where(eq(schema.pipelineStages.workspaceId, workspaceId))
      .orderBy(asc(schema.pipelineStages.position));

    return pipelines.map((pipeline) => ({
      id: pipeline.id,
      slug: pipeline.slug,
      name: pipeline.name,
      isDefault: pipeline.isDefault,
      stages: stages
        .filter((stage) => stage.pipelineId === pipeline.id)
        .map((stage) => ({
          id: stage.id,
          slug: stage.slug,
          name: stage.name,
          position: stage.position,
          isWon: stage.isWon,
          isLost: stage.isLost,
        })),
    }));
  });
}
