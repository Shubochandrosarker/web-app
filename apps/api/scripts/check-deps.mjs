import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every runtime dependency of a bundled workspace package must also be a
 * dependency of this app.
 *
 * The bundler inlines `@bos/*` source into `dist/server.js` and leaves every
 * other import external, so a package this app never mentions can still end up
 * as an `import` in the output. Under pnpm's strict layout that resolves to
 * nothing and the process exits at startup — in production, on the first
 * deploy after somebody added a dependency to a shared package.
 *
 * Runs before the build, so the failure is a build failure with a fix in the
 * message.
 */
const root = resolve(import.meta.dirname, '../../..');
const app = JSON.parse(readFileSync(resolve(root, 'apps/api/package.json'), 'utf8'));
const declared = new Set(Object.keys(app.dependencies ?? {}));

const missing = new Map();

for (const dependency of declared) {
  if (!dependency.startsWith('@bos/')) continue;

  const manifest = resolve(root, 'packages', dependency.replace('@bos/', ''), 'package.json');
  if (!existsSync(manifest)) continue;

  const bundled = JSON.parse(readFileSync(manifest, 'utf8'));
  for (const [name, range] of Object.entries(bundled.dependencies ?? {})) {
    // Workspace packages are bundled too, so their own names never appear as
    // an external import.
    if (name.startsWith('@bos/')) continue;
    if (!declared.has(name)) missing.set(name, { range, from: dependency });
  }
}

if (missing.size > 0) {
  console.error(
    'These are runtime dependencies of workspace packages the API bundles, but\n' +
      'the API does not declare them. The bundle will import them and the\n' +
      'deployed process will fail at startup.\n',
  );
  for (const [name, { range, from }] of missing) {
    console.error(`  ${name}@${range}   (from ${from})`);
  }
  console.error(`\nFix:\n  pnpm --filter @bos/api add ${[...missing.keys()].join(' ')}`);
  process.exit(1);
}
