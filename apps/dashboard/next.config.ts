import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@bos/business-types', '@bos/config', '@bos/validation'],
  poweredByHeader: false,

  /**
   * The dashboard is deliberately a separate Next application from the public
   * site, not a route group inside it. The site's JavaScript budget is a
   * ranking-adjacent concern; the dashboard's is not. Sharing a build would
   * mean every chart library an admin screen pulls in has to be code-split
   * away from a landing page — a fight you lose slowly. Two builds, two
   * budgets, no fight.
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
        ],
      },
    ];
  },
};

export default config;
