'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { SECTION_TYPES, sectionEditors, emptySectionProps, type SectionType } from '@bos/sections';
import {
  createPreview,
  restoreRevision,
  saveContent,
  setContentStatus,
  type ActionResult,
} from '@/lib/actions';
import { SectionField, type ReferenceOptions } from '@/components/section-fields';

/**
 * The section editor — per-field forms generated from the manifest in
 * @bos/sections, in place of the raw-JSON first version.
 *
 * Deliberately **not** an Elementor clone. An editor adds, removes, reorders,
 * hides and edits sections; they never choose markup, spacing or colour, which
 * is the constraint that keeps a hundred client sites on one design system.
 * A developer mode still shows the JSON, because debugging a stored document
 * through a form is miserable — but it is a toggle in a corner, not the
 * editing surface.
 *
 * Saving is layered:
 *  - **autosave** runs a few seconds after typing stops. It writes the draft
 *    (every save also snapshots a revision server-side) and never publishes.
 *  - **Save** is the same call, explicit.
 *  - **Publish/Unpublish** is a separate action behind its own permission.
 * The dirty flag drives both the "unsaved changes" warning and the status
 * line, so what the editor believes and what the server holds cannot drift
 * silently.
 */

interface StoredSection {
  id: string;
  type: string;
  hidden: boolean;
  props: Record<string, unknown>;
}

export interface RevisionSummary {
  readonly revision: number;
  readonly title: string | null;
  readonly createdAt: string;
}

export interface SeoValue {
  title: string;
  description: string;
  canonicalUrl: string;
  noindex: boolean;
  nofollow: boolean;
}

const AUTOSAVE_DELAY_MS = 4_000;

export function ContentEditor({
  contentId,
  title: initialTitle,
  excerpt: initialExcerpt,
  document,
  status,
  path,
  siteUrl,
  seo: initialSeo,
  revisions,
  referenceOptions,
  canWrite,
  canPublish,
}: {
  contentId: string;
  title: string;
  excerpt: string;
  document: { sections: unknown[] };
  status: string;
  path: string;
  siteUrl: string;
  seo: SeoValue;
  revisions: readonly RevisionSummary[];
  referenceOptions: ReferenceOptions;
  canWrite: boolean;
  canPublish: boolean;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [excerpt, setExcerpt] = useState(initialExcerpt);
  const [sections, setSections] = useState<StoredSection[]>(
    (document.sections as StoredSection[]) ?? [],
  );
  const [seo, setSeo] = useState<SeoValue>(initialSeo);
  const [openSection, setOpenSection] = useState<string | null>(null);
  const [developerMode, setDeveloperMode] = useState(false);
  const [addPickerOpen, setAddPickerOpen] = useState(false);
  const [result, setResult] = useState<ActionResult>({ ok: true });
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, startTransition] = useTransition();

  /* ------------------------------------------------------------- saving */

  const payload = useMemo(
    () => ({ title, excerpt, document: { sections }, seo }),
    [title, excerpt, sections, seo],
  );
  const payloadRef = useRef(payload);
  useEffect(() => {
    payloadRef.current = payload;
  }, [payload]);

  const persist = useCallback(
    (mode: 'auto' | 'manual') => {
      startTransition(async () => {
        const saved = await saveContent(contentId, payloadRef.current, {
          autosave: mode === 'auto',
        });
        setResult(saved);
        if (saved.ok) {
          setSavedAt(new Date());
          setDirty(false);
        }
      });
    },
    [contentId],
  );

  // Autosave: debounce after the last change. Cleared on unmount.
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const markDirty = useCallback(() => {
    if (!canWrite) return;
    setDirty(true);
    clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => persist('auto'), AUTOSAVE_DELAY_MS);
  }, [canWrite, persist]);

  useEffect(() => () => clearTimeout(autosaveTimer.current), []);

  // Leaving with unsaved changes deserves a warning, not silence.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  /* ----------------------------------------------------------- sections */

  const changeSections = (next: StoredSection[]): void => {
    setSections(next);
    markDirty();
  };

  const move = (index: number, direction: -1 | 1): void => {
    const target = index + direction;
    if (target < 0 || target >= sections.length) return;
    const next = [...sections];
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(target, 0, moved);
    changeSections(next);
  };

  const duplicate = (index: number): void => {
    const source = sections[index];
    if (!source) return;
    const next = [...sections];
    next.splice(index + 1, 0, {
      ...source,
      id: crypto.randomUUID(),
      props: structuredClone(source.props),
    });
    changeSections(next);
  };

  const remove = (index: number): void => {
    changeSections(sections.filter((_, position) => position !== index));
  };

  const toggleHidden = (index: number): void => {
    changeSections(
      sections.map((section, position) =>
        position === index ? { ...section, hidden: !section.hidden } : section,
      ),
    );
  };

  const addSection = (type: SectionType): void => {
    const section: StoredSection = {
      id: crypto.randomUUID(),
      type,
      hidden: false,
      props: emptySectionProps(type),
    };
    changeSections([...sections, section]);
    setOpenSection(section.id);
    setAddPickerOpen(false);
  };

  const updateProps = (index: number, props: Record<string, unknown>): void => {
    changeSections(
      sections.map((section, position) => (position === index ? { ...section, props } : section)),
    );
  };

  /* ------------------------------------------------------------ actions */

  const changeStatus = (next: 'draft' | 'published' | 'archived'): void => {
    startTransition(async () => {
      // Publish what is on screen, not what was last autosaved.
      if (dirty) {
        const saved = await saveContent(contentId, payloadRef.current, { autosave: false });
        if (!saved.ok) {
          setResult(saved);
          return;
        }
        setDirty(false);
        setSavedAt(new Date());
      }
      setResult(await setContentStatus(contentId, next));
    });
  };

  const openPreview = (): void => {
    startTransition(async () => {
      if (dirty) {
        const saved = await saveContent(contentId, payloadRef.current, { autosave: true });
        if (!saved.ok) {
          setResult(saved);
          return;
        }
        setDirty(false);
        setSavedAt(new Date());
      }
      const preview = await createPreview(contentId);
      if (preview.ok && preview.message) {
        window.open(preview.message, '_blank', 'noopener');
      } else {
        setResult(preview);
      }
    });
  };

  const restore = (revision: number): void => {
    if (
      !window.confirm(`Restore revision ${revision}? The current state is kept as a new revision.`)
    ) {
      return;
    }
    startTransition(async () => {
      const restored = await restoreRevision(contentId, revision);
      setResult(restored);
      // The server now holds different content; a reload is the honest state.
      if (restored.ok) window.location.reload();
    });
  };

  /* ------------------------------------------------------------- render */

  return (
    <div className="content-editor">
      <div className="editor-statusbar">
        <p role="status" className="muted">
          {pending
            ? 'Saving…'
            : dirty
              ? 'Unsaved changes'
              : savedAt
                ? `Saved ${savedAt.toLocaleTimeString()}`
                : ' '}
        </p>
        <div className="editor-statusbar-actions">
          <button type="button" className="link-button" onClick={openPreview} disabled={pending}>
            Preview
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() => setDeveloperMode((current) => !current)}
          >
            {developerMode ? 'Form view' : 'Developer view'}
          </button>
        </div>
      </div>

      {result.message ? (
        <p
          className={result.ok ? 'form-success' : 'form-error'}
          role={result.ok ? 'status' : 'alert'}
        >
          {result.message}
        </p>
      ) : null}

      <section className="panel">
        <h2>Page</h2>
        <div className="field">
          <label htmlFor="title">Title</label>
          <input
            id="title"
            value={title}
            required
            disabled={!canWrite}
            onChange={(event) => {
              setTitle(event.currentTarget.value);
              markDirty();
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="excerpt">Excerpt</label>
          <textarea
            id="excerpt"
            rows={2}
            value={excerpt}
            maxLength={600}
            disabled={!canWrite}
            onChange={(event) => {
              setExcerpt(event.currentTarget.value);
              markDirty();
            }}
          />
          <p className="field-help">
            Used as the meta description and on cards linking to this page.
          </p>
        </div>
      </section>

      <section className="panel">
        <h2>Sections</h2>

        {sections.length === 0 ? (
          <p className="muted">This page has no sections yet. Add the first one below.</p>
        ) : (
          <ol className="section-editor">
            {sections.map((section, index) => {
              const spec = sectionEditors[section.type as SectionType];
              const isOpen = openSection === section.id;
              return (
                <li
                  key={section.id}
                  className={section.hidden ? 'section-item hidden' : 'section-item'}
                >
                  <header>
                    <button
                      type="button"
                      className="section-title"
                      aria-expanded={isOpen}
                      onClick={() => setOpenSection(isOpen ? null : section.id)}
                    >
                      <strong>{spec?.label ?? section.type}</strong>
                      <span className="muted"> {sectionSummary(section)}</span>
                    </button>
                    {section.hidden ? <span className="badge badge--muted">Hidden</span> : null}

                    {canWrite ? (
                      <span className="section-actions">
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => move(index, -1)}
                          disabled={index === 0}
                          aria-label={`Move ${spec?.label ?? section.type} up`}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => move(index, 1)}
                          disabled={index === sections.length - 1}
                          aria-label={`Move ${spec?.label ?? section.type} down`}
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
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => duplicate(index)}
                        >
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

                  {isOpen ? (
                    developerMode || !spec ? (
                      <DeveloperProps
                        section={section}
                        disabled={!canWrite}
                        onChange={(props) => updateProps(index, props)}
                      />
                    ) : (
                      <div className="section-form">
                        {spec.fields.map((field) => (
                          <SectionField
                            key={field.name || field.kind}
                            spec={field}
                            value={field.name === '' ? section.props : section.props[field.name]}
                            disabled={!canWrite}
                            referenceOptions={referenceOptions}
                            onChange={(next) =>
                              updateProps(
                                index,
                                field.name === ''
                                  ? (next as Record<string, unknown>)
                                  : { ...section.props, [field.name]: next },
                              )
                            }
                          />
                        ))}
                      </div>
                    )
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}

        {canWrite ? (
          addPickerOpen ? (
            <div className="section-picker" role="menu" aria-label="Add a section">
              {SECTION_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  role="menuitem"
                  className="section-picker-option"
                  onClick={() => addSection(type)}
                >
                  <strong>{sectionEditors[type].label}</strong>
                  <span className="muted">{sectionEditors[type].description}</span>
                </button>
              ))}
              <button type="button" className="link-button" onClick={() => setAddPickerOpen(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="button" onClick={() => setAddPickerOpen(true)}>
              Add section…
            </button>
          )
        ) : null}
      </section>

      <section className="panel">
        <h2>Search appearance</h2>
        <SerpPreview
          title={seo.title || title}
          description={seo.description || excerpt}
          url={`${siteUrl}${path}`}
        />
        <div className="field">
          <label htmlFor="seo-title">Search title</label>
          <input
            id="seo-title"
            value={seo.title}
            maxLength={70}
            disabled={!canWrite}
            onChange={(event) => {
              setSeo({ ...seo, title: event.currentTarget.value });
              markDirty();
            }}
          />
          <p className="field-help">
            {`${(seo.title || title).length} characters — around 60 fits a result.`}
          </p>
        </div>
        <div className="field">
          <label htmlFor="seo-description">Search description</label>
          <textarea
            id="seo-description"
            rows={2}
            value={seo.description}
            maxLength={170}
            disabled={!canWrite}
            onChange={(event) => {
              setSeo({ ...seo, description: event.currentTarget.value });
              markDirty();
            }}
          />
          <p className="field-help">
            {`${(seo.description || excerpt).length} characters — around 155 fits.`}
          </p>
        </div>
        <div className="field">
          <label htmlFor="seo-canonical">Canonical URL override</label>
          <input
            id="seo-canonical"
            value={seo.canonicalUrl}
            disabled={!canWrite}
            placeholder="Leave empty for this page's own URL"
            onChange={(event) => {
              setSeo({ ...seo, canonicalUrl: event.currentTarget.value });
              markDirty();
            }}
          />
          <p className="field-help">
            Only when this page duplicates another that should rank instead.
          </p>
        </div>
        <div className="field field--checkbox">
          <label htmlFor="seo-noindex">
            <input
              id="seo-noindex"
              type="checkbox"
              checked={seo.noindex}
              disabled={!canWrite}
              onChange={(event) => {
                setSeo({ ...seo, noindex: event.currentTarget.checked });
                markDirty();
              }}
            />
            <span>Hide from search engines (noindex)</span>
          </label>
        </div>
        <div className="field field--checkbox">
          <label htmlFor="seo-nofollow">
            <input
              id="seo-nofollow"
              type="checkbox"
              checked={seo.nofollow}
              disabled={!canWrite}
              onChange={(event) => {
                setSeo({ ...seo, nofollow: event.currentTarget.checked });
                markDirty();
              }}
            />
            <span>Do not follow links from this page (nofollow)</span>
          </label>
        </div>
      </section>

      {canWrite ? (
        <div className="editor-actions">
          <button
            type="button"
            className="button button--primary"
            disabled={pending}
            onClick={() => persist('manual')}
          >
            {pending ? 'Saving…' : 'Save'}
          </button>

          {canPublish ? (
            status === 'published' ? (
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
            )
          ) : (
            <p className="muted">Your role can edit this page but not publish it.</p>
          )}
        </div>
      ) : (
        <p className="muted">Your role can view this page but not change it.</p>
      )}

      {revisions.length > 0 ? (
        <details className="panel">
          <summary>History ({revisions.length})</summary>
          <ul className="revision-list">
            {revisions.map((revision) => (
              <li key={revision.revision}>
                <span>
                  #{revision.revision} — {new Date(revision.createdAt).toLocaleString()}
                  {revision.title ? ` · ${revision.title}` : ''}
                </span>
                {canWrite ? (
                  <button
                    type="button"
                    className="link-button"
                    disabled={pending}
                    onClick={() => restore(revision.revision)}
                  >
                    Restore
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** One line that says what a collapsed section contains. */
function sectionSummary(section: StoredSection): string {
  const props = section.props;
  const heading = typeof props.heading === 'string' ? props.heading : '';
  if (heading) return `· ${heading.slice(0, 60)}`;
  if (typeof props.html === 'string' && props.html) {
    return `· ${props.html
      .replace(/<[^>]+>/g, ' ')
      .trim()
      .slice(0, 60)}`;
  }
  return '';
}

function DeveloperProps({
  section,
  disabled,
  onChange,
}: {
  section: StoredSection;
  disabled: boolean;
  onChange: (props: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState(JSON.stringify(section.props, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);

  return (
    <div className="section-form">
      <label className="visually-hidden" htmlFor={`props-${section.id}`}>
        {section.type} raw settings
      </label>
      <textarea
        id={`props-${section.id}`}
        className="section-props"
        rows={Math.min(24, text.split('\n').length + 1)}
        value={text}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => setText(event.currentTarget.value)}
        onBlur={() => {
          try {
            const parsed: unknown = JSON.parse(text);
            if (typeof parsed === 'object' && parsed !== null) {
              onChange(parsed as Record<string, unknown>);
              setParseError(null);
            } else {
              setParseError('The value must be an object.');
            }
          } catch {
            setParseError('Not valid JSON — the last valid value is kept.');
          }
        }}
      />
      {parseError ? (
        <p className="field-error" role="alert">
          {parseError}
        </p>
      ) : null}
    </div>
  );
}

/** Roughly what a search result will show, so edits have a target. */
function SerpPreview({
  title,
  description,
  url,
}: {
  title: string;
  description: string;
  url: string;
}) {
  return (
    <div className="serp-preview" aria-hidden="true">
      <p className="serp-url">{url}</p>
      <p className="serp-title">{title || 'Untitled page'}</p>
      <p className="serp-description">
        {description || 'No description yet — search engines will pick their own.'}
      </p>
    </div>
  );
}
