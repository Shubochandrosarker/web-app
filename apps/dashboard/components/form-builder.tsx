'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { saveForm, type ActionResult } from '@/lib/actions';

/**
 * The form builder.
 *
 * Editors decide what the form asks and how a submission is handled; they do
 * not decide validation semantics — the server's stored definition is what
 * the public endpoint enforces, and this screen is how that definition is
 * written. The invariants the API refuses to store without (a way to contact
 * the person, unique names, options on selects) are surfaced here as they
 * come back, with field names attached.
 */

export interface FormField {
  name: string;
  label: string;
  type: string;
  required: boolean;
  placeholder?: string | undefined;
  helpText?: string | undefined;
  options: { value: string; label: string }[];
  optionsSource?: 'services' | undefined;
  maxLength?: number | undefined;
  accept: string[];
}

export interface FormDefinition {
  slug: string;
  name: string;
  fields: FormField[];
  submitLabel: string;
  successMessage: string;
  outcomeConfig: { serviceId?: string };
  notifyEmails: string[];
  spamConfig: { honeypotField?: string; minFillMs?: number };
  requiresConsent: boolean;
  consentText: string;
  enabled: boolean;
}

const FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'email', label: 'Email address' },
  { value: 'tel', label: 'Phone number' },
  { value: 'textarea', label: 'Long text' },
  { value: 'select', label: 'Choice' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'file', label: 'Document upload' },
];

function nameFromLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s_]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/^[^a-z]+/, '')
    .slice(0, 64);
}

export function FormBuilder({
  formId,
  initial,
  services,
  canWrite,
}: {
  readonly formId: string | null;
  readonly initial: FormDefinition;
  readonly services: readonly { id: string; label: string }[];
  readonly canWrite: boolean;
}) {
  const router = useRouter();
  const [definition, setDefinition] = useState<FormDefinition>(initial);
  const [openField, setOpenField] = useState<number | null>(null);
  const [result, setResult] = useState<ActionResult>({ ok: true });
  const [pending, startTransition] = useTransition();

  const update = (patch: Partial<FormDefinition>): void =>
    setDefinition((current) => ({ ...current, ...patch }));

  const updateField = (index: number, patch: Partial<FormField>): void => {
    update({
      fields: definition.fields.map((field, position) =>
        position === index ? { ...field, ...patch } : field,
      ),
    });
  };

  const moveField = (index: number, direction: -1 | 1): void => {
    const target = index + direction;
    if (target < 0 || target >= definition.fields.length) return;
    const fields = [...definition.fields];
    const [moved] = fields.splice(index, 1);
    if (moved) fields.splice(target, 0, moved);
    update({ fields });
  };

  const addField = (): void => {
    update({
      fields: [
        ...definition.fields,
        { name: '', label: '', type: 'text', required: false, options: [], accept: [] },
      ],
    });
    setOpenField(definition.fields.length);
  };

  const save = (): void => {
    startTransition(async () => {
      const body = {
        slug: definition.slug,
        name: definition.name,
        fields: definition.fields.map((field) => ({
          ...field,
          name: field.name || nameFromLabel(field.label),
          placeholder: field.placeholder || undefined,
          helpText: field.helpText || undefined,
          optionsSource: field.optionsSource || undefined,
        })),
        submitLabel: definition.submitLabel || 'Submit',
        successMessage: definition.successMessage || undefined,
        outcomeConfig: definition.outcomeConfig.serviceId
          ? { serviceId: definition.outcomeConfig.serviceId }
          : {},
        notifyEmails: definition.notifyEmails.filter(Boolean),
        spamConfig: definition.spamConfig,
        requiresConsent: definition.requiresConsent,
        consentText: definition.consentText || undefined,
        enabled: definition.enabled,
      };
      const saved = await saveForm(formId, body);
      setResult(saved);
      if (saved.ok && !formId && saved.id) router.push(`/forms/${saved.id}`);
    });
  };

  return (
    <div className="content-editor">
      {result.message ? (
        <p
          className={result.ok ? 'form-success' : 'form-error'}
          role={result.ok ? 'status' : 'alert'}
        >
          {result.message}
        </p>
      ) : null}

      <section className="panel">
        <h2>Form</h2>
        <div className="field">
          <label htmlFor="form-name">Name</label>
          <input
            id="form-name"
            value={definition.name}
            maxLength={200}
            disabled={!canWrite}
            onChange={(event) => update({ name: event.currentTarget.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="form-slug">Slug</label>
          <input
            id="form-slug"
            value={definition.slug}
            maxLength={140}
            disabled={!canWrite}
            onChange={(event) =>
              update({ slug: event.currentTarget.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })
            }
          />
          <p className="field-help">Part of the submission address; changing it breaks embeds.</p>
        </div>
        <div className="field field--checkbox">
          <label htmlFor="form-enabled">
            <input
              id="form-enabled"
              type="checkbox"
              checked={definition.enabled}
              disabled={!canWrite}
              onChange={(event) => update({ enabled: event.currentTarget.checked })}
            />
            <span>Accepting submissions</span>
          </label>
        </div>
      </section>

      <section className="panel">
        <h2>Fields</h2>
        <ol className="section-editor">
          {definition.fields.map((field, index) => (
            <li key={index} className="section-item">
              <header>
                <button
                  type="button"
                  className="section-title"
                  aria-expanded={openField === index}
                  onClick={() => setOpenField(openField === index ? null : index)}
                >
                  <strong>{field.label || 'Untitled field'}</strong>
                  <span className="muted">
                    {' '}
                    · {FIELD_TYPES.find((entry) => entry.value === field.type)?.label ?? field.type}
                    {field.required ? ' · required' : ''}
                  </span>
                </button>
                {canWrite ? (
                  <span className="section-actions">
                    <button
                      type="button"
                      className="link-button"
                      disabled={index === 0}
                      onClick={() => moveField(index, -1)}
                      aria-label={`Move ${field.label || 'field'} up`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      disabled={index === definition.fields.length - 1}
                      onClick={() => moveField(index, 1)}
                      aria-label={`Move ${field.label || 'field'} down`}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="link-button link-button--danger"
                      onClick={() =>
                        update({
                          fields: definition.fields.filter((_, position) => position !== index),
                        })
                      }
                    >
                      Remove
                    </button>
                  </span>
                ) : null}
              </header>

              {openField === index ? (
                <div className="section-form">
                  <div className="field">
                    <label htmlFor={`field-label-${index}`}>Label</label>
                    <input
                      id={`field-label-${index}`}
                      value={field.label}
                      maxLength={200}
                      disabled={!canWrite}
                      onChange={(event) => {
                        const label = event.currentTarget.value;
                        updateField(index, {
                          label,
                          // Derive the machine name until somebody edits it.
                          ...(field.name === '' || field.name === nameFromLabel(field.label)
                            ? { name: nameFromLabel(label) }
                            : {}),
                        });
                      }}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`field-type-${index}`}>Type</label>
                    <select
                      id={`field-type-${index}`}
                      value={field.type}
                      disabled={!canWrite}
                      onChange={(event) => updateField(index, { type: event.currentTarget.value })}
                    >
                      {FIELD_TYPES.map((entry) => (
                        <option key={entry.value} value={entry.value}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field field--checkbox">
                    <label htmlFor={`field-required-${index}`}>
                      <input
                        id={`field-required-${index}`}
                        type="checkbox"
                        checked={field.required}
                        disabled={!canWrite}
                        onChange={(event) =>
                          updateField(index, { required: event.currentTarget.checked })
                        }
                      />
                      <span>Required</span>
                    </label>
                  </div>
                  <div className="field">
                    <label htmlFor={`field-help-${index}`}>Help text</label>
                    <input
                      id={`field-help-${index}`}
                      value={field.helpText ?? ''}
                      maxLength={500}
                      disabled={!canWrite}
                      onChange={(event) =>
                        updateField(index, { helpText: event.currentTarget.value })
                      }
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`field-placeholder-${index}`}>Placeholder</label>
                    <input
                      id={`field-placeholder-${index}`}
                      value={field.placeholder ?? ''}
                      maxLength={200}
                      disabled={!canWrite}
                      onChange={(event) =>
                        updateField(index, { placeholder: event.currentTarget.value })
                      }
                    />
                  </div>

                  {field.type === 'select' ? (
                    <>
                      <div className="field field--checkbox">
                        <label htmlFor={`field-source-${index}`}>
                          <input
                            id={`field-source-${index}`}
                            type="checkbox"
                            checked={field.optionsSource === 'services'}
                            disabled={!canWrite}
                            onChange={(event) =>
                              updateField(index, {
                                optionsSource: event.currentTarget.checked ? 'services' : undefined,
                              })
                            }
                          />
                          <span>Fill choices from the service catalogue</span>
                        </label>
                      </div>
                      {field.optionsSource !== 'services' ? (
                        <div className="field">
                          <label htmlFor={`field-options-${index}`}>Choices, one per line</label>
                          <textarea
                            id={`field-options-${index}`}
                            rows={4}
                            disabled={!canWrite}
                            value={field.options.map((option) => option.label).join('\n')}
                            onChange={(event) =>
                              updateField(index, {
                                options: event.currentTarget.value
                                  .split('\n')
                                  .map((line) => line.trim())
                                  .filter(Boolean)
                                  .map((line) => ({
                                    value: nameFromLabel(line) || line,
                                    label: line,
                                  })),
                              })
                            }
                          />
                        </div>
                      ) : null}
                    </>
                  ) : null}

                  <div className="field">
                    <label htmlFor={`field-name-${index}`}>Machine name</label>
                    <input
                      id={`field-name-${index}`}
                      value={field.name}
                      maxLength={64}
                      disabled={!canWrite}
                      onChange={(event) =>
                        updateField(index, {
                          name: event.currentTarget.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
                        })
                      }
                    />
                    <p className="field-help">
                      The key submissions carry. <code>name</code>, <code>email</code>,{' '}
                      <code>phone</code> and <code>message</code> get special CRM handling.
                    </p>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ol>

        {canWrite ? (
          <button type="button" className="button" onClick={addField}>
            Add field
          </button>
        ) : null}
      </section>

      <section className="panel">
        <h2>After submission</h2>
        <div className="field">
          <label htmlFor="form-success">Confirmation message</label>
          <textarea
            id="form-success"
            rows={2}
            value={definition.successMessage}
            maxLength={2000}
            disabled={!canWrite}
            onChange={(event) => update({ successMessage: event.currentTarget.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="form-submit-label">Submit button text</label>
          <input
            id="form-submit-label"
            value={definition.submitLabel}
            maxLength={100}
            disabled={!canWrite}
            onChange={(event) => update({ submitLabel: event.currentTarget.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="form-service">Attribute leads to a service</label>
          <select
            id="form-service"
            value={definition.outcomeConfig.serviceId ?? ''}
            disabled={!canWrite}
            onChange={(event) =>
              update({
                outcomeConfig: event.currentTarget.value
                  ? { serviceId: event.currentTarget.value }
                  : {},
              })
            }
          >
            <option value="">Let the submission&apos;s service field decide</option>
            {services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="form-notify">Notify these addresses, one per line</label>
          <textarea
            id="form-notify"
            rows={2}
            disabled={!canWrite}
            value={definition.notifyEmails.join('\n')}
            onChange={(event) =>
              update({
                notifyEmails: event.currentTarget.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean),
              })
            }
          />
        </div>
        <div className="field field--checkbox">
          <label htmlFor="form-consent">
            <input
              id="form-consent"
              type="checkbox"
              checked={definition.requiresConsent}
              disabled={!canWrite}
              onChange={(event) => update({ requiresConsent: event.currentTarget.checked })}
            />
            <span>Require consent to be contacted</span>
          </label>
        </div>
        {definition.requiresConsent ? (
          <div className="field">
            <label htmlFor="form-consent-text">Consent wording</label>
            <textarea
              id="form-consent-text"
              rows={2}
              value={definition.consentText}
              maxLength={2000}
              disabled={!canWrite}
              onChange={(event) => update({ consentText: event.currentTarget.value })}
            />
          </div>
        ) : null}
      </section>

      {canWrite ? (
        <div className="editor-actions">
          <button
            type="button"
            className="button button--primary"
            disabled={pending}
            onClick={save}
          >
            {pending ? 'Saving…' : formId ? 'Save form' : 'Create form'}
          </button>
        </div>
      ) : (
        <p className="muted">Your role can view this form but not change it.</p>
      )}
    </div>
  );
}
