import type { ResolvedWorkspaceConfig } from '@bos/business-types';

/**
 * Design tokens, generated from the tenant's brand configuration.
 *
 * The rule this file exists to keep: **no reusable component contains a
 * colour.** Components reference `var(--color-accent)`; what that resolves to
 * is a property of the workspace. A second client is a different set of values
 * here, not a forked stylesheet.
 *
 * The palette is derived rather than enumerated. A tenant config that had to
 * list eleven shades of its brand colour would be a config nobody fills in
 * correctly, so one hex value produces the ramp.
 */

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function hexToRgb(hex: string): Rgb {
  const value = hex.replace('#', '');
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  return `#${[r, g, b].map((channel) => clamp(channel).toString(16).padStart(2, '0')).join('')}`;
}

/** Mix towards white (`amount > 0`) or black (`amount < 0`). */
function shade(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  const target = amount > 0 ? 255 : 0;
  const ratio = Math.abs(amount);
  return rgbToHex({
    r: r + (target - r) * ratio,
    g: g + (target - g) * ratio,
    b: b + (target - b) * ratio,
  });
}

/**
 * Relative luminance, per WCAG.
 *
 * Used to decide whether text on the brand colour should be white or near
 * black. Guessing wrong here is the single most common accessibility failure
 * in a themed design system, and it is entirely avoidable with eight lines of
 * arithmetic.
 */
function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (value: number): number => {
    const normalised = value / 255;
    return normalised <= 0.03928 ? normalised / 12.92 : ((normalised + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const lighter = Math.max(luminance(a), luminance(b));
  const darker = Math.min(luminance(a), luminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

/** Whichever of white and near-black reads better on the given background. */
export function readableOn(background: string): string {
  return contrastRatio(background, '#ffffff') >= contrastRatio(background, '#111318')
    ? '#ffffff'
    : '#111318';
}

const DEFAULT_ACCENT = '#1a56db';

/**
 * The token block injected into the document head.
 *
 * Emitted as a `<style>` element rather than an inline `style` attribute so it
 * can carry the CSP nonce — an inline attribute cannot, and would need
 * `style-src 'unsafe-inline'` to work at all.
 */
export function buildTokenCss(workspace: ResolvedWorkspaceConfig): string {
  const accent = workspace.brand.primaryColor ?? DEFAULT_ACCENT;
  const onAccent = readableOn(accent);

  const tokens: Record<string, string> = {
    /* Brand ramp, derived from one configured value. */
    '--color-accent': accent,
    '--color-accent-strong': shade(accent, -0.25),
    '--color-accent-soft': shade(accent, 0.88),
    '--color-accent-border': shade(accent, 0.7),
    '--color-on-accent': onAccent,

    /* Neutrals. A clean white base with a deep, slightly blue ink. */
    '--color-text': '#16181d',
    '--color-text-muted': '#5a6072',
    '--color-surface': '#ffffff',
    '--color-surface-raised': '#f7f8fa',
    '--color-border': '#e2e5ec',
    '--color-border-strong': '#c9cedb',

    /* Feedback. Fixed rather than derived: a brand colour must never be the
       only thing that says "this failed". */
    '--color-success': '#0f7b52',
    '--color-success-soft': '#e6f4ee',
    '--color-danger': '#b3261e',
    '--color-danger-soft': '#fdecea',
    '--color-warning': '#8a5a00',
    '--color-warning-soft': '#fdf3e2',

    /* Type. A system stack: no webfont means no render-blocking request and no
       layout shift when it arrives. */
    '--font-sans':
      "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans Bengali', sans-serif",
    '--font-size-sm': '0.875rem',
    '--font-size-base': '1rem',
    '--font-size-lg': '1.125rem',
    '--font-size-xl': '1.375rem',
    '--font-size-2xl': '1.75rem',
    '--font-size-3xl': '2.25rem',
    '--line-height-tight': '1.2',
    '--line-height-base': '1.65',

    /* Spacing, on a four-pixel grid. */
    '--space-2xs': '0.25rem',
    '--space-xs': '0.5rem',
    '--space-sm': '0.75rem',
    '--space-md': '1rem',
    '--space-lg': '1.5rem',
    '--space-xl': '2.5rem',
    '--space-2xl': '4rem',

    '--radius-sm': '4px',
    '--radius-md': '8px',
    '--radius-lg': '14px',
    '--radius-pill': '999px',

    '--shadow-sm': '0 1px 2px rgb(16 24 40 / 0.06)',
    '--shadow-md': '0 4px 12px rgb(16 24 40 / 0.08)',
    '--shadow-lg': '0 12px 32px rgb(16 24 40 / 0.1)',

    '--container-width': '72rem',
    '--measure': '68ch',
  };

  const declarations = Object.entries(tokens)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');

  return `:root {\n${declarations}\n}`;
}

/**
 * A contrast report for the launch checklist.
 *
 * A brand colour a client picked for a logo is not always a colour text can sit
 * on. This does not change it — that would be overriding a brand decision — it
 * reports it, so somebody chooses deliberately.
 */
export function auditBrandContrast(workspace: ResolvedWorkspaceConfig): {
  accent: string;
  onAccent: string;
  ratio: number;
  passesAA: boolean;
} {
  const accent = workspace.brand.primaryColor ?? DEFAULT_ACCENT;
  const onAccent = readableOn(accent);
  const ratio = contrastRatio(accent, onAccent);

  return {
    accent,
    onAccent,
    ratio: Math.round(ratio * 100) / 100,
    // 4.5:1 is the AA threshold for body text. Large text needs only 3:1, but
    // a button label is not reliably large text.
    passesAA: ratio >= 4.5,
  };
}
