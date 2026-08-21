import type { JSX, ReactNode } from 'react';
import type { ParsedSection, SectionType } from '@bos/sections';
import type {
  ResolvedForm,
  ResolvedLocation,
  ResolvedMedia,
  ResolvedPerson,
  ResolvedRelatedEntry,
  ResolvedReview,
  ResolvedService,
  SectionReferences,
} from '@bos/content';
import { EMPTY_REFERENCES, indexById } from '@bos/content';
import { ServiceRequestForm } from '@/components/form';

/**
 * The section renderer registry.
 *
 * The other half of the schema-driven page builder: `@bos/sections` defines
 * what a section's data may contain, and this file decides how it looks. An
 * editor picks sections and fills in fields; they never choose markup or
 * spacing, which is what keeps every page on the design system.
 *
 * Three rules every renderer here follows:
 *
 *  1. **Server component by default.** The only client component on a public
 *     page is the form, because it is the only thing that needs state. A
 *     carousel that ships 40 KB of JavaScript to show six logos is a Core Web
 *     Vitals regression bought with nothing.
 *
 *  2. **No renderer returns null for a registered type.** A section an editor
 *     placed and can see in the preview must appear on the page. Silently
 *     rendering nothing is the failure mode this file was rewritten to remove.
 *
 *  3. **Semantic markup, always.** Headings nest, lists are lists, addresses
 *     are `<address>`. It is what screen readers need and what makes the
 *     JSON-LD's claims match the visible page.
 */

/**
 * Reference data resolved server-side.
 *
 * Passed down through props rather than a context, so a renderer's inputs are
 * visible in its signature and it stays a pure function of them.
 */
export interface RenderContext {
  readonly references: SectionReferences;
  readonly workspaceSlug: string;
  readonly locale: string;
  readonly currency: string;
}

type Renderer<T extends SectionType> = (
  props: Extract<ParsedSection, { type: T }>['props'],
  context: RenderContext,
) => JSX.Element;

/* -------------------------------------------------------------- primitives */

function Heading({
  eyebrow,
  heading,
  description,
  level = 2,
}: {
  eyebrow?: string | undefined;
  heading: string;
  description?: string | undefined;
  level?: 2 | 3;
}) {
  const Tag = level === 2 ? 'h2' : 'h3';
  return (
    <header className="section-heading">
      {eyebrow ? <p className="section-eyebrow">{eyebrow}</p> : null}
      <Tag>{heading}</Tag>
      {description ? <p className="section-description">{description}</p> : null}
    </header>
  );
}

function Section({
  className,
  labelledBy,
  children,
}: {
  className: string;
  labelledBy?: string;
  children: ReactNode;
}) {
  return (
    <section className={className} {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}>
      <div className="section-inner">{children}</div>
    </section>
  );
}

function Button({
  href,
  primary,
  children,
}: {
  href: string;
  primary: boolean;
  children: ReactNode;
}) {
  const external = /^https?:/i.test(href);
  return (
    <a
      href={href}
      className={primary ? 'button button--primary' : 'button'}
      // An external link opened by a visitor should not hand this window to
      // the destination. Same reasoning as the sanitiser's `rel` handling.
      {...(external ? { rel: 'noopener noreferrer' } : {})}
    >
      {children}
    </a>
  );
}

/**
 * An image with its dimensions.
 *
 * `width` and `height` are always emitted when known, because the browser uses
 * them to reserve space before the bytes arrive. An image without them is the
 * most common single cause of a bad CLS score.
 */
function Media({
  media,
  alt,
  sizes,
  priority = false,
  className,
}: {
  media: ResolvedMedia | undefined;
  alt: string;
  sizes?: string;
  priority?: boolean;
  className?: string;
}) {
  if (!media) return null;

  /*
   * A plain `<img>`, not `next/image`.
   *
   * Media is served from the tenant's own Cloudflare origin under
   * content-addressed, immutable keys, already sized and already cached at the
   * edge. Routing it through the Next optimiser would put image processing on
   * the application server — the one Hostinger charges CPU for — to re-derive
   * what the CDN is already serving. The two things `next/image` genuinely
   * buys, explicit dimensions and lazy loading below the fold, are set here
   * directly.
   */
  /* eslint-disable @next/next/no-img-element -- see the note above */
  return (
    <img
      src={media.url}
      alt={alt || media.alt || ''}
      {...(media.width ? { width: media.width } : {})}
      {...(media.height ? { height: media.height } : {})}
      // The hero image is the LCP element on most pages, so it must not be
      // lazy — a lazy LCP image is a guaranteed 2.5s+ score.
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : 'auto'}
      decoding="async"
      {...(sizes ? { sizes } : {})}
      {...(className ? { className } : {})}
    />
  );
  /* eslint-enable @next/next/no-img-element */
}

/**
 * Money, formatted for the tenant's locale.
 *
 * Stored as integer minor units, so the division happens exactly once, here.
 */
function formatMoney(amount: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount / 100);
  } catch {
    // An unknown currency code should show a number, not crash the page.
    return `${(amount / 100).toLocaleString(locale)} ${currency}`;
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/* --------------------------------------------------------------- renderers */

const hero: Renderer<'hero'> = (props, context) => {
  const media = props.media
    ? indexById(context.references.media).get(props.media.mediaId)
    : undefined;

  return (
    <section className={`hero hero--${props.variant}`}>
      <div className="section-inner hero-inner">
        <div className="hero-copy">
          {props.eyebrow ? <p className="hero-eyebrow">{props.eyebrow}</p> : null}
          <h1>{props.heading}</h1>
          {/*
            The direct answer sits immediately under the H1 on service pages,
            before any marketing copy. A page that opens by answering the
            question it targets reads better for a human in a hurry and is
            easier to quote — see docs/architecture/04-seo-and-answer-engines.
          */}
          {props.answer ? <p className="hero-answer">{props.answer}</p> : null}
          {props.description ? <p className="hero-description">{props.description}</p> : null}
          {props.links.length > 0 ? (
            <div className="hero-actions">
              {props.links.map((link) => (
                <Button key={link.href} href={link.href} primary={link.primary}>
                  {link.label}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
        {media ? (
          <div className="hero-media">
            <Media
              media={media}
              alt={props.media?.alt ?? ''}
              priority
              sizes="(max-width: 60rem) 100vw, 40rem"
            />
          </div>
        ) : null}
      </div>
    </section>
  );
};

const content: Renderer<'content'> = (props) => (
  <section className={`prose prose--${props.layout}`}>
    <div className="section-inner">
      {/*
        The HTML below is sanitised by @bos/sanitize's `sanitizeContentHtml` at
        the CMS write boundary — see apps/api/src/routes/cms.ts. Sanitising
        again here would be a second, drifting definition of "safe", and would
        put an HTML parser on the render path of every page.
      */}
      {/* eslint-disable no-restricted-syntax -- sanitised at the CMS write boundary */}
      <div dangerouslySetInnerHTML={{ __html: props.html }} />
      {/* eslint-enable no-restricted-syntax */}
    </div>
  </section>
);

const serviceGrid: Renderer<'service-grid'> = (props, context) => {
  const byId = indexById(context.references.services);
  const services: ResolvedService[] =
    props.serviceIds.length > 0
      ? props.serviceIds
          .map((id) => byId.get(id))
          .filter((service): service is ResolvedService => service !== undefined)
      : [...context.references.services];

  const shown = services.slice(0, props.limit);
  const headingId = `services-${slugify(props.heading)}`;

  return (
    <Section className="service-grid" labelledBy={headingId}>
      <div id={headingId}>
        <Heading eyebrow={props.eyebrow} heading={props.heading} description={props.description} />
      </div>

      {shown.length === 0 ? (
        // An empty catalogue is a real state — a workspace being set up — and
        // it deserves an honest sentence rather than a blank band.
        <p className="section-empty">Our services will be listed here shortly.</p>
      ) : (
        <ul className={`card-grid card-grid--${props.columns}`}>
          {shown.map((service) => (
            <li key={service.id} className="card">
              <h3>{service.path ? <a href={service.path}>{service.name}</a> : service.name}</h3>
              {service.summary ? <p>{service.summary}</p> : null}

              {props.showPricing ? (
                <p className="card-price">
                  {service.priceAmount !== undefined && service.priceCurrency
                    ? formatMoney(service.priceAmount, service.priceCurrency, context.locale)
                    : (service.priceNote ?? 'Price on request')}
                </p>
              ) : null}

              {service.turnaroundNote ? (
                <p className="card-meta">{service.turnaroundNote}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
};

const features: Renderer<'features'> = (props) => {
  const headingId = `features-${slugify(props.heading)}`;
  return (
    <Section className="features" labelledBy={headingId}>
      <div id={headingId}>
        <Heading eyebrow={props.eyebrow} heading={props.heading} description={props.description} />
      </div>
      <ul className="card-grid card-grid--3">
        {props.items.map((item) => (
          <li key={item.title} className="card">
            {/*
              The icon is a decorative glyph the editor typed, so it is hidden
              from assistive technology — a screen reader announcing "check
              mark" before every feature title is noise.
            */}
            {item.icon ? (
              <span className="card-icon" aria-hidden="true">
                {item.icon}
              </span>
            ) : null}
            <h3>{item.title}</h3>
            <p>{item.description}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
};

/**
 * FAQ.
 *
 * `<details>`/`<summary>` rather than a JavaScript accordion: it collapses and
 * expands natively, it is keyboard accessible without a single line of script,
 * and the answers are in the DOM whether or not anything is expanded — which
 * matters both for a crawler and for a visitor using find-on-page.
 */
const faq: Renderer<'faq'> = (props) => {
  const headingId = `faq-${slugify(props.heading)}`;
  return (
    <Section className="faq" labelledBy={headingId}>
      <div id={headingId}>
        <Heading eyebrow={props.eyebrow} heading={props.heading} description={props.description} />
      </div>
      <div className="faq-list">
        {props.items.map((item) => (
          <details key={item.question} className="faq-item" name="faq">
            <summary>
              <h3>{item.question}</h3>
            </summary>
            <div className="faq-answer">
              <p>{item.answer}</p>
            </div>
          </details>
        ))}
      </div>
    </Section>
  );
};

const testimonials: Renderer<'testimonials'> = (props, context) => {
  const media = indexById(context.references.media);
  const headingId = `testimonials-${slugify(props.heading)}`;

  return (
    <Section className="testimonials" labelledBy={headingId}>
      <div id={headingId}>
        <Heading eyebrow={props.eyebrow} heading={props.heading} description={props.description} />
      </div>
      <ul className="card-grid card-grid--3">
        {props.items.map((item) => (
          <li key={`${item.authorName}-${item.quote.slice(0, 24)}`} className="card testimonial">
            {/*
              `<figure>`/`<figcaption>` rather than a div and a paragraph: the
              attribution is semantically the caption of the quotation, and
              `<blockquote>` is what a quotation is.
            */}
            <figure>
              <blockquote>
                <p>{item.quote}</p>
              </blockquote>
              <figcaption>
                {item.media ? (
                  <Media
                    media={media.get(item.media.mediaId)}
                    alt={item.media.alt}
                    className="avatar"
                  />
                ) : null}
                <span>
                  <strong>{item.authorName}</strong>
                  {item.authorRole ? <span className="muted"> · {item.authorRole}</span> : null}
                </span>
              </figcaption>
            </figure>
          </li>
        ))}
      </ul>
      {/*
        Deliberately no rating and no Review markup. These are quotations an
        editor typed; treating them as verified reviews is the misuse that gets
        structured data ignored. The `reviews` section is the one backed by the
        reputation module.
      */}
    </Section>
  );
};

const reviews: Renderer<'reviews'> = (props, context) => {
  const shown: ResolvedReview[] = context.references.reviews
    .filter((review) => review.rating >= props.minRating)
    .filter((review) => props.source === 'internal' || review.source === props.source)
    .slice(0, props.limit);

  const headingId = `reviews-${slugify(props.heading)}`;

  return (
    <Section className="reviews" labelledBy={headingId}>
      <div id={headingId}>
        <Heading eyebrow={props.eyebrow} heading={props.heading} description={props.description} />
      </div>

      {shown.length === 0 ? (
        <p className="section-empty">There are no published reviews yet.</p>
      ) : (
        <ul className="card-grid card-grid--3">
          {shown.map((review) => (
            <li key={review.id} className="card review">
              <p className="review-rating">
                {/*
                  The rating is announced as text and drawn as stars. A row of
                  glyphs alone tells a screen reader nothing.
                */}
                <span aria-hidden="true">{'★'.repeat(Math.round(review.rating))}</span>
                <span className="visually-hidden">{review.rating} out of 5</span>
              </p>
              <p>{review.body}</p>
              <p className="card-meta">
                <strong>{review.authorName}</strong>
                {' · '}
                <time dateTime={review.publishedAt}>
                  {new Date(review.publishedAt).toLocaleDateString(context.locale, {
                    year: 'numeric',
                    month: 'long',
                  })}
                </time>
              </p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
};

const cta: Renderer<'cta'> = (props) => {
  const headingId = `cta-${slugify(props.heading)}`;
  return (
    <Section className={`cta cta--${props.emphasis}`} labelledBy={headingId}>
      <div id={headingId}>
        <Heading eyebrow={props.eyebrow} heading={props.heading} description={props.description} />
      </div>
      <div className="cta-actions">
        {props.links.map((link) => (
          <Button key={link.href} href={link.href} primary={link.primary}>
            {link.label}
          </Button>
        ))}
      </div>
    </Section>
  );
};

const pricing: Renderer<'pricing'> = (props, context) => {
  const headingId = `pricing-${slugify(props.heading)}`;
  return (
    <Section className="pricing" labelledBy={headingId}>
      <div id={headingId}>
        <Heading eyebrow={props.eyebrow} heading={props.heading} description={props.description} />
      </div>
      <ul className={`card-grid card-grid--${Math.min(props.tiers.length, 3)}`}>
        {props.tiers.map((tier) => (
          <li key={tier.name} className={tier.highlighted ? 'card card--highlighted' : 'card'}>
            <h3>{tier.name}</h3>
            <p className="price">
              {tier.amount !== undefined && tier.currency ? (
                <>
                  <strong>{formatMoney(tier.amount, tier.currency, context.locale)}</strong>
                  {tier.period ? <span className="muted"> / {tier.period}</span> : null}
                </>
              ) : (
                // "On request" is a real answer, and a better one than an
                // invented number.
                <strong>On request</strong>
              )}
            </p>
            {tier.features.length > 0 ? (
              <ul className="tick-list">
                {tier.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
            ) : null}
            {tier.link ? (
              <Button href={tier.link.href} primary={tier.link.primary}>
                {tier.link.label}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {props.note ? <p className="section-note">{props.note}</p> : null}
    </Section>
  );
};

const processSection: Renderer<'process'> = (props) => {
  const headingId = `process-${slugify(props.heading)}`;
  return (
    <Section className="process" labelledBy={headingId}>
      <div id={headingId}>
        <Heading eyebrow={props.eyebrow} heading={props.heading} description={props.description} />
      </div>
      {/*
        An ordered list, because the order is the meaning. The numbers are
        drawn by CSS from the list itself rather than typed in, so inserting a
        step in the middle cannot leave "1, 2, 2, 4".
      */}
      <ol className="process-steps">
        {props.steps.map((step) => (
          <li key={step.title}>
            <h3>{step.title}</h3>
            <p>{step.description}</p>
            {step.duration ? <p className="process-step-duration">{step.duration}</p> : null}
          </li>
        ))}
      </ol>
    </Section>
  );
};

const stats: Renderer<'stats'> = (props) => {
  const headingId = `stats-${slugify(props.heading)}`;
  return (
    <Section className="stats" labelledBy={headingId}>
      <div id={headingId}>
        <Heading eyebrow={props.eyebrow} heading={props.heading} description={props.description} />
      </div>
      {/*
        A description list: each figure is a value and each label is its term.
        That is exactly what `dl` means, and it is what makes the pairing
        survive being read aloud.
      */}
      <dl className="stats-grid">
        {props.items.map((item) => (
          <div key={item.label} className="stat">
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
};

const team: Renderer<'team'> = (props, context) => {
  const byId = indexById(context.references.people);
  const people: ResolvedPerson[] =
    props.personIds.length > 0
      ? props.personIds
          .map((id) => byId.get(id))
          .filter((person): person is ResolvedPerson => person !== undefined)
      : [...context.references.people];

  const shown = people.slice(0, props.limit);
  const headingId = `team-${slugify(props.heading)}`;

  return (
    <Section className="team" labelledBy={headingId}>
      <div id={headingId}>
        <Heading eyebrow={props.eyebrow} heading={props.heading} description={props.description} />
      </div>

      {shown.length === 0 ? (
        <p className="section-empty">Our team will be introduced here shortly.</p>
      ) : (
        <ul className="card-grid card-grid--3">
          {shown.map((person) => (
            <li key={person.id} className="card person">
              {person.media ? (
                <Media media={person.media} alt={`${person.name}`} className="person-photo" />
              ) : null}
              <h3>{person.name}</h3>
              {person.role ? <p className="card-meta">{person.role}</p> : null}
              {person.bio ? <p>{person.bio}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
};

const locations: Renderer<'locations'> = (props, context) => {
  const byId = indexById(context.references.locations);
  const shown: ResolvedLocation[] =
    props.locationIds.length > 0
      ? props.locationIds
          .map((id) => byId.get(id))
          .filter((location): location is ResolvedLocation => location !== undefined)
      : [...context.references.locations];

  const headingId = `locations-${slugify(props.heading)}`;

  return (
    <Section className="locations" labelledBy={headingId}>
      <div id={headingId}>
        <Heading eyebrow={props.eyebrow} heading={props.heading} description={props.description} />
      </div>

      {shown.length === 0 ? (
        <p className="section-empty">Our address will be published here shortly.</p>
      ) : (
        <ul className="card-grid card-grid--2">
          {shown.map((location) => (
            <li key={location.id} className="card location">
              <h3>{location.displayName}</h3>
              {/*
                A real `<address>`. This is the NAP that LocalBusiness schema
                claims, and the two are rendered from the same row — so they
                cannot disagree, which is the whole point of resolving the
                location server-side rather than retyping it into a content
                block.
              */}
              <address>
                {location.streetAddress}
                <br />
                {location.addressLocality}
                {location.addressRegion ? `, ${location.addressRegion}` : ''}
                {location.postalCode ? ` ${location.postalCode}` : ''}
                <br />
                <a href={`tel:${location.telephone}`}>{location.telephone}</a>
                <br />
                <a href={`mailto:${location.email}`}>{location.email}</a>
              </address>

              {location.openingHours.length > 0 ? (
                <ul className="opening-hours">
                  {location.openingHours.map((hours) => (
                    <li key={hours}>{hours}</li>
                  ))}
                </ul>
              ) : null}

              {/*
                A link to a map, never an embedded one. An iframe from a maps
                provider is a third-party script, a cookie and about 900 KB on
                a page whose job is to show an address.
              */}
              {props.showMap && location.mapUrl ? (
                <a href={location.mapUrl} rel="noopener noreferrer" className="button">
                  View on a map
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
};

const gallery: Renderer<'gallery'> = (props, context) => {
  const media = indexById(context.references.media);
  const headingId = `gallery-${slugify(props.heading)}`;

  /*
   * Carousel is rendered as a scroll-snapping row rather than a JavaScript
   * slider. It swipes on a phone, scrolls with a trackpad, and works with the
   * keyboard — with no script at all.
   */
  return (
    <Section className={`gallery gallery--${props.layout}`} labelledBy={headingId}>
      <div id={headingId}>
        <Heading eyebrow={props.eyebrow} heading={props.heading} description={props.description} />
      </div>
      <ul className="gallery-items">
        {props.items.map((item) => (
          <li key={item.mediaId}>
            <Media
              media={media.get(item.mediaId)}
              alt={item.alt}
              sizes="(max-width: 40rem) 50vw, 25vw"
            />
          </li>
        ))}
      </ul>
    </Section>
  );
};

const logos: Renderer<'logos'> = (props, context) => {
  const media = indexById(context.references.media);
  const headingId = `logos-${slugify(props.heading)}`;

  return (
    <Section className="logos" labelledBy={headingId}>
      <div id={headingId}>
        <Heading eyebrow={props.eyebrow} heading={props.heading} description={props.description} />
      </div>
      <ul className="logo-row">
        {props.items.map((item) => (
          <li key={item.mediaId}>
            <Media media={media.get(item.mediaId)} alt={item.alt} />
          </li>
        ))}
      </ul>
    </Section>
  );
};

const form: Renderer<'form'> = (props, context) => {
  const definition: ResolvedForm | undefined = context.references.forms.find(
    (candidate) => candidate.id === props.formId,
  );

  const headingId = `form-${slugify(props.heading)}`;

  return (
    <Section className={`form-section form-section--${props.layout}`} labelledBy={headingId}>
      <div id={headingId}>
        <Heading eyebrow={props.eyebrow} heading={props.heading} description={props.description} />
      </div>

      {definition ? (
        <ServiceRequestForm
          form={definition}
          workspaceSlug={context.workspaceSlug}
          locale={context.locale}
        />
      ) : (
        /*
         * A form whose definition could not be resolved — deleted, disabled,
         * or in another workspace. Saying so beats rendering an empty band a
         * visitor stares at.
         */
        <p className="section-empty">
          This form is not available at the moment. Please call or message us instead.
        </p>
      )}
    </Section>
  );
};

const relatedContent: Renderer<'related-content'> = (props, context) => {
  const byId = indexById(context.references.related);
  const shown: ResolvedRelatedEntry[] = props.contentEntryIds
    .map((id) => byId.get(id))
    .filter((entry): entry is ResolvedRelatedEntry => entry !== undefined)
    .slice(0, props.limit);

  const headingId = `related-${slugify(props.heading)}`;

  return (
    <Section className="related-content" labelledBy={headingId}>
      <div id={headingId}>
        <Heading eyebrow={props.eyebrow} heading={props.heading} description={props.description} />
      </div>

      {shown.length === 0 ? (
        <p className="section-empty">Related pages will appear here.</p>
      ) : (
        <ul className="card-grid card-grid--3">
          {shown.map((entry) => (
            <li key={entry.id} className="card">
              {entry.media ? <Media media={entry.media} alt="" /> : null}
              <h3>
                <a href={entry.path}>{entry.title}</a>
              </h3>
              {entry.excerpt ? <p>{entry.excerpt}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
};

/**
 * A renderer for every section type — no more, no fewer.
 *
 * `satisfies` against this mapped type is what makes a missing renderer a
 * compile error. (`Record<SectionType, Renderer<never>>` looks equivalent and
 * is not: props are contravariant, so nothing is assignable to
 * `Renderer<never>`.)
 */
type SectionRenderers = { [T in SectionType]: Renderer<T> };

export const SECTION_RENDERERS = {
  hero,
  content,
  'service-grid': serviceGrid,
  features,
  faq,
  testimonials,
  reviews,
  cta,
  pricing,
  process: processSection,
  stats,
  team,
  locations,
  gallery,
  logos,
  form,
  'related-content': relatedContent,
} satisfies SectionRenderers;

export function SectionList({
  sections,
  context,
}: {
  sections: readonly ParsedSection[];
  context?: RenderContext;
}) {
  const renderContext: RenderContext = context ?? {
    references: EMPTY_REFERENCES,
    workspaceSlug: '',
    locale: 'en',
    currency: 'USD',
  };

  return (
    <>
      {sections.map((section) => {
        const render = SECTION_RENDERERS[section.type] as (
          props: unknown,
          context: RenderContext,
        ) => JSX.Element;
        return <div key={section.id}>{render(section.props, renderContext)}</div>;
      })}
    </>
  );
}
