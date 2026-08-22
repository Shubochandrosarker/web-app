import { execFileSync } from 'node:child_process';

const patterns = ['*.ts', '*.tsx', '*.js', '*.mjs', '*.json', '*.md', '*.yml', '*.yaml'];
const run = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const names = new Set();
const collect = (args) => {
  try {
    for (const name of run(args).split(/\r?\n/).filter(Boolean)) names.add(name);
  } catch {
    // A shallow checkout may not have the requested base. The working-tree
    // and staged diffs below still give a useful changed-file check.
  }
};

const base = process.env.FORMAT_BASE_SHA;
if (base)
  collect(['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`, '--', ...patterns]);
// Pull-request checkouts commonly contain only the synthetic merge commit.
// Its first parent is the base even when the named base SHA is not present.
collect(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD^1', 'HEAD', '--', ...patterns]);
collect(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD', '--', ...patterns]);
collect(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '--', ...patterns]);

if (names.size === 0) {
  console.log('No changed files to format-check. Use pnpm format:check:all for the full tree.');
  process.exit(0);
}

const files = [...names].sort();
console.log(`Checking formatting for ${files.length} changed file(s).`);
execFileSync('pnpm', ['exec', 'prettier', '--check', ...files], {
  shell: process.platform === 'win32',
  stdio: 'inherit',
});
