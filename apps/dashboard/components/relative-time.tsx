'use client';

import { useSyncExternalStore } from 'react';

/**
 * A timestamp rendered as both a relative phrase and a machine-readable value.
 *
 * `<time dateTime>` carries the exact instant for anything reading the markup,
 * while the text says "3 hours ago" — which is the form somebody triaging a
 * queue actually needs.
 *
 * ## Why the clock is an external store
 *
 * "How long ago" needs the current time, and the current time is not React
 * state: it changes on its own, without anybody setting it. Two earlier
 * attempts got this wrong in instructive ways.
 *
 * Reading `Date.now()` during render is impure — React may render more than
 * once, and the server's clock is not the visitor's. It was defensible while
 * this was a server component rendering exactly once per request, and stopped
 * being defensible the moment a client component imported it. A `server-only`
 * guard turned that into a build error rather than a silent change of
 * behaviour, which is how it was caught.
 *
 * Setting state from an effect works and causes a cascading render on mount,
 * for a value that was never React's to own.
 *
 * `useSyncExternalStore` is the primitive for exactly this: a value that lives
 * outside React, that React subscribes to. The server snapshot is `null`, so
 * the markup contains a real date for a crawler, a screen reader, or anyone
 * with JavaScript off; the client snapshot is the current minute, so the
 * phrase appears after hydration and refreshes while the page is open.
 *
 * One interval serves every timestamp on the page, rather than one each.
 *
 * This is a dashboard component, and the dashboard's JavaScript budget is
 * explicitly not a ranking concern (ADR-0006). On the public site the same
 * trade would be decided differently.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * The snapshot: the current time, updated once a minute.
 *
 * Cached rather than read on each call, because `useSyncExternalStore`
 * compares snapshots by identity — returning a fresh `Date.now()` every time
 * would tell React the store had changed on every render, forever.
 *
 * Zero until the first subscription, which is what makes the client's first
 * render match the server's and avoids a hydration mismatch.
 */
let currentTime = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(onStoreChange: Listener): () => void {
  listeners.add(onStoreChange);

  if (timer === undefined) {
    currentTime = Date.now();

    // A minute is the finest granularity the phrasing distinguishes, so
    // anything faster would be work with nothing to show for it. It matters
    // because a queue somebody leaves open should not spend the afternoon
    // claiming a lead arrived "1 minute ago".
    timer = setInterval(() => {
      currentTime = Date.now();
      for (const listener of listeners) listener();
    }, 60_000);
  }

  /*
   * Announce the first value on the next tick, after hydration has finished.
   * Without it the phrase would not appear until the first interval fired, a
   * minute later.
   */
  queueMicrotask(() => {
    for (const listener of listeners) listener();
  });

  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
      currentTime = 0;
    }
  };
}

const getSnapshot = (): number => currentTime;

/** The server has no clock to subscribe to, and renders the absolute date. */
const getServerSnapshot = (): number => 0;

export function RelativeTime({ iso }: { iso: string }) {
  const now = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const instant = Date.parse(iso);

  return (
    <time dateTime={iso} title={new Date(iso).toISOString()}>
      {now === 0 || Number.isNaN(instant) ? absoluteDate(iso) : relativePhrase(instant, now)}
    </time>
  );
}

/** What the server renders, and what anyone without JavaScript keeps. */
function absoluteDate(iso: string): string {
  /*
   * A fixed locale and time zone, not the viewer's.
   *
   * `toLocaleDateString()` with no arguments produces a different string on
   * the server and in the browser, which React reports as a hydration
   * mismatch. Pinning both makes the two agree, and the relative phrase
   * replaces this a moment later anyway.
   */
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * "3 hours ago", "in 2 days".
 *
 * Pure: both instants are arguments, so it can be tested and cannot be the
 * reason a render is non-deterministic.
 */
export function relativePhrase(instant: number, now: number): string {
  const seconds = Math.round((now - instant) / 1000);
  const future = seconds < 0;
  const absolute = Math.abs(seconds);

  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'second'],
    [3600, 'minute'],
    [86_400, 'hour'],
    [604_800, 'day'],
    [2_629_800, 'week'],
    [31_557_600, 'month'],
  ];

  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

  let previous = 1;
  for (const [limit, unit] of units) {
    if (absolute < limit) {
      const value = Math.round(absolute / previous);
      return formatter.format(future ? value : -value, unit);
    }
    previous = limit;
  }

  return formatter.format(future ? 1 : -1, 'year');
}
