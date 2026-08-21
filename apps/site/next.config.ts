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
    '@bos/sanitize',
    '@bos/sections',
    '@bos/seo',
    '@bos/validation',
  ],

  /**
   * Security headers that do not need a per-request value.
   *
   * The Content Security Policy is **not** here: it carries a nonce, which
   * must differ per response, so it is built in `middleware.ts`. A CSP in this
   * block would be the same string for every visitor, which makes the nonce
   * meaningless and the policy decorative.
   *
   * `frame-ancestors 'none'` (in the CSP) and `X-Frame-Options` both exist
   * because older browsers honour only one of them.
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
            /*
             * HSTS with `preload`.
             *
             * `includeSubDomains` binds every subdomain — app, api, assets —
             * to HTTPS permanently, and preload is effectively irreversible.
             * Both are correct here *only once every one of those subdomains
             * serves HTTPS*, which is a launch-checklist item rather than an
             * assumption. See docs/deployment/go-live.md.
             */
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
          // Nothing on the public site needs to read cross-origin resources.
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ];
  },

  images: {
    formats: ['image/avif', 'image/webp'],
  },

  /**
   * Redirects are tenant data, not build config — an editor changing a slug
   * must not need a deploy. They are served from the `redirects` table by
   * `middleware.ts`; see docs/architecture/08-deployment-topology.md.
   */
  poweredByHeader: false,

  /*
   * A build must not be able to ship past a type error by way of a config
   * flag. Stated explicitly because it defaults to false and is the first
   * thing reached for when a deploy is urgent.
   *
   * There is no `eslint` counterpart: Next 16 removed `next lint`, and linting
   * is a separate `pnpm lint` step in CI rather than something the build does.
   */
  typescript: { ignoreBuildErrors: false },
};

export default config;
