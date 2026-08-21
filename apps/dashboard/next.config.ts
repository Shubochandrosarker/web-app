import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    '@bos/business-types',
    '@bos/config',
    '@bos/validation',
    '@bos/sections',
    '@bos/sanitize',
  ],
  poweredByHeader: false,

  /**
   * The dashboard is deliberately a separate Next application from the public
   * site, not a route group inside it. The site's JavaScript budget is a
   * ranking-adjacent concern; the dashboard's is not. Sharing a build would
   * mean every chart library an admin screen pulls in has to be code-split
   * away from a landing page — a fight you lose slowly. Two builds, two
   * budgets, no fight.
   *
   * The Content Security Policy lives in `proxy.ts`, because it carries a
   * per-response nonce. What is here is everything that does not.
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          // An authenticated surface must never be cached by a shared proxy.
          { key: 'Cache-Control', value: 'no-store' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ];
  },

  typescript: { ignoreBuildErrors: false },
};

export default config;
