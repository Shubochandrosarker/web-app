'use client';

import { useId, useRef, useState } from 'react';
import type { EditorFieldSpec } from '@bos/sections';

/**
 * The generic field renderer behind the section editor.
 *
 * Each widget edits one property of a section's props object and reports the
 * whole updated value upward; the editor owns the document, these own one
 * field each. Nothing here knows section types — the manifest in
 * @bos/sections decides what to render, so a new section type is a schema
 * plus a manifest entry, never a new form.
 */

export interface ReferenceOption {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
}

/** Choices for every reference entity, fetched server-side by the page. */
export type ReferenceOptions = Readonly<Record<string, readonly ReferenceOption[]>>;

export function SectionField({
  spec,
  value,
  onChange,
  disabled,
  referenceOptions,
}: {
  readonly spec: EditorFieldSpec;
  readonly value: unknown;
  readonly onChange: (next: unknown) => void;
  readonly disabled: boolean;
  readonly referenceOptions: ReferenceOptions;
}) {
  const id = useId();

  switch (spec.kind) {
    case 'text':
      return (
        <div className="field">
          <label htmlFor={id}>
            {spec.label}
            {spec.required ? <RequiredMark /> : null}
          </label>
          <input
            id={id}
            type="text"
            value={typeof value === 'string' ? value : ''}
            maxLength={spec.maxLength}
            required={spec.required}
            disabled={disabled}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
          {spec.help ? <p className="field-help">{spec.help}</p> : null}
        </div>
      );

    case 'textarea':
      return (
        <div className="field">
          <label htmlFor={id}>
            {spec.label}
            {spec.required ? <RequiredMark /> : null}
          </label>
          <textarea
            id={id}
            rows={spec.rows ?? 3}
            value={typeof value === 'string' ? value : ''}
            maxLength={spec.maxLength}
            required={spec.required}
            disabled={disabled}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
          {spec.help ? <p className="field-help">{spec.help}</p> : null}
        </div>
      );

    case 'richtext':
      return (
        <RichTextField
          id={id}
          label={spec.label}
          help={spec.help}
          value={typeof value === 'string' ? value : ''}
          onChange={onChange}
          disabled={disabled}
        />
      );

    case 'select':
      return (
        <div className="field">
          <label htmlFor={id}>{spec.label}</label>
          <select
            id={id}
            value={String(value ?? spec.options[0]?.value ?? '')}
            disabled={disabled}
            onChange={(event) => {
              const raw = event.currentTarget.value;
              // Numeric selects (grid columns) round-trip as numbers.
              onChange(
                /^\d+$/.test(raw) && spec.options.every((o) => /^\d+$/.test(o.value))
                  ? Number(raw)
                  : raw,
              );
            }}
          >
            {spec.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {spec.help ? <p className="field-help">{spec.help}</p> : null}
        </div>
      );

    case 'number':
      return (
        <div className="field">
          <label htmlFor={id}>{spec.label}</label>
          <input
            id={id}
            type="number"
            value={typeof value === 'number' ? value : ''}
            min={spec.min}
            max={spec.max}
            disabled={disabled}
            onChange={(event) => {
              const raw = event.currentTarget.value;
              onChange(raw === '' ? undefined : Number(raw));
            }}
          />
          {spec.help ? <p className="field-help">{spec.help}</p> : null}
        </div>
      );

    case 'boolean':
      return (
        <div className="field field--checkbox">
          <label htmlFor={id}>
            <input
              id={id}
              type="checkbox"
              checked={value === true}
              disabled={disabled}
              onChange={(event) => onChange(event.currentTarget.checked)}
            />
            <span>{spec.label}</span>
          </label>
          {spec.help ? <p className="field-help">{spec.help}</p> : null}
        </div>
      );

    case 'media':
      return (
        <MediaField
          id={id}
          label={spec.label}
          help={spec.help}
          value={value as { mediaId?: string; alt?: string } | undefined}
          onChange={onChange}
          disabled={disabled}
          options={referenceOptions.media ?? []}
        />
      );

    case 'links':
      return (
        <LinksField
          label={spec.label}
          help={spec.help}
          min={spec.min ?? 0}
          max={spec.max}
          value={Array.isArray(value) ? (value as LinkValue[]) : []}
          onChange={onChange}
          disabled={disabled}
        />
      );

    case 'repeater':
      return (
        <RepeaterField
          spec={spec}
          value={Array.isArray(value) ? (value as Record<string, unknown>[]) : []}
          onChange={onChange}
          disabled={disabled}
          referenceOptions={referenceOptions}
        />
      );

    case 'references':
      return (
        <ReferencesField
          spec={spec}
          value={value}
          onChange={onChange}
          disabled={disabled}
          options={referenceOptions[spec.entity] ?? []}
        />
      );
  }
}

function RequiredMark() {
  return (
    <>
      {' '}
      <span className="required" aria-hidden="true">
        *
      </span>
      <span className="visually-hidden">(required)</span>
    </>
  );
}

/* ------------------------------------------------------------- rich text */

/**
 * Prose editing without a dependency.
 *
 * A contenteditable surface with the handful of commands body copy needs.
 * The output is HTML, and the API sanitises it on save exactly as it would
 * any other submitted HTML — this widget is a convenience, not a boundary.
 * The "HTML" toggle shows the source, which is also the fallback for anything
 * the toolbar cannot express.
 */
function RichTextField({
  id,
  label,
  help,
  value,
  onChange,
  disabled,
}: {
  readonly id: string;
  readonly label: string;
  readonly help: string | undefined;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly disabled: boolean;
}) {
  const [showSource, setShowSource] = useState(false);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  const execute = (command: string, argument?: string): void => {
    surfaceRef.current?.focus();
    document.execCommand(command, false, argument);
    if (surfaceRef.current) onChange(surfaceRef.current.innerHTML);
  };

  const addLink = (): void => {
    const href = window.prompt('Link address (https://… or /path)');
    if (href) execute('createLink', href);
  };

  return (
    <div className="field field--richtext">
      <div className="richtext-header">
        <label htmlFor={id}>{label}</label>
        <button
          type="button"
          className="link-button"
          onClick={() => setShowSource((current) => !current)}
        >
          {showSource ? 'Editor' : 'HTML'}
        </button>
      </div>

      {showSource ? (
        <textarea
          id={id}
          rows={10}
          value={value}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      ) : (
        <>
          <div className="richtext-toolbar" role="toolbar" aria-label={`${label} formatting`}>
            <button type="button" disabled={disabled} onClick={() => execute('bold')}>
              <strong>B</strong>
            </button>
            <button type="button" disabled={disabled} onClick={() => execute('italic')}>
              <em>I</em>
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => execute('formatBlock', '<h2>')}
            >
              H2
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => execute('formatBlock', '<h3>')}
            >
              H3
            </button>
            <button type="button" disabled={disabled} onClick={() => execute('formatBlock', '<p>')}>
              ¶
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => execute('insertUnorderedList')}
            >
              • List
            </button>
            <button type="button" disabled={disabled} onClick={() => execute('insertOrderedList')}>
              1. List
            </button>
            <button type="button" disabled={disabled} onClick={addLink}>
              Link
            </button>
          </div>
          <div
            ref={surfaceRef}
            id={id}
            className="richtext-surface"
            contentEditable={!disabled}
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-label={label}
            /*
             * The document owns the value; the surface re-renders only when
             * the section identity changes, so typing does not fight React.
             * The HTML is this section's stored body, which the API passed
             * through @bos/sanitize on the save that stored it; edits made
             * here go back through the same sanitiser before storage.
             */
            // eslint-disable-next-line no-restricted-syntax -- sanitised by @bos/sanitize at the API write boundary, round-tripped here
            dangerouslySetInnerHTML={{ __html: value }}
            onInput={(event) => onChange(event.currentTarget.innerHTML)}
            onBlur={(event) => onChange(event.currentTarget.innerHTML)}
          />
        </>
      )}
      {help ? <p className="field-help">{help}</p> : null}
    </div>
  );
}

/* ----------------------------------------------------------------- media */

function MediaField({
  id,
  label,
  help,
  value,
  onChange,
  disabled,
  options,
}: {
  readonly id: string;
  readonly label: string;
  readonly help: string | undefined;
  readonly value: { mediaId?: string; alt?: string } | undefined;
  readonly onChange: (next: unknown) => void;
  readonly disabled: boolean;
  readonly options: readonly ReferenceOption[];
}) {
  const selected = value?.mediaId ?? '';

  return (
    <div className="field field--media">
      <label htmlFor={id}>{label}</label>
      {options.length === 0 ? (
        <p className="field-help">
          The media library is empty. Upload images under Media, then choose one here.
        </p>
      ) : (
        <select
          id={id}
          value={selected}
          disabled={disabled}
          onChange={(event) => {
            const mediaId = event.currentTarget.value;
            onChange(mediaId ? { mediaId, alt: value?.alt ?? '' } : undefined);
          }}
        >
          <option value="">None</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      )}
      {selected ? (
        <div className="field">
          <label htmlFor={`${id}-alt`}>Alternative text</label>
          <input
            id={`${id}-alt`}
            type="text"
            value={value?.alt ?? ''}
            maxLength={300}
            disabled={disabled}
            onChange={(event) => onChange({ mediaId: selected, alt: event.currentTarget.value })}
          />
          <p className="field-help">
            What the image shows, for people who cannot see it. Required before publish.
          </p>
        </div>
      ) : null}
      {help ? <p className="field-help">{help}</p> : null}
    </div>
  );
}

/* ----------------------------------------------------------------- links */

interface LinkValue {
  label: string;
  href: string;
  primary?: boolean;
}

function LinksField({
  label,
  help,
  min,
  max,
  value,
  onChange,
  disabled,
}: {
  readonly label: string;
  readonly help: string | undefined;
  readonly min: number;
  readonly max: number;
  readonly value: LinkValue[];
  readonly onChange: (next: unknown) => void;
  readonly disabled: boolean;
}) {
  const update = (index: number, patch: Partial<LinkValue>): void => {
    onChange(value.map((link, position) => (position === index ? { ...link, ...patch } : link)));
  };

  return (
    <fieldset className="field field--links">
      <legend>{label}</legend>
      {value.map((link, index) => (
        <div key={index} className="link-row">
          <input
            type="text"
            aria-label={`${label} ${index + 1} text`}
            placeholder="Button text"
            value={link.label}
            maxLength={120}
            disabled={disabled}
            onChange={(event) => update(index, { label: event.currentTarget.value })}
          />
          <input
            type="text"
            aria-label={`${label} ${index + 1} address`}
            placeholder="/path or https://…"
            value={link.href}
            disabled={disabled}
            onChange={(event) => update(index, { href: event.currentTarget.value })}
          />
          <label className="link-primary">
            <input
              type="checkbox"
              checked={link.primary === true}
              disabled={disabled}
              onChange={(event) => update(index, { primary: event.currentTarget.checked })}
            />
            <span>Primary</span>
          </label>
          <button
            type="button"
            className="link-button link-button--danger"
            disabled={disabled || value.length <= min}
            onClick={() => onChange(value.filter((_, position) => position !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button button--small"
        disabled={disabled || value.length >= max}
        onClick={() => onChange([...value, { label: '', href: '/', primary: value.length === 0 }])}
      >
        Add button
      </button>
      {help ? <p className="field-help">{help}</p> : null}
    </fieldset>
  );
}

/* -------------------------------------------------------------- repeater */

function RepeaterField({
  spec,
  value,
  onChange,
  disabled,
  referenceOptions,
}: {
  readonly spec: Extract<EditorFieldSpec, { kind: 'repeater' }>;
  readonly value: Record<string, unknown>[];
  readonly onChange: (next: unknown) => void;
  readonly disabled: boolean;
  readonly referenceOptions: ReferenceOptions;
}) {
  /**
   * Gallery-style repeaters hold bare objects (`{ mediaId, alt }`) rather
   * than named properties; an item field whose name is '' edits the item
   * itself.
   */
  const itemValue = (item: Record<string, unknown>, name: string): unknown =>
    name === '' ? item : item[name];

  const withItemValue = (
    item: Record<string, unknown>,
    name: string,
    next: unknown,
  ): Record<string, unknown> =>
    name === '' ? (next as Record<string, unknown>) : { ...item, [name]: next };

  const emptyItem = (): Record<string, unknown> => {
    const item: Record<string, unknown> = {};
    for (const field of spec.itemFields) {
      if (field.name === '') continue;
      if (field.kind === 'boolean') item[field.name] = false;
      else if (field.kind === 'text' || field.kind === 'textarea') item[field.name] = '';
    }
    return item;
  };

  const move = (index: number, direction: -1 | 1): void => {
    const target = index + direction;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(target, 0, moved);
    onChange(next);
  };

  return (
    <fieldset className="field field--repeater">
      <legend>{spec.label}</legend>
      {spec.help ? <p className="field-help">{spec.help}</p> : null}

      <ol className="repeater-list">
        {value.map((item, index) => (
          <li key={index} className="repeater-item">
            <header>
              <span>
                {spec.itemLabel} {index + 1}
              </span>
              <span className="section-actions">
                <button
                  type="button"
                  className="link-button"
                  disabled={disabled || index === 0}
                  onClick={() => move(index, -1)}
                  aria-label={`Move ${spec.itemLabel} ${index + 1} up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="link-button"
                  disabled={disabled || index === value.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label={`Move ${spec.itemLabel} ${index + 1} down`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="link-button link-button--danger"
                  disabled={disabled || value.length <= (spec.min ?? 0)}
                  onClick={() => onChange(value.filter((_, position) => position !== index))}
                >
                  Remove
                </button>
              </span>
            </header>
            {spec.itemFields.map((field) => (
              <SectionField
                key={field.name || field.kind}
                spec={field}
                value={itemValue(item, field.name)}
                disabled={disabled}
                referenceOptions={referenceOptions}
                onChange={(next) =>
                  onChange(
                    value.map((candidate, position) =>
                      position === index ? withItemValue(candidate, field.name, next) : candidate,
                    ),
                  )
                }
              />
            ))}
          </li>
        ))}
      </ol>

      <button
        type="button"
        className="button button--small"
        disabled={disabled || value.length >= spec.max}
        onClick={() => onChange([...value, emptyItem()])}
      >
        Add {spec.itemLabel.toLowerCase()}
      </button>
    </fieldset>
  );
}

/* ------------------------------------------------------------ references */

function ReferencesField({
  spec,
  value,
  onChange,
  disabled,
  options,
}: {
  readonly spec: Extract<EditorFieldSpec, { kind: 'references' }>;
  readonly value: unknown;
  readonly onChange: (next: unknown) => void;
  readonly disabled: boolean;
  readonly options: readonly ReferenceOption[];
}) {
  const id = useId();

  if (spec.single) {
    return (
      <div className="field">
        <label htmlFor={id}>{spec.label}</label>
        <select
          id={id}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          <option value="">Choose…</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
              {option.detail ? ` — ${option.detail}` : ''}
            </option>
          ))}
        </select>
        {spec.help ? <p className="field-help">{spec.help}</p> : null}
      </div>
    );
  }

  const selected = Array.isArray(value) ? (value as string[]) : [];

  return (
    <fieldset className="field field--references">
      <legend>{spec.label}</legend>
      {spec.help ? <p className="field-help">{spec.help}</p> : null}
      {options.length === 0 ? (
        <p className="field-help">Nothing to choose from yet.</p>
      ) : (
        <ul className="reference-list">
          {options.map((option) => {
            const checked = selected.includes(option.id);
            const atLimit = spec.max !== undefined && selected.length >= spec.max;
            return (
              <li key={option.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || (!checked && atLimit)}
                    onChange={(event) =>
                      onChange(
                        event.currentTarget.checked
                          ? [...selected, option.id]
                          : selected.filter((candidate) => candidate !== option.id),
                      )
                    }
                  />
                  <span>
                    {option.label}
                    {option.detail ? <span className="muted"> — {option.detail}</span> : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}
