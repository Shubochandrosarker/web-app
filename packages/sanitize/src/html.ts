import sanitizeHtml from 'sanitize-html';
import { inspectUrl } from './url.ts';

/**
 * The one sanitisation boundary.
 *
 * The renderer uses `dangerouslySetInnerHTML`, and that is only defensible if
 * there is exactly one place where HTML becomes trusted. This is that place:
 * every write path — the CMS editor, the WordPress importer, a Markdown
 * conversion — passes through `sanitizeContentHtml` before the string reaches
 * the database. Nothing sanitises on read, because a second definition of
 * "safe" is a second definition that drifts.
 *
 * The allow-list is deliberately shaped around what SEO and accessibility
 * need: headings for document outline, tables for comparison content, figure
 * and figcaption for captioned images, and nothing that executes.
 *
 * "It came from WordPress" is not a provenance argument. A compromised or
 * merely careless WordPress install is exactly the source this exists for.
 */

/** Tags that survive sanitisation. Everything else is unwrapped or dropped. */
const ALLOWED_TAGS = [
  'p',
  'br',
  'hr',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'sub',
  'sup',
  'mark',
  'small',
  'abbr',
  'cite',
  'q',
  'blockquote',
  'code',
  'pre',
  'kbd',
  'samp',
  'var',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'a',
  'img',
  'figure',
  'figcaption',
  'picture',
  'source',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'colgroup',
  'col',
  'span',
  'div',
  'section',
  'article',
  'aside',
  'details',
  'summary',
  'time',
];

/**
 * `h1` is absent on purpose.
 *
 * The page's single H1 comes from the hero section, which is rendered from
 * structured data. A second one smuggled in through a content block breaks the
 * document outline and is invisible in the editor's preview.
 */
const DEMOTED_TAGS: Record<string, string> = { h1: 'h2' };

const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions['allowedAttributes'] = {
  a: ['href', 'title', 'target', 'rel', 'id'],
  img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'decoding', 'srcset', 'sizes'],
  source: ['srcset', 'sizes', 'type', 'media'],
  th: ['scope', 'colspan', 'rowspan', 'headers', 'id'],
  td: ['colspan', 'rowspan', 'headers'],
  col: ['span'],
  colgroup: ['span'],
  time: ['datetime'],
  abbr: ['title'],
  blockquote: ['cite'],
  q: ['cite'],
  details: ['open'],
  '*': ['id', 'lang', 'dir'],
};

/**
 * No `style` attribute anywhere.
 *
 * Inline styles are how a pasted Word document destroys a design system, and
 * `style` is also an XSS surface in older engines. Presentation belongs to the
 * design tokens; if content needs a visual treatment, it needs a section type.
 */
const ALLOWED_SCHEMES = ['https', 'http', 'mailto', 'tel'];

export interface SanitizeResult {
  /** Safe HTML, ready to store. */
  readonly html: string;
  /** Links and images dropped for an unsafe URL, for reporting to the editor. */
  readonly droppedUrls: readonly {
    readonly tag: string;
    readonly value: string;
    readonly reason: string;
  }[];
  /** True when sanitisation changed the input at all. */
  readonly modified: boolean;
}

/**
 * Sanitise HTML destined for a `content` section.
 *
 * Returns what was removed as well as what survived: silently discarding an
 * editor's link is a support ticket, and telling them "this link was rejected
 * because of its scheme" is the difference between a bug and a validation
 * message.
 */
export function sanitizeContentHtml(
  input: string,
  options: { siteOrigin?: string } = {},
): SanitizeResult {
  const droppedUrls: { tag: string; value: string; reason: string }[] = [];

  const html = sanitizeHtml(input, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ALLOWED_SCHEMES,
    allowedSchemesAppliedToAttributes: ['href', 'src', 'cite', 'srcset'],
    // A relative `src` or `href` carries no scheme to check; the URL policy
    // below decides whether it is acceptable.
    allowProtocolRelative: false,
    // Comments can carry conditional-comment payloads and, more mundanely,
    // whole drafts an editor thought were deleted.
    allowedClasses: {},
    disallowedTagsMode: 'discard',
    enforceHtmlBoundary: true,
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'template'],

    transformTags: {
      ...Object.fromEntries(
        Object.entries(DEMOTED_TAGS).map(([from, to]) => [
          from,
          sanitizeHtml.simpleTransform(to, {}),
        ]),
      ),

      a: (tagName, attribs) => {
        const href = attribs.href;
        if (href === undefined) return { tagName, attribs: {} };

        const verdict = inspectUrl(href);
        if (!verdict.safe || verdict.href === undefined) {
          droppedUrls.push({ tag: 'a', value: href, reason: verdict.reason ?? 'rejected' });
          // Unwrap rather than drop: the anchor text is content the editor
          // wrote and losing it would be a worse surprise than losing the link.
          return { tagName: 'span', attribs: {} };
        }

        const safe: Record<string, string> = { ...attribs, href: verdict.href };

        // An external link opened in a new tab without `noopener` hands the
        // opener window to the destination. Add it rather than reject the link.
        const isExternal =
          /^https?:/i.test(verdict.href) &&
          (options.siteOrigin === undefined || !verdict.href.startsWith(options.siteOrigin));

        if (safe.target === '_blank' || isExternal) {
          const rel = new Set((safe.rel ?? '').split(/\s+/).filter(Boolean));
          rel.add('noopener');
          rel.add('noreferrer');
          safe.rel = [...rel].join(' ');
        }

        return { tagName: 'a', attribs: safe };
      },

      img: (tagName, attribs) => {
        const src = attribs.src;
        if (src === undefined) return { tagName, attribs: {} };

        const verdict = inspectUrl(src);
        if (!verdict.safe || verdict.href === undefined) {
          droppedUrls.push({ tag: 'img', value: src, reason: verdict.reason ?? 'rejected' });
          return { tagName: 'span', attribs: {} };
        }

        return {
          tagName: 'img',
          attribs: {
            ...attribs,
            src: verdict.href,
            // Alt is required for accessibility and for the image sitemap; an
            // empty one at least declares the image decorative rather than
            // leaving a screen reader to read out the filename.
            alt: attribs.alt ?? '',
            loading: attribs.loading ?? 'lazy',
            decoding: attribs.decoding ?? 'async',
          },
        };
      },
    },
  });

  return { html, droppedUrls, modified: html !== input };
}

/**
 * Plain text from HTML, for excerpts and email fallbacks.
 *
 * Strips every tag rather than allow-listing, because the output is never
 * rendered as markup.
 */
export function htmlToPlainText(input: string): string {
  return sanitizeHtml(input, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Guard for values that are interpolated into a `<script type="application/ld+json">`.
 *
 * `</script>` inside a JSON string terminates the block and everything after it
 * becomes markup — the one way structured data turns into an injection.
 */
export function escapeJsonLd(json: string): string {
  return json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}
