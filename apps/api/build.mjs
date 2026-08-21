import { build } from 'esbuild';

/**
 * Bundle rather than `tsc`.
 *
 * Workspace packages ship TypeScript source, so `tsc` would emit an entrypoint
 * importing `@bos/database` and nothing that resolves it. esbuild inlines them
 * into one file, which also means the deployed artefact has no dependency on
 * pnpm's symlink layout surviving the copy to the server.
 *
 * ## What is bundled, and what is not
 *
 * Exactly the `@bos/*` workspace packages are bundled. Everything else stays
 * external and is resolved from `node_modules` at runtime.
 *
 * That is expressed as a **rule** rather than a list, because a list rots: this
 * was `external: ['fastify', 'pg', 'drizzle-orm', 'zod']`, and adding
 * `@node-rs/argon2` — which loads a native `.node` binary esbuild has no loader
 * for — broke the build. The next native dependency would have broken it
 * again. Bundling a native module is never right, and bundling a third-party
 * pure-JS module buys nothing here, so the rule covers both cases for good.
 *
 * (esbuild's `packages: 'external'` looks like the answer and is not: it
 * externalises *every* bare specifier, workspace packages included, leaving
 * the output importing `.ts` source at runtime. It has no `noExternal`
 * counterpart — that is a tsup feature.)
 *
 * ## The consequence for package.json
 *
 * Because the workspace packages are inlined, **their runtime dependencies
 * become this app's runtime dependencies.** `@bos/sanitize` imports
 * `sanitize-html`; the bundle therefore contains an external import of it, and
 * `apps/api/package.json` has to declare it or the deployed process fails at
 * startup with `ERR_MODULE_NOT_FOUND`.
 *
 * pnpm's strict `node_modules` layout is what makes this a hard failure rather
 * than an accident that happens to work — and that is the right trade, because
 * the alternative is finding out in production. `pnpm --filter @bos/api run
 * check:deps` lists anything missing.
 */
const bundleOnlyWorkspacePackages = {
  name: 'bundle-only-workspace-packages',
  setup(pluginBuild) {
    // Any bare specifier — one that is not a path — is external unless it is
    // one of ours.
    pluginBuild.onResolve({ filter: /^[^./]|^\.[^./]|^\.\.[^/]/ }, (args) => {
      if (args.path.startsWith('@bos/')) return null;
      return { path: args.path, external: true };
    });
  },
};

await build({
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  plugins: [bundleOnlyWorkspacePackages],
  logLevel: 'info',
  banner: {
    // Some CommonJS dependencies expect these to exist under ESM.
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
});
