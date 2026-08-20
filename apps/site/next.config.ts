import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,

  /**
   * Workspace packages ship TypeScript source rather than a build artefact, so
   * Next compiles them itself. One fewer build step, and a change in
   * @bos/sections shows up in dev without a rebuild.
   */
  transpilePackages: [
    '@bos/business-types',
    '@bos/config',
    '@bos/content',
    '@bos/sections',
    '@bos/seo',
    '@bos/validation',
  ],

  /**
   * The public site never sets a cookie of its own, so a strict CSP is
   * achievable from day one rather than retrofitted. `frame-ancestors 'none'`
   * and `X-Frame-Options` both appear because older browsers honour only one.
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },

  images: {
    formats: ['image/avif', 'image/webp'],
  },

  /**
   * Redirects are tenant data, not build config — an editor changing a slug
   * must not need a deploy. They are served from the `redirects` table by the
   * edge Worker; see docs/architecture/08-deployment-topology.md.
   */
  poweredByHeader: false,
};

export default config;
