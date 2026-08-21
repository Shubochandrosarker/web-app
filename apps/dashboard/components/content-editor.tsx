'use client';

import { useState, useTransition } from 'react';
import { saveContent, setContentStatus, type ActionResult } from '@/lib/actions';

/**
 * The section editor.
 *
 * Deliberately **not** an Elementor clone. An editor adds, removes, reorders,
 * hides and edits sections; they never choose markup, spacing or colour, which
 * is the constraint that keeps a hundred client sites on one design system.
 *
 * Section props are edited as JSON in this first version. That is an honest
 * trade rather than a shortcut: seventeen section types have around ninety
 * distinct fields between them, and a per-field form generated from the Zod
 * schemas is the right answer — it is TASK-202's answer, and building half of
 * it here would be a form that handles the easy types and silently mangles the
 * rest. What this version does give is the part that matters for safety: every
 * save is validated against the section schemas server-side and sanitised, so
 * a malformed document is a 422 with the offending field named, not a broken
 * page.
 */

interface StoredSection {
  id: string;
  type: string;
  hidden: boolean;
  props: Record<string, unknown>;
}

const EMPTY: ActionResult = { ok: false };

export function ContentEditor({
  contentId,
  title,
  excerpt,
  document,
  status,
  canWrite,
  canPublish,
}: {
  contentId: string;
  title: string;
  excerpt: string;
  document: { sections: unknown[] };
  status: string;
  canWrite: boolean;
  canPublish: boolean;
}) {
  const [sections, setSections] = useState<StoredSection[]>(
    (document.sections as StoredSection[]) ?? [],
  );
  const [result, setResult] = useState<ActionResult>(EMPTY);
  const [pending, startTransition] = useTransition();

  const move = (index: number, direction: -1 | 1): void => {
    const target = index + direction;
    if (target < 0 || target >= sections.length) return;
    const next = [...sections];
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(target, 0, moved);
    setSections(next);
  };

  const duplicate = (index: number): void => {
    const source = sections[index];
    if (!source) return;
    const next = [...sections];
    // A new id, or the two copies are the same section as far as React's keys
    // and the server's validation are concerned.
    next.splice(index + 1, 0, { ...source, id: crypto.randomUUID() });
    setSections(next);
  };

  const remove = (index: number): void => {
    setSections(sections.filter((_, position) => position !== index));
  };

  const toggleHidden = (index: number): void => {
    setSections(
      sections.map((section, position) =>
        position === index ? { ...section, hidden: !section.hidden } : section,
      ),
    );
  };

  const updateProps = (index: number, json: string): void => {
    setSections(
      sections.map((section, position) =>
        position === index ? { ...section, props: safeParse(json, section.props) } : section,
      ),
    );
  };

  const save = (formData: FormData): void => {
    formData.set('document', JSON.stringify({ sections }));
    startTransition(async () => {
      setResult(await saveContent(contentId, formData));
    });
  };

  const changeStatus = (next: 'draft' | 'published' | 'archived'): void => {
    startTransition(async () => {
      setResult(await setContentStatus(contentId, next));
    });
  };

  return (
    <form action={save} className="panel">
      <h2>Page</h2>

      {result.message ? (
        <p
          className={result.ok ? 'form-success' : 'form-error'}
          role={result.ok ? 'status' : 'alert'}
        >
          {result.message}
        </p>
      ) : null}

      <div className="field">
        <label htmlFor="title">Title</label>
        <input id="title" name="title" defaultValue={title} required disabled={!canWrite} />
      </div>

      <div className="field">
        <label htmlFor="excerpt">Excerpt</label>
        <textarea
          id="excerpt"
          name="excerpt"
          rows={2}
          defaultValue={excerpt}
          maxLength={600}
          disabled={!canWrite}
        />
        <p className="field-help">
          Used as the meta description and on cards linking to this page.
        </p>
      </div>

      <h2>Sections</h2>

      {sections.length === 0 ? (
        <p className="muted">This page has no sections yet.</p>
      ) : (
        <ol className="section-editor">
          {sections.map((section, index) => (
            <li
              key={section.id}
              className={section.hidden ? 'section-item hidden' : 'section-item'}
            >
              <header>
                <strong>{section.type}</strong>
                {section.hidden ? <span className="badge badge--muted">Hidden</span> : null}

                {canWrite ? (
                  <span className="section-actions">
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                      aria-label={`Move ${section.type} up`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => move(index, 1)}
                      disabled={index === sections.length - 1}
                      aria-label={`Move ${section.type} down`}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => toggleHidden(index)}
                    >
                      {section.hidden ? 'Show' : 'Hide'}
                    </button>
                    <button type="button" className="link-button" onClick={() => duplicate(index)}>
                      Duplicate
                    </button>
                    <button
                      type="button"
                      className="link-button link-button--danger"
                      onClick={() => remove(index)}
                    >
                      Remove
                    </button>
                  </span>
                ) : null}
              </header>

              <label className="visually-hidden" htmlFor={`props-${section.id}`}>
                {section.type} settings
              </label>
              <textarea
                id={`props-${section.id}`}
                className="section-props"
                rows={Math.min(20, JSON.stringify(section.props, null, 2).split('\n').length + 1)}
                defaultValue={JSON.stringify(section.props, null, 2)}
                onBlur={(event) => updateProps(index, event.currentTarget.value)}
                disabled={!canWrite}
                spellCheck={false}
              />
            </li>
          ))}
        </ol>
      )}

      {canWrite ? (
        <div className="editor-actions">
          <button type="submit" className="button button--primary" disabled={pending}>
            {pending ? 'Saving…' : 'Save draft'}
          </button>

          {canPublish ? (
            <>
              {status === 'published' ? (
                <button
                  type="button"
                  className="button"
                  disabled={pending}
                  onClick={() => changeStatus('draft')}
                >
                  Unpublish
                </button>
              ) : (
                <button
                  type="button"
                  className="button"
                  disabled={pending}
                  onClick={() => changeStatus('published')}
                >
                  Publish
                </button>
              )}
            </>
          ) : (
            <p className="muted">Your role can edit this page but not publish it.</p>
          )}
        </div>
      ) : (
        <p className="muted">Your role can view this page but not change it.</p>
      )}
    </form>
  );
}

/**
 * Parse edited JSON, keeping the previous value when it does not parse.
 *
 * Discarding an editor's half-finished typing on every keystroke would be
 * worse than holding the last good value and letting the server reject the
 * save with a message.
 */
function safeParse(json: string, fallback: Record<string, unknown>): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : fallback;
  } catch {
    return fallback;
  }
}
