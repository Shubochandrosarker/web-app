import type { ResolvedWorkspaceConfig } from '@bos/business-types';

/**
 * The site header.
 *
 * A server component with no JavaScript. The mobile menu is a `<details>`
 * element, which opens and closes natively, is keyboard accessible, and is
 * announced correctly by a screen reader — none of which a hand-rolled
 * hamburger gets for free, and all of which it usually gets wrong.
 *
 * Navigation is a placeholder set until the navigation-menus module lands;
 * what matters here is that the header is real markup with a real
 * `contentinfo`/`banner` structure rather than a div.
 */
export function SiteHeader({ workspace }: { workspace: ResolvedWorkspaceConfig }) {
  const links = [
    { href: '/services', label: 'Services' },
    { href: '/about', label: 'About' },
    { href: '/contact', label: 'Contact' },
  ];

  const whatsapp = workspace.nap.whatsapp ?? workspace.nap.telephone;

  return (
    <header className="site-header">
      <div className="section-inner site-header-inner">
        <a href="/" className="site-brand">
          {workspace.brand.name}
        </a>

        <nav aria-label="Main">
          {/* Wide viewports: a plain list. */}
          <ul className="site-nav">
            {links.map((link) => (
              <li key={link.href}>
                <a href={link.href}>{link.label}</a>
              </li>
            ))}
          </ul>

          {/* Narrow viewports: the same links, behind a native disclosure. */}
          <details className="site-nav-mobile">
            <summary aria-label="Menu">
              <span aria-hidden="true">Menu</span>
            </summary>
            <ul>
              {links.map((link) => (
                <li key={link.href}>
                  <a href={link.href}>{link.label}</a>
                </li>
              ))}
            </ul>
          </details>
        </nav>

        {/*
          The call button is the header's primary action, because for this
          audience a phone call is the conversion. `tel:` and `wa.me` are both
          plain links — no widget, no script.
        */}
        <div className="site-header-actions">
          <a className="button" href={`tel:${workspace.nap.telephone}`}>
            Call
          </a>
          <a
            className="button button--primary"
            href={`https://wa.me/${whatsapp.replace(/[^\d]/g, '')}`}
            rel="noopener noreferrer"
          >
            WhatsApp
          </a>
        </div>
      </div>
    </header>
  );
}
