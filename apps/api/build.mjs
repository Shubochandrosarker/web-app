import { build } from 'esbuild';

/**
 * Bundle rather than `tsc`.
 *
 * Workspace packages ship TypeScript source, so `tsc` would emit an entrypoint
 * importing `@bos/database` and nothing that resolves it. esbuild inlines them
 * into one file, which also means the deployed artefact has no dependency on
 * pnpm's symlink layout surviving the copy to the server.
 *
 * Real npm dependencies stay external — bundling `pg` would break its native
 * bindings, and there is nothing to gain from inlining fastify. Everything not
 * listed is bundled, which is exactly the `@bos/*` workspace packages.
 *
 * (esbuild's `packages: 'external'` would externalise *every* bare specifier,
 * workspace packages included, leaving the output importing `.ts` source at
 * runtime. It has no `noExternal` counterpart — that is a tsup feature.)
 */
await build({
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: ['fastify', 'pg', 'drizzle-orm', 'zod'],
  logLevel: 'info',
  banner: {
    // Some CommonJS dependencies expect these to exist under ESM.
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
});
