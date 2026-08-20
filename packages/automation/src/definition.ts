import { z } from 'zod';
import { EVENT_NAMES } from '@bos/events';
import { uuid } from '@bos/validation';

/**
 * The automation definition language.
 *
 * An automation is `trigger → [condition] → steps`. It is stored as data, not
 * code, so a non-developer can build one in the dashboard and so a running
 * instance can be resumed after a deploy — a JavaScript closure could do
 * neither.
 *
 * Definitions are versioned and immutable once a run references them: editing
 * an automation creates a new version, and in-flight runs finish on the
 * version they started with. Otherwise a mid-sequence edit silently changes
 * what a customer receives.
 */

export const TRIGGER_KINDS = ['event', 'schedule', 'manual', 'webhook'] as const;

export const triggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), event: z.enum(EVENT_NAMES) }),
  z.object({
    kind: z.literal('schedule'),
    /** Five-field cron, evaluated in the workspace's time zone. */
    cron: z.string().min(9).max(120),
  }),
  z.object({ kind: z.literal('manual') }),
  z.object({ kind: z.literal('webhook'), slug: z.string().min(1).max(140) }),
]);

export const COMPARATORS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'greater_than',
  'less_than',
  'is_set',
  'is_not_set',
  'in',
  'not_in',
] as const;

/** A single comparison against a JSON path into the run context. */
export const predicateSchema = z.object({
  /** Dot path, e.g. `event.payload.serviceSlug` or `contact.tags`. */
  path: z.string().min(1).max(200),
  comparator: z.enum(COMPARATORS),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
    .optional(),
});

export const conditionSchema = z.object({
  /** All predicates must hold for `all`; any one for `any`. */
  match: z.enum(['all', 'any']).default('all'),
  predicates: z.array(predicateSchema).min(1).max(20),
});

export const ACTION_TYPES = [
  'send_email',
  'send_sms',
  'send_whatsapp',
  'create_task',
  'assign_user',
  'update_lead',
  'add_tag',
  'remove_tag',
  'call_webhook',
  'generate_ai_content',
  'notify_admin',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

const actionStepSchema = z.object({
  id: uuid,
  type: z.literal('action'),
  action: z.enum(ACTION_TYPES),
  /** Action-specific config, validated by the executor's own schema. */
  config: z.record(z.string(), z.unknown()),
  /**
   * Retry policy for this step. Sending an email twice is worse than sending
   * it late, so the default is conservative and every action is expected to be
   * idempotent on the run's idempotency key.
   */
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).max(10).default(3),
      backoffSeconds: z.number().int().min(1).max(86_400).default(60),
    })
    .default({ maxAttempts: 3, backoffSeconds: 60 }),
});

const waitStepSchema = z.object({
  id: uuid,
  type: z.literal('wait'),
  /** A durable sleep — the run survives restarts and deploys while waiting. */
  seconds: z.number().int().min(1).max(31_536_000),
});

const waitForEventStepSchema = z.object({
  id: uuid,
  type: z.literal('wait_for_event'),
  event: z.enum(EVENT_NAMES),
  /** Only match events sharing this path's value with the run context. */
  correlateOn: z.string().min(1).max(200).default('contactId'),
  timeoutSeconds: z.number().int().min(60).max(31_536_000),
});

/**
 * Branching. `then` runs when the condition holds, `otherwise` when it does
 * not — which is how "no response after 2 hours?" is expressed without a
 * special-case step type.
 */
interface BranchStepShape {
  id: string;
  type: 'branch';
  condition: z.infer<typeof conditionSchema>;
  then: AutomationStep[];
  otherwise: AutomationStep[];
}

export type AutomationStep =
  | z.infer<typeof actionStepSchema>
  | z.infer<typeof waitStepSchema>
  | z.infer<typeof waitForEventStepSchema>
  | BranchStepShape;

export const automationStepSchema: z.ZodType<AutomationStep> = z.lazy(() =>
  z.discriminatedUnion('type', [
    actionStepSchema,
    waitStepSchema,
    waitForEventStepSchema,
    z.object({
      id: uuid,
      type: z.literal('branch'),
      condition: conditionSchema,
      then: z.array(automationStepSchema).max(50).default([]),
      otherwise: z.array(automationStepSchema).max(50).default([]),
    }),
  ]),
);

export const automationDefinitionSchema = z.object({
  id: uuid,
  workspaceId: uuid,
  version: z.number().int().min(1),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  enabled: z.boolean().default(false),
  trigger: triggerSchema,
  condition: conditionSchema.optional(),
  steps: z.array(automationStepSchema).min(1).max(100),
  /**
   * Stops one contact from being enrolled twice by a duplicate form
   * submission. Re-enrolment is opt-in, not the default.
   */
  reentry: z.enum(['once_per_contact', 'once_per_entity', 'always']).default('once_per_entity'),
  /** Hard ceiling on run duration; a run past this is failed and reported. */
  maxRunSeconds: z.number().int().min(60).max(31_536_000).default(2_592_000),
});

export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;
export type AutomationTrigger = z.infer<typeof triggerSchema>;
export type AutomationCondition = z.infer<typeof conditionSchema>;
export type Predicate = z.infer<typeof predicateSchema>;
