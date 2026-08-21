import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace } from '@bos/database';
import { ApiError } from '../lib/errors.ts';
import { requirePermission } from '../lib/permissions.ts';
import { requestContext, requireUserId, requireWorkspace } from '../lib/context.ts';
import type { AppContext } from '../app.ts';

/**
 * The form builder's API.
 *
 * The stored definition is the authority for everything the public endpoint
 * later does: which fields exist, which are required, what a select allows.
 * So the write path here is strict — a definition that could not be safely
 * rendered and validated is refused at save time, not discovered when a
 * visitor's submission fails.
 *
 * A field's `name` becomes a key in submission payloads and a column of the
 * CRM's dedup logic, so it is machine-shaped by force: lowercase, starts with
 * a letter, no spaces. Labels are for people; names are for the machine.
 */

const fieldName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, 'must be lowercase letters, digits and underscores');

const formFieldSchema = z
  .object({
    name: fieldName,
    label: z.string().min(1).max(200),
    type: z.enum([
      'text',
      'email',
      'tel',
      'textarea',
      'select',
      'checkbox',
      'number',
      'date',
      'file',
    ]),
    required: z.boolean().default(false),
    placeholder: z.string().max(200).optional(),
    helpText: z.string().max(500).optional(),
    options: z
      .array(z.object({ value: z.string().min(1).max(140), label: z.string().min(1).max(200) }))
      .max(50)
      .default([]),
    optionsSource: z.enum(['services']).optional(),
    maxLength: z.number().int().positive().max(10_000).optional(),
    accept: z.array(z.string().max(140)).max(10).default([]),
    autocomplete: z.string().max(64).optional(),
  })
  .strict();

const formInput = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,139}$/, 'must be lowercase letters, digits and hyphens'),
  name: z.string().min(1).max(200),
  fields: z.array(formFieldSchema).min(1).max(40),
  submitLabel: z.string().min(1).max(100).default('Submit'),
  successMessage: z.string().max(2000).optional(),
  outcomeConfig: z
    .object({
      serviceId: z.uuid().optional(),
      pipelineId: z.uuid().optional(),
      stageId: z.uuid().optional(),
    })
    .strict()
    .default({}),
  notifyEmails: z.array(z.email()).max(10).default([]),
  spamConfig: z
    .object({
      honeypotField: fieldName.optional(),
      minFillMs: z.number().int().min(0).max(60_000).optional(),
    })
    .strict()
    .default({}),
  requiresConsent: z.boolean().default(true),
  consentText: z.string().max(2000).optional(),
  enabled: z.boolean().default(true),
});

const formUpdateInput = formInput.partial();

/**
 * What every valid definition must satisfy beyond field-level shape.
 *
 * These are the invariants the CRM depends on: a submission must be able to
 * carry a way to reach the person, names must be unique (two fields writing
 * one key would silently drop one), a select needs options unless the
 * catalogue fills them, and the honeypot must not collide with a real field.
 */
function assertDefinitionInvariants(
  fields: z.infer<typeof formFieldSchema>[],
  spamConfig: { honeypotField?: string | undefined },
): void {
  const names = fields.map((field) => field.name);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) {
    throw ApiError.badRequest(`Field names must be unique. Duplicated: ${duplicates.join(', ')}`);
  }

  const hasContactField = fields.some((field) => field.type === 'email' || field.type === 'tel');
  if (!hasContactField) {
    throw ApiError.badRequest(
      'The form needs at least one email or phone field, or the business cannot reply to anybody.',
    );
  }

  for (const field of fields) {
    if (field.type === 'select' && field.options.length === 0 && !field.optionsSource) {
      throw ApiError.badRequest(
        `"${field.label}" is a choice field with nothing to choose. Add options or set the source to the service catalogue.`,
      );
    }
  }

  if (spamConfig.honeypotField && names.includes(spamConfig.honeypotField)) {
    throw ApiError.badRequest(
      'The honeypot field name must not collide with a real field — bots would be indistinguishable from people.',
    );
  }
}

export function registerFormAdminRoutes(app: FastifyInstance, context: AppContext): void {
  const { db } = context;

  app.get(
    '/v1/cms/forms/:id',
    { config: { bosAccess: requirePermission('forms.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);

      const row = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [form] = await tx
          .select()
          .from(schema.forms)
          .where(and(eq(schema.forms.id, id), isNull(schema.forms.deletedAt)))
          .limit(1);
        return form;
      });
      if (!row) throw ApiError.hidden('Form');

      return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        fields: row.fields,
        submitLabel: row.submitLabel,
        successMessage: row.successMessage,
        outcome: row.outcome,
        outcomeConfig: row.outcomeConfig,
        notifyEmails: row.notifyEmails,
        spamConfig: row.spamConfig,
        requiresConsent: row.requiresConsent,
        consentText: row.consentText,
        enabled: row.enabled,
        updatedAt: row.updatedAt.toISOString(),
      };
    },
  );

  app.post(
    '/v1/cms/forms',
    { config: { bosAccess: requirePermission('forms.write') } },
    async (request, reply) => {
      const workspace = requireWorkspace(request);
      const input = formInput.parse(request.body);
      assertDefinitionInvariants(input.fields, input.spamConfig);

      const created = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [row] = await tx
          .insert(schema.forms)
          .values({
            workspaceId: workspace.workspaceId,
            slug: input.slug,
            name: input.name,
            fields: input.fields,
            submitLabel: input.submitLabel,
            successMessage: input.successMessage ?? null,
            outcome: 'lead',
            outcomeConfig: input.outcomeConfig,
            notifyEmails: input.notifyEmails,
            spamConfig: input.spamConfig,
            requiresConsent: input.requiresConsent,
            consentText: input.consentText ?? null,
            enabled: input.enabled,
          })
          .returning({ id: schema.forms.id });
        return row!.id;
      }).catch((error: unknown) => {
        if ((error as { cause?: { code?: string } }).cause?.code === '23505') {
          throw ApiError.conflict('Another form already uses that slug.');
        }
        throw error;
      });

      await context.auth.audit(
        workspace.workspaceId,
        requireUserId(request),
        'form.created',
        requestContext(request),
        { formId: created, slug: input.slug },
      );

      return reply.status(201).send({ id: created });
    },
  );

  app.patch(
    '/v1/cms/forms/:id',
    { config: { bosAccess: requirePermission('forms.write') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const input = formUpdateInput.parse(request.body);

      if (input.fields) {
        assertDefinitionInvariants(input.fields, input.spamConfig ?? {});
      }

      const updated = await withWorkspace(db, workspace.workspaceId, async (tx) => {
        const [existing] = await tx
          .select({ id: schema.forms.id, fields: schema.forms.fields })
          .from(schema.forms)
          .where(and(eq(schema.forms.id, id), isNull(schema.forms.deletedAt)))
          .limit(1);
        if (!existing) throw ApiError.hidden('Form');

        // A spam-config change against unchanged fields still needs the
        // collision check, against the *stored* fields.
        if (!input.fields && input.spamConfig?.honeypotField) {
          const storedNames = (existing.fields as { name: string }[]).map((field) => field.name);
          if (storedNames.includes(input.spamConfig.honeypotField)) {
            throw ApiError.badRequest(
              'The honeypot field name must not collide with a real field.',
            );
          }
        }

        await tx
          .update(schema.forms)
          .set({
            ...(input.slug ? { slug: input.slug } : {}),
            ...(input.name ? { name: input.name } : {}),
            ...(input.fields ? { fields: input.fields } : {}),
            ...(input.submitLabel ? { submitLabel: input.submitLabel } : {}),
            ...(input.successMessage !== undefined
              ? { successMessage: input.successMessage ?? null }
              : {}),
            ...(input.outcomeConfig ? { outcomeConfig: input.outcomeConfig } : {}),
            ...(input.notifyEmails ? { notifyEmails: input.notifyEmails } : {}),
            ...(input.spamConfig ? { spamConfig: input.spamConfig } : {}),
            ...(input.requiresConsent !== undefined
              ? { requiresConsent: input.requiresConsent }
              : {}),
            ...(input.consentText !== undefined ? { consentText: input.consentText ?? null } : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            updatedAt: new Date(),
          })
          .where(eq(schema.forms.id, id));

        return true;
      }).catch((error: unknown) => {
        if ((error as { cause?: { code?: string } }).cause?.code === '23505') {
          throw ApiError.conflict('Another form already uses that slug.');
        }
        throw error;
      });
      void updated;

      await context.auth.audit(
        workspace.workspaceId,
        requireUserId(request),
        'form.updated',
        requestContext(request),
        { formId: id },
      );

      return { id };
    },
  );
}
