// npm run release -- patch | minor | major | <x.y.z>   [--otp <code>]
//
// The one place the version changes; commits leave it alone. In order, stopping at the first failure:
//  1. checks: on main, a clean tree, not behind origin/main, logged in to npm;
//  2. the new version into package.json and src/version.js, and the create-weed-game template's
//     engine range (^x.y.z), so a new game asks for the engine just published;
//  3. the 8 bundles (make_bundle), then every check: check:dist, the embed and browser smokes, the
//     node tests against the bundles, and the node suite;
//  4. one commit, "release vX.Y.Z", with exactly those files, and the tag vX.Y.Z;
//  5. npm publish, then git push of main and the tag.
// Before step 4 nothing is committed: `git checkout -- package.json src/version.js dist
// packages/create-weed-game/template/package.json` undoes a failed run.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_PACKAGE = 'packages/create-weed-game/template/package.json';

const args = process.argv.slice(2);
const otpAt = args.indexOf('--otp');
const otp = otpAt >= 0 ? args[otpAt + 1] : null;
const bump = args.find((a, i) => !a.startsWith('--') && (otpAt < 0 || i !== otpAt + 1));

function fail(message) {
  console.error(`\nrelease: ${message}`);
  process.exit(1);
}

/** Run a command in the repo, output shown; stop the release when it fails. */
function step(label, command, commandArgs) {
  console.log(`\n▶ ${label}`);
  const r = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) fail(`${label} failed (exit ${r.status}). Nothing is committed yet.`);
}

/** A command's trimmed stdout, or null when it fails. */
function read(command, commandArgs) {
  try {
    return execFileSync(command, commandArgs, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export function nextVersion(current, kind) {
  const [major, minor, patch] = current.split('.').map(Number);
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'major') return `${major + 1}.0.0`;
  if (/^\d+\.\d+\.\d+$/.test(kind || '')) return kind;
  return null;
}

function main() {
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const version = nextVersion(pkg.version, bump);
  if (!version) fail('say patch, minor, major or x.y.z: npm run release -- patch');
  if (version === pkg.version) fail(`${version} is the current version`);

  // 1. checks
  if (read('git', ['branch', '--show-current']) !== 'main') fail('release from main');
  if (read('git', ['status', '--porcelain'])) fail('the tree has uncommitted changes; commit or stash them first');
  if (read('git', ['fetch', 'origin']) === null) fail('git fetch origin failed');
  if (read('git', ['rev-list', '--count', 'HEAD..origin/main']) !== '0') fail('main is behind origin/main: pull first');
  const npmUser = read('npm', ['whoami']);
  if (!npmUser) fail('not logged in to npm: run npm login');
  console.log(`release: ${pkg.name} ${pkg.version} -> ${version}, publishing as ${npmUser}`);

  // 2. the version, and the template's engine range
  pkg.version = version;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  step('src/version.js', process.execPath, ['scripts/syncVersion.js']);
  const templatePath = path.join(root, TEMPLATE_PACKAGE);
  const template = fs.readFileSync(templatePath, 'utf8');
  const pinned = template.replace(/("@weed\.js\/engine":\s*")[^"]*(")/, `$1^${version}$2`);
  if (pinned === template && !template.includes(`"^${version}"`)) fail(`no @weed.js/engine range in ${TEMPLATE_PACKAGE}`);
  fs.writeFileSync(templatePath, pinned);

  // 3. the bundles, and every check
  step('build the bundles', 'npm', ['run', 'make_bundle']);
  step('dist matches the sources', process.execPath, ['scripts/assertDistFresh.js']);
  step('bundle embed smoke', process.execPath, ['scripts/smokeBundleEmbed.mjs']);
  step('bundle browser smoke', process.execPath, ['scripts/smokeBundleBrowser.mjs']);
  step('node tests on the bundles', 'npm', ['run', 'test:node:bundle']);
  step('node suite', 'npm', ['run', 'test:node']);

  // 4. commit and tag
  step('stage the release', 'git', ['add', 'package.json', 'src/version.js', 'dist', TEMPLATE_PACKAGE]);
  step('commit', 'git', ['commit', '-m', `release v${version}`]);
  step('tag', 'git', ['tag', '-a', `v${version}`, '-m', `release v${version}`]);

  // 5. publish, then push
  const publishArgs = ['publish', '--access', 'public', ...(otp ? ['--otp', otp] : [])];
  console.log('\n▶ npm publish');
  const published = spawnSync('npm', publishArgs, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (published.status !== 0) {
    fail(
      `npm publish failed. The release commit and tag v${version} are local. Fix it, then:\n` +
        `  npm publish --access public [--otp <code>]\n  git push origin main --follow-tags`,
    );
  }
  step('push main and the tag', 'git', ['push', 'origin', 'main', '--follow-tags']);
  console.log(`\nrelease: ${pkg.name}@${version} is on npm, and v${version} is on GitHub.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
