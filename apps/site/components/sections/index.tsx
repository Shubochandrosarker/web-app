import type { JSX } from 'react';
import type { ParsedSection, SectionType } from '@bos/sections';

/**
 * The section renderer registry.
 *
 * This is the other half of the schema-driven page builder: `@bos/sections`
 * defines what a section's data may contain, and this file decides how it
 * looks. An editor picks sections and fills in fields; they never choose
 * markup or spacing, which is what keeps every page on the design system.
 *
 * Adding a section type means adding a schema there and a renderer here. The
 * `satisfies` clause below makes a missing renderer a compile error rather
 * than a blank space in production.
 */

type Renderer<T extends SectionType> = (
  props: Extract<ParsedSection, { type: T }>['props'],
) => JSX.Element | null;

function Heading({
  eyebrow,
  heading,
  description,
}: {
  eyebrow?: string | undefined;
  heading: string;
  description?: string | undefined;
}) {
  return (
    <header className="section-heading">
      {eyebrow ? <p className="section-eyebrow">{eyebrow}</p> : null}
      <h2>{heading}</h2>
      {description ? <p className="section-description">{description}</p> : null}
    </header>
  );
}

const hero: Renderer<'hero'> = (props) => (
  <section className={`hero hero--${props.variant}`}>
    {props.eyebrow ? <p className="hero-eyebrow">{props.eyebrow}</p> : null}
    <h1>{props.heading}</h1>
    {/*
      The direct answer sits immediately under the H1 on service pages, before
      any marketing copy. A page that opens by answering the question it targets
      reads better for a human in a hurry and is easier to quote — see
      docs/architecture/04-seo-and-answer-engines.md.
    */}
    {props.answer ? <p className="hero-answer">{props.answer}</p> : null}
    {props.description ? <p className="hero-description">{props.description}</p> : null}
    {props.links.length > 0 ? (
      <div className="hero-actions">
        {props.links.map((link) => (
          <a
            key={link.href}
            href={link.href}
            className={link.primary ? 'button button--primary' : 'button'}
          >
            {link.label}
          </a>
        ))}
      </div>
    ) : null}
  </section>
);

const content: Renderer<'content'> = (props) => (
  // The editor sanitises on write, so this is already safe HTML. Sanitising
  // again on read would be a second, drifting definition of "safe".
  <section
    className={`prose prose--${props.layout}`}
    dangerouslySetInnerHTML={{ __html: props.html }}
  />
);

const faq: Renderer<'faq'> = (props) => (
  <section className="faq">
    <Heading eyebrow={props.eyebrow} heading={props.heading} description={props.description} />
    <dl>
      {props.items.map((item) => (
        <div key={item.question} className="faq-item">
          <dt>{item.question}</dt>
          <dd>{item.answer}</dd>
        </div>
      ))}
    </dl>
  </section>
);

const cta: Renderer<'cta'> = (props) => (
  <section className={`cta cta--${props.emphasis}`}>
    <Heading eyebrow={props.eyebrow} heading={props.heading} description={props.description} />
    <div className="cta-actions">
      {props.links.map((link) => (
        <a
          key={link.href}
          href={link.href}
          className={link.primary ? 'button button--primary' : 'button'}
        >
          {link.label}
        </a>
      ))}
    </div>
  </section>
);

const features: Renderer<'features'> = (props) => (
  <section className="features">
    <Heading eyebrow={props.eyebrow} heading={props.heading} description={props.description} />
    <ul className="features-grid">
      {props.items.map((item) => (
        <li key={item.title}>
          <h3>{item.title}</h3>
          <p>{item.description}</p>
        </li>
      ))}
    </ul>
  </section>
);

const processSection: Renderer<'process'> = (props) => (
  <section className="process">
    <Heading eyebrow={props.eyebrow} heading={props.heading} description={props.description} />
    <ol className="process-steps">
      {props.steps.map((step, index) => (
        <li key={step.title}>
          <span className="process-step-number">{index + 1}</span>
          <h3>{step.title}</h3>
          <p>{step.description}</p>
          {step.duration ? <p className="process-step-duration">{step.duration}</p> : null}
        </li>
      ))}
    </ol>
  </section>
);

const stats: Renderer<'stats'> = (props) => (
  <section className="stats">
    <Heading eyebrow={props.eyebrow} heading={props.heading} description={props.description} />
    <ul className="stats-grid">
      {props.items.map((item) => (
        <li key={item.label}>
          <strong>{item.value}</strong>
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  </section>
);

/**
 * Not yet implemented. Listed explicitly rather than omitted so the
 * exhaustiveness check below still holds — and so it is obvious from this file
 * alone what remains. Each is picked up by a Phase 2 task.
 */
const notYetImplemented =
  <T extends SectionType>(type: T): Renderer<T> =>
  () => {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[sections] "${type}" has no renderer yet; the section was skipped.`);
    }
    return null;
  };

/**
 * A renderer for every section type — no more, no fewer.
 *
 * `satisfies` against this mapped type is what makes a missing renderer a
 * compile error. (`Record<SectionType, Renderer<never>>` looks equivalent and
 * is not: props are contravariant, so nothing is assignable to `Renderer<never>`.)
 */
type SectionRenderers = { [T in SectionType]: Renderer<T> };

export const SECTION_RENDERERS = {
  hero,
  content,
  faq,
  cta,
  features,
  process: processSection,
  stats,
  'service-grid': notYetImplemented('service-grid'),
  testimonials: notYetImplemented('testimonials'),
  reviews: notYetImplemented('reviews'),
  pricing: notYetImplemented('pricing'),
  team: notYetImplemented('team'),
  locations: notYetImplemented('locations'),
  gallery: notYetImplemented('gallery'),
  logos: notYetImplemented('logos'),
  form: notYetImplemented('form'),
  'related-content': notYetImplemented('related-content'),
} satisfies SectionRenderers;

export function SectionList({ sections }: { sections: readonly ParsedSection[] }) {
  return (
    <>
      {sections.map((section) => {
        const render = SECTION_RENDERERS[section.type] as (props: unknown) => JSX.Element | null;
        return <div key={section.id}>{render(section.props)}</div>;
      })}
    </>
  );
}
