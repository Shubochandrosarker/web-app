'use client';

import { useState, useTransition } from 'react';
import { suggestSeoImprovements, type ActionResult, type SeoSuggestions } from '@/lib/actions';

/**
 * AI suggestions, for a human to read and act on.
 *
 * Nothing here applies anything: the output is a set of proposals with an
 * explicit review framing, and applying one means editing the page yourself.
 * The one-way door between a model's output and the public site stays shut.
 */

export function SeoSuggestionsPanel({
  pages,
  aiConfigured,
}: {
  readonly pages: readonly { id: string; path: string; title: string }[];
  readonly aiConfigured: boolean;
}) {
  const [contentId, setContentId] = useState('');
  const [result, setResult] = useState<
    (ActionResult & { suggestions?: SeoSuggestions | null; notes?: string }) | null
  >(null);
  const [pending, startTransition] = useTransition();

  if (!aiConfigured) {
    return (
      <section className="panel" aria-labelledby="seo-ai-heading">
        <h2 id="seo-ai-heading">AI suggestions</h2>
        <p className="muted">
          Not configured. Set <code>AI_PROVIDER</code> (anthropic, openai or workers_ai) and{' '}
          <code>AI_API_KEY</code> in the API environment to get reviewable suggestions — meta
          rewrites, questions worth answering, internal links. Suggestions are never applied
          automatically.
        </p>
      </section>
    );
  }

  const suggestions = result?.suggestions;

  return (
    <section className="panel" aria-labelledby="seo-ai-heading">
      <h2 id="seo-ai-heading">AI suggestions</h2>
      <p className="muted">
        Proposals to review, not changes: nothing is applied until you edit the page yourself.
      </p>

      <div className="field">
        <label htmlFor="seo-ai-page">Page</label>
        <select
          id="seo-ai-page"
          value={contentId}
          disabled={pending}
          onChange={(event) => {
            setContentId(event.currentTarget.value);
            setResult(null);
          }}
        >
          <option value="">Choose a page…</option>
          {pages.map((page) => (
            <option key={page.id} value={page.id}>
              {page.path} — {page.title}
            </option>
          ))}
        </select>
      </div>

      <button
        type="button"
        className="button button--primary"
        disabled={pending || !contentId}
        onClick={() =>
          startTransition(async () => {
            setResult(await suggestSeoImprovements(contentId));
          })
        }
      >
        {pending ? 'Asking…' : 'Suggest improvements'}
      </button>

      {result?.message ? (
        <p
          className={result.ok ? 'form-success' : 'form-error'}
          role={result.ok ? 'status' : 'alert'}
        >
          {result.message}
        </p>
      ) : null}

      {suggestions ? (
        <div className="suggestion-results">
          {suggestions.metaTitle ? (
            <div className="field">
              <h3>Suggested title</h3>
              <p>
                <code>{suggestions.metaTitle}</code>{' '}
                <span className="muted">({suggestions.metaTitle.length} chars)</span>
              </p>
            </div>
          ) : null}
          {suggestions.metaDescription ? (
            <div className="field">
              <h3>Suggested description</h3>
              <p>
                <code>{suggestions.metaDescription}</code>{' '}
                <span className="muted">({suggestions.metaDescription.length} chars)</span>
              </p>
            </div>
          ) : null}
          {suggestions.questionsToAnswer.length > 0 ? (
            <div className="field">
              <h3>Questions this page could answer</h3>
              <ul>
                {suggestions.questionsToAnswer.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {suggestions.internalLinkSuggestions.length > 0 ? (
            <div className="field">
              <h3>Internal links worth adding</h3>
              <ul>
                {suggestions.internalLinkSuggestions.map((link) => (
                  <li key={`${link.toPath}-${link.anchor}`}>
                    Link to <code>{link.toPath}</code> with the text “{link.anchor}”
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {suggestions.improvements.length > 0 ? (
            <div className="field">
              <h3>Other improvements</h3>
              <ul>
                {suggestions.improvements.map((improvement) => (
                  <li key={improvement}>{improvement}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="muted">
            To apply any of these, open the page in the content editor and make the change — the SEO
            panel there edits the title and description.
          </p>
        </div>
      ) : result?.notes ? (
        <div className="field">
          <h3>The model answered in prose</h3>
          <p className="muted">{result.notes}</p>
        </div>
      ) : null}
    </section>
  );
}
