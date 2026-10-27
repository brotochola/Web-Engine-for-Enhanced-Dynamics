/**
 * Build the @weed.js/editor package (VISUAL_EDITOR_PLAN.md ED-29, ED-30) into packages/editor/:
 *   dist/    weed.editor.min.js and weed.editor.esm.min.js (webpack.editor.config.js: the editor's modules, the
 *            engine's own read from WEED.editorKit)
 *   shell/   the editor page (src/core/debug/editor/shell/), served by a game's dev server at /__weed/editor/
 *   server/  the dev server's routes for the editor: saving and listing scene files (server/devRoutes.js) and the
 *            editor page (server/editorPage.js), for a game's scripts/dev.mjs
 * These are copies made for publishing, not tracked (packages/editor/.gitignore).
 *
 *   node scripts/buildEditor.js
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = path.join(rootDir, 'packages', 'editor');
const webpackCli = path.join(rootDir, 'node_modules', 'webpack-cli', 'bin', 'cli.js');

/** Copy the files of `from` (not its subfolders) into `to`, made empty first. */
function copyFolder(from, to, filter = () => true) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const file = path.join(from, name);
    if (fs.statSync(file).isFile() && filter(name)) fs.copyFileSync(file, path.join(to, name));
  }
}

export function buildEditor({ log = console.log } = {}) {
  log('Building the editor bundles (webpack.editor.config.js)…');
  execSync(`node "${webpackCli}" --config webpack.editor.config.js`, { cwd: rootDir, stdio: 'inherit' });
  copyFolder(path.join(rootDir, 'src/core/debug/editor/shell'), path.join(packageDir, 'shell'));
  const server = path.join(packageDir, 'server');
  copyFolder(path.join(rootDir, 'server'), server, (name) => name === 'devRoutes.js' || name === 'editorPage.js');
  fs.writeFileSync(
    path.join(server, 'index.js'),
    [
      '// The dev server routes of the WeedJS editor (VISUAL_EDITOR_PLAN.md ED-30): built by scripts/buildEditor.js.',
      "import path from 'path';",
      "import { fileURLToPath } from 'url';",
      "import { serveEditorPage as servePage } from './editorPage.js';",
      '',
      "export { handleDevRoute, resolveInside } from './devRoutes.js';",
      "export { EDITOR_ROUTE } from './editorPage.js';",
      '',
      "const SHELL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'shell');",
      '',
      '/** Serve the editor page at /__weed/editor/ from this package. Returns false for other requests. */',
      'export function serveEditorPage(req, res, { headers = {} } = {}) {',
      '  return servePage(req, res, { shellDir: SHELL, headers });',
      '}',
      '',
    ].join('\n'),
  );
  for (const name of ['weed.editor.min.js', 'weed.editor.esm.min.js']) {
    const size = fs.statSync(path.join(packageDir, 'dist', name)).size;
    log(`  dist/${name}: ${(size / 1024).toFixed(1)} KB`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildEditor();
