import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getWorkspace } from '@/lib/workspace';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const workspace = await getWorkspace();
  return {
    // Every page's own title fills the %s. Set here so the brand suffix is
    // defined once rather than concatenated at each call site.
    title: { default: workspace.brand.name, template: `%s | ${workspace.brand.name}` },
    metadataBase: new URL(workspace.siteUrl),
    ...(workspace.brand.tagline ? { description: workspace.brand.tagline } : {}),
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const workspace = await getWorkspace();

  return (
    <html lang={workspace.locale.defaultLocale}>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <main id="main">{children}</main>
        {/*
          NAP is rendered from the workspace config — the same source the
          LocalBusiness schema reads. The footer and the structured data
          cannot disagree, because there is nowhere for them to disagree.
        */}
        <footer className="site-footer">
          <address>
            <strong>{workspace.nap.displayName}</strong>
            <br />
            {workspace.nap.streetAddress}, {workspace.nap.addressLocality}
            {workspace.nap.addressRegion ? `, ${workspace.nap.addressRegion}` : ''}
            <br />
            <a href={`tel:${workspace.nap.telephone}`}>{workspace.nap.telephone}</a>
            {' · '}
            <a href={`mailto:${workspace.nap.email}`}>{workspace.nap.email}</a>
          </address>
        </footer>
      </body>
    </html>
  );
}
