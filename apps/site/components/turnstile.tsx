'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';

/**
 * The Cloudflare Turnstile widget, loaded and rendered for real.
 *
 * The previous implementation rendered `<div class="cf-turnstile">` and never
 * loaded the script that gives it meaning — so on a deployment with the secret
 * configured, the API demanded a token the page could not produce and every
 * real submission was rejected. This component owns the whole lifecycle:
 * script load, explicit render, expiry, error, and reset after a failed
 * submission.
 *
 * The script is injected programmatically, which the site's CSP permits by
 * design: `strict-dynamic` exists precisely so that trusted, nonced bootstrap
 * code can load what it needs. `https://challenges.cloudflare.com` also stays
 * in `script-src` for browsers that do not understand `strict-dynamic`.
 *
 * Turnstile writes its token into a hidden `cf-turnstile-response` input
 * inside the container, so the surrounding form needs no wiring beyond
 * reading its own FormData.
 */

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: string | HTMLElement,
        params: {
          sitekey: string;
          theme?: 'light' | 'dark' | 'auto';
          'error-callback'?: () => void;
          'expired-callback'?: () => void;
          callback?: (token: string) => void;
        },
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
    };
    /** Invoked by the script's onload query parameter. */
    onloadTurnstileCallback?: () => void;
  }
}

const SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback&render=explicit';

/** One shared load promise: two forms on a page must not inject two scripts. */
let scriptLoading: Promise<void> | undefined;

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();

  scriptLoading ??= new Promise<void>((resolve, reject) => {
    window.onloadTurnstileCallback = () => resolve();

    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onerror = () => {
      // Allow a later mount to try again rather than caching the failure.
      scriptLoading = undefined;
      reject(new Error('The Turnstile script failed to load.'));
    };
    document.head.appendChild(script);
  });

  return scriptLoading;
}

export interface TurnstileProps {
  readonly siteKey: string;
  /**
   * Bumped by the parent to reset the widget — a submission the server
   * rejected has consumed the token, and resubmitting the spent one fails.
   */
  readonly resetSignal?: number;
}

export function Turnstile({ siteKey, resetSignal = 0 }: TurnstileProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | undefined>(undefined);
  const statusId = useId();
  const [state, setState] = useState<'loading' | 'ready' | 'expired' | 'failed'>('loading');

  const renderWidget = useCallback(() => {
    if (!containerRef.current || !window.turnstile) return;

    // Re-render replaces the widget; remove the old one first or Turnstile
    // logs an error and leaks an iframe.
    if (widgetIdRef.current !== undefined) {
      try {
        window.turnstile.remove(widgetIdRef.current);
      } catch {
        // A widget torn down by navigation is fine to have lost.
      }
    }

    widgetIdRef.current = window.turnstile.render(containerRef.current, {
      sitekey: siteKey,
      theme: 'auto',
      callback: () => setState('ready'),
      'expired-callback': () => setState('expired'),
      'error-callback': () => setState('failed'),
    });
  }, [siteKey]);

  useEffect(() => {
    let cancelled = false;

    loadTurnstileScript()
      .then(() => {
        if (cancelled) return;
        setState('ready');
        renderWidget();
      })
      .catch(() => {
        if (!cancelled) setState('failed');
      });

    return () => {
      cancelled = true;
      if (widgetIdRef.current !== undefined && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // Already gone.
        }
        widgetIdRef.current = undefined;
      }
    };
  }, [renderWidget]);

  // A rejected submission spends the token; reset mints a fresh one.
  useEffect(() => {
    if (resetSignal > 0 && widgetIdRef.current !== undefined && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current);
      setState('ready');
    }
  }, [resetSignal]);

  return (
    <div className="field field--turnstile">
      <div ref={containerRef} />
      {/*
        Announced politely: an expired or failed check changes what pressing
        submit will do, and somebody using a screen reader deserves to know
        before the rejection rather than from it.
      */}
      <p
        id={statusId}
        className={state === 'failed' ? 'field-error' : 'visually-hidden'}
        role="status"
      >
        {state === 'failed'
          ? 'The anti-spam check could not load. Please reload the page and try again, or contact us directly.'
          : state === 'expired'
            ? 'The anti-spam check expired. Please complete it again.'
            : ''}
      </p>
    </div>
  );
}
