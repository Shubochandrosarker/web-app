import type { ResolvedWorkspaceConfig } from '@bos/business-types';

/**
 * The site footer.
 *
 * The NAP here is rendered from the workspace config — the same source the
 * LocalBusiness JSON-LD reads. The footer and the structured data cannot
 * disagree, because there is nowhere for them to disagree, and a mismatch
 * between visible and marked-up NAP is one of the few local-SEO problems that
 * is both common and entirely self-inflicted.
 */
export function SiteFooter({ workspace }: { workspace: ResolvedWorkspaceConfig }) {
  const { nap } = workspace;
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer">
      <div className="section-inner site-footer-inner">
        <div>
          <h2 className="site-footer-heading">{nap.displayName}</h2>
          <address>
            {nap.streetAddress}
            <br />
            {nap.addressLocality}
            {nap.addressRegion ? `, ${nap.addressRegion}` : ''}
            {nap.postalCode ? ` ${nap.postalCode}` : ''}
            <br />
            <a href={`tel:${nap.telephone}`}>{nap.telephone}</a>
            <br />
            <a href={`mailto:${nap.email}`}>{nap.email}</a>
          </address>
        </div>

        {nap.openingHours.length > 0 ? (
          <div>
            <h2 className="site-footer-heading">Opening hours</h2>
            <ul className="opening-hours">
              {nap.openingHours.map((hours) => (
                <li key={hours}>{hours}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {nap.sameAs.length > 0 ? (
          <div>
            <h2 className="site-footer-heading">Find us</h2>
            <ul className="site-footer-links">
              {nap.sameAs.map((url) => (
                <li key={url}>
                  <a href={url} rel="noopener noreferrer">
                    {/*
                      The hostname, not the full URL. "facebook.com" is what a
                      person is looking for; the rest is noise in a footer.
                    */}
                    {hostnameOf(url)}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="section-inner site-footer-legal">
        <p>
          © {year} {nap.legalName}
          {workspace.legal.registrationNumber ? ` · ${workspace.legal.registrationNumber}` : ''}.
        </p>
        {/*
          The independence disclaimer.
          A service that helps people obtain documents from an institution must
          not be mistakable for that institution — for the visitor's sake and
          because implying an affiliation that does not exist is exactly the
          kind of claim that gets a site treated as untrustworthy. It is
          rendered from configuration so a tenant that needs different wording
          can set it, and so a tenant that needs none has none.
        */}
        {workspace.legal.independenceDisclaimer ? (
          <p className="site-footer-disclaimer">{workspace.legal.independenceDisclaimer}</p>
        ) : null}
      </div>
    </footer>
  );
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
