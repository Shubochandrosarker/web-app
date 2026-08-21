import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace } from '@bos/database';
import { attribution as attributionSchema, phoneE164 } from '@bos/validation';
import type { ResolvedFormField } from '@bos/content';
import { ApiError } from '../lib/errors.ts';
import { publicRoute } from '../lib/permissions.ts';
import { consumeRateLimit } from '../lib/redis.ts';
import { verifyTurnstile } from '../lib/turnstile.ts';
import type { AppContext } from '../app.ts';

/**
 * The public form endpoint.
 *
 * This is the only unauthenticated write path in the platform, so it carries
 * every defence the rest of the API gets from having a session behind it:
 *
 *  - the field set is the *stored form definition*, not what the client sends;
 *  - a honeypot field, which most bots fill in and no human sees;
 *  - a minimum fill time, because a bot posts in milliseconds;
 *  - Cloudflare Turnstile when configured;
 *  - per-address and per-form rate limits;
 *  - an idempotency key derived from the content, so a double-click is one
 *    lead rather than two.
 *
 * None of these is sufficient alone and the combination is not perfect either.
 * What matters is that a submission that gets through is still validated
 * against the stored definition before it becomes a row.
 */

const MAX_FIELD_LENGTH = 5_000;

const submissionBody = z.object({
  /** Arbitrary keys, validated below against the stored field definitions. */
  values: z.record(
    z.string().max(64),
    z.union([z.string().max(MAX_FIELD_LENGTH), z.boolean(), z.number()]),
  ),
  consent: z.boolean().default(false),
  attribution: attributionSchema.default({}),
  landingPath: z.string().max(2048).optional(),
  locale: z.string().min(2).max(10).default('en'),
  /** Milliseconds between the form rendering and the submission. */
  elapsedMs: z.number().int().nonnegative().max(86_400_000).optional(),
  turnstileToken: z.string().max(4096).optional(),
  /** Ids of documents already uploaded through the private upload endpoint. */
  documentIds: z.array(z.uuid()).max(5).default([]),
});

/** Bots fill everything in; a human never sees this field. */
const DEFAULT_HONEYPOT = 'company_website';
/** A human cannot read a form and complete it in under this many milliseconds. */
const MIN_FILL_MS = 2_000;

interface SpamAssessment {
  readonly score: number;
  readonly reasons: readonly string[];
}

/**
 * Score rather than reject outright.
 *
 * A hard rejection on a heuristic silently loses a real enquiry, and for a
 * business whose leads arrive one at a time that is a worse outcome than
 * storing a suspicious one for a human to glance at. Only a filled honeypot is
 * treated as certain.
 */
function assessSpam(
  values: Record<string, unknown>,
  honeypotField: string,
  elapsedMs: number | undefined,
): SpamAssessment {
  const reasons: string[] = [];
  let score = 0;

  const honeypotValue = values[honeypotField];
  if (typeof honeypotValue === 'string' && honeypotValue.trim().length > 0) {
    score += 100;
    reasons.push('honeypot filled');
  }

  if (elapsedMs !== undefined && elapsedMs < MIN_FILL_MS) {
    score += 40;
    reasons.push('submitted too quickly');
  }

  const text = Object.values(values)
    .filter((value): value is string => typeof value === 'string')
    .join(' ');

  // Link-stuffing is the signature of the comment-spam that finds every public
  // form eventually.
  const linkCount = (text.match(/https?:\/\//gi) ?? []).length;
  if (linkCount >= 3) {
    score += 30;
    reasons.push(`${linkCount} links`);
  }

  if (/\[url=|<a\s+href|bit\.ly\/|xn--/i.test(text)) {
    score += 20;
    reasons.push('link markup');
  }

  return { score, reasons };
}

/**
 * Build a validator from the stored field definitions.
 *
 * The client's payload does not decide which fields exist — the form
 * definition does. A field the definition does not mention is dropped rather
 * than stored, which is what stops a crafted request from writing arbitrary
 * keys into the submission payload.
 */
function validateAgainstDefinition(
  fields: readonly ResolvedFormField[],
  values: Record<string, string | boolean | number>,
): {
  clean: Record<string, string | boolean | number>;
  errors: { path: string; message: string }[];
} {
  const clean: Record<string, string | boolean | number> = {};
  const errors: { path: string; message: string }[] = [];

  for (const field of fields) {
    const raw = values[field.name];
    const missing = raw === undefined || raw === null || raw === '';

    if (missing) {
      if (field.required) errors.push({ path: field.name, message: `${field.label} is required` });
      continue;
    }

    switch (field.type) {
      case 'checkbox': {
        clean[field.name] = raw === true || raw === 'true';
        break;
      }
      case 'number': {
        const parsed = typeof raw === 'number' ? raw : Number(raw);
        if (Number.isNaN(parsed)) {
          errors.push({ path: field.name, message: `${field.label} must be a number` });
        } else {
          clean[field.name] = parsed;
        }
        break;
      }
      case 'email': {
        const parsed = z.email().max(320).safeParse(String(raw).trim().toLowerCase());
        if (!parsed.success) {
          errors.push({ path: field.name, message: `${field.label} must be an email address` });
        } else {
          clean[field.name] = parsed.data;
        }
        break;
      }
      case 'tel': {
        const normalised = normalisePhone(String(raw));
        if (!normalised) {
          errors.push({
            path: field.name,
            message: `${field.label} must be a phone number including the country code`,
          });
        } else {
          clean[field.name] = normalised;
        }
        break;
      }
      case 'select': {
        const allowed = field.options.map((option) => option.value);
        if (allowed.length > 0 && !allowed.includes(String(raw))) {
          errors.push({ path: field.name, message: `${field.label} is not one of the options` });
        } else {
          clean[field.name] = String(raw);
        }
        break;
      }
      default: {
        const text = String(raw).trim();
        const max = field.maxLength ?? MAX_FIELD_LENGTH;
        if (text.length > max) {
          errors.push({ path: field.name, message: `${field.label} is too long` });
        } else {
          clean[field.name] = text;
        }
      }
    }
  }

  return { clean, errors };
}

/**
 * Normalise a Bangladeshi or international number to E.164.
 *
 * Local habit is `01712345678`, and storing that alongside `+8801712345678`
 * would defeat the phone-based contact deduplication entirely. The `+880`
 * assumption is the tenant's country code and is applied only to a number that
 * looks like a local one.
 */
function normalisePhone(raw: string, defaultCountryCode = '+880'): string | null {
  const digits = raw.replace(/[^\d+]/g, '');

  if (digits.startsWith('+')) {
    return phoneE164.safeParse(digits).success ? digits : null;
  }
  if (digits.startsWith('00')) {
    const candidate = `+${digits.slice(2)}`;
    return phoneE164.safeParse(candidate).success ? candidate : null;
  }
  if (digits.startsWith('0')) {
    const candidate = `${defaultCountryCode}${digits.slice(1)}`;
    return phoneE164.safeParse(candidate).success ? candidate : null;
  }

  const candidate = `${defaultCountryCode}${digits}`;
  return phoneE164.safeParse(candidate).success ? candidate : null;
}

/**
 * The idempotency key.
 *
 * Derived from the form and the submitted values, so the same person clicking
 * submit twice produces the same key and therefore one lead — while a genuine
 * second enquiry, which differs in at least the message, produces a different
 * one. Deriving it from a timestamp or a fresh UUID would make every retry a
 * new lead, which is the bug this exists to prevent.
 */
function idempotencyKeyFor(
  formId: string,
  values: Record<string, string | boolean | number>,
): string {
  const canonical = Object.keys(values)
    .sort()
    .map((key) => `${key}=${String(values[key])}`)
    .join('&');
  return createHash('sha256').update(`${formId}|${canonical}`).digest('hex').slice(0, 48);
}

function pickField(
  values: Record<string, string | boolean | number>,
  candidates: readonly string[],
): string | null {
  for (const name of candidates) {
    const value = values[name];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function registerPublicFormRoutes(app: FastifyInstance, context: AppContext): void {
  const { db, redis, config, leads, resolveWorkspaceId } = context;

  app.post(
    '/v1/forms/:slug/submissions',
    {
      config: {
        bosAccess: publicRoute(
          'The visitor-facing service request. Protected by Turnstile, a honeypot, timing and rate limits rather than by a session.',
        ),
      },
    },
    async (request: FastifyRequest, reply) => {
      const params = z.object({ slug: z.string().min(1).max(140) }).parse(request.params);
      const query = z.object({ workspace: z.string().min(1).max(140) }).parse(request.query);
      const body = submissionBody.parse(request.body);

      /*
       * Rate limits before anything expensive. Two keys, because they answer
       * different questions: one address hammering the endpoint, and one form
       * receiving more submissions than a real business ever would.
       */
      const [byIp, byForm] = await Promise.all([
        consumeRateLimit(redis, `rl:form:ip:${request.clientIpPrefix}`, 10, 3600),
        consumeRateLimit(redis, `rl:form:slug:${query.workspace}:${params.slug}`, 300, 3600),
      ]);

      if (!byIp.allowed || !byForm.allowed) {
        return reply
          .status(429)
          .header('retry-after', String(Math.max(byIp.resetSeconds, byForm.resetSeconds)))
          .send({
            error: {
              code: 'too_many_requests',
              message: 'Too many submissions from this connection. Please try again later.',
            },
          });
      }

      const workspaceId = await resolveWorkspaceId(query.workspace);

      const form = await withWorkspace(db, workspaceId, async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.forms)
          .where(
            and(
              eq(schema.forms.slug, params.slug),
              eq(schema.forms.enabled, true),
              isNull(schema.forms.deletedAt),
            ),
          )
          .limit(1);
        return row;
      });

      if (!form) throw ApiError.notFound('Form');

      const definition = (form.fields as ResolvedFormField[] | null) ?? [];
      const spamConfig =
        (form.spamConfig as { honeypotField?: string; minFillMs?: number } | null) ?? {};
      const honeypotField = spamConfig.honeypotField ?? DEFAULT_HONEYPOT;

      const spam = assessSpam(body.values, honeypotField, body.elapsedMs);

      /*
       * A filled honeypot is the one signal treated as certain. The response
       * is the ordinary success response — telling a bot it was detected only
       * teaches whoever wrote it which field to leave alone next time.
       */
      if (spam.score >= 100) {
        request.log.info(
          { form: params.slug, reasons: spam.reasons },
          'Discarded a submission that filled the honeypot',
        );
        return reply.status(201).send({
          status: 'received',
          message: form.successMessage ?? 'Thank you — we have your request.',
        });
      }

      if (config.TURNSTILE_SECRET_KEY) {
        const verdict = await verifyTurnstile(
          config.TURNSTILE_SECRET_KEY,
          body.turnstileToken ?? '',
          request.ip,
          config.TURNSTILE_VERIFY_URL,
        );
        if (!verdict.success) {
          throw ApiError.badRequest(
            'We could not verify that you are human. Please reload the page and try again.',
            { reason: verdict.reason },
          );
        }
      }

      if (form.requiresConsent && !body.consent) {
        throw ApiError.badRequest('Please agree to be contacted before submitting.');
      }

      const { clean, errors } = validateAgainstDefinition(definition, body.values);
      if (errors.length > 0) {
        throw new ApiError(
          422,
          'validation_failed',
          'Please check the highlighted fields.',
          errors,
        );
      }

      const fullName = pickField(clean, ['name', 'full_name', 'fullName']) ?? 'Website enquiry';
      const email = pickField(clean, ['email']);
      const phone = pickField(clean, ['phone', 'telephone', 'mobile']);
      const whatsapp = pickField(clean, ['whatsapp', 'whatsapp_number']);
      const message = pickField(clean, ['message', 'details', 'notes']);

      if (!email && !phone && !whatsapp) {
        throw new ApiError(422, 'validation_failed', 'Please give us a way to reach you.', [
          { path: 'phone', message: 'A phone number or an email address is required' },
        ]);
      }

      // The service is resolved from the stored catalogue, never taken as an
      // id from the client — otherwise the form is an oracle for which service
      // ids exist.
      const serviceId = await resolveServiceId(context, workspaceId, clean, form.outcomeConfig);

      const result = await leads.captureLead({
        workspaceId,
        formId: form.id,
        fullName,
        email,
        phone: phone ?? whatsapp,
        whatsapp: whatsapp ?? phone,
        serviceId,
        message,
        payload: clean,
        attribution: body.attribution,
        landingPath: body.landingPath ?? null,
        locale: body.locale,
        consentGiven: body.consent,
        ipPrefix: request.clientIpPrefix,
        userAgent: request.headers['user-agent'] ?? '',
        spamScore: spam.score,
        idempotencyKey: idempotencyKeyFor(form.id, clean),
      });

      // Attach any documents the visitor uploaded before submitting. Done
      // after the lead exists so an abandoned upload never has a lead to point
      // at — the retention sweep collects those.
      if (body.documentIds.length > 0) {
        await attachDocuments(context, workspaceId, body.documentIds, result);
      }

      return reply.status(201).send({
        status: 'received',
        message: form.successMessage ?? 'Thank you — we have your request.',
        // The reference is the submission id, which is meaningless outside the
        // workspace. The lead id is not returned: a public caller has no
        // business holding an id that addresses a CRM record.
        reference: result.submissionId.slice(0, 8),
      });
    },
  );
}

async function resolveServiceId(
  context: AppContext,
  workspaceId: string,
  values: Record<string, string | boolean | number>,
  outcomeConfig: unknown,
): Promise<string | null> {
  const configured = (outcomeConfig as { serviceId?: string } | null)?.serviceId;
  if (typeof configured === 'string') return configured;

  const slug = pickField(values, ['service', 'service_slug', 'requested_service']);
  if (!slug) return null;

  return withWorkspace(context.db, workspaceId, async (tx) => {
    const [row] = await tx
      .select({ id: schema.services.id })
      .from(schema.services)
      .where(and(eq(schema.services.slug, slug), isNull(schema.services.deletedAt)))
      .limit(1);
    return row?.id ?? null;
  });
}

async function attachDocuments(
  context: AppContext,
  workspaceId: string,
  documentIds: readonly string[],
  result: { leadId: string; contactId: string },
): Promise<void> {
  await withWorkspace(context.db, workspaceId, async (tx) => {
    for (const documentId of documentIds) {
      await tx
        .update(schema.documents)
        .set({ leadId: result.leadId, contactId: result.contactId })
        .where(
          and(
            eq(schema.documents.id, documentId),
            // Only an unattached document may be claimed. Without this, a
            // crafted submission could attach somebody else's transcript to
            // its own lead and then read it from the dashboard.
            isNull(schema.documents.leadId),
          ),
        );
    }
  });
}
