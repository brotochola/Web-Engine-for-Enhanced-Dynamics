#!/usr/bin/env node
/**
 * The editor as its own package, against the engine's bundles (VISUAL_EDITOR_PLAN.md ED-29), in Chromium. The game
 * is the create-weed-game template's scene, which reads the engine from the global WEED as a game installed from npm
 * does. Each check prints PASS or FAIL; the exit code is the number of failures.
 *
 *   size       the engine's debug bundle carries none of the editor's code (it is in weed.editor.min.js)
 *   esm        an import map naming '@weed.js/engine' (the debug ESM bundle) and '@weed.js/editor'
 *              (weed.editor.esm.min.js): Shift+E loads the editor, whose modules are the engine's own (WEED_EDITOR_KIT):
 *              it selects the player, reading the engine's component arrays
 *   script     the UMD bundle and weed.editor.min.js as two script tags: the same
 *   missing    the engine alone: Shift+E says how to add the editor, and nothing breaks
 *   no src     neither bundle asks the server for /src/ (a game's server has no engine source)
 *
 * Needs the bundles: npm run make_bundle, then node scripts/buildEditor.js.
 *
 *   node scripts/smokeEditorBundle.mjs [--headed]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../tests/helpers/createStaticBenchmarkServer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCENE = '/packages/create-weed-game/template/src/gameScene.js';
const FILES = {
  debugUmd: 'dist/weed.bundle.min.js',
  debugEsm: 'dist/weed.bundle.esm.min.js',
  editorUmd: 'packages/editor/dist/weed.editor.min.js',
  editorEsm: 'packages/editor/dist/weed.editor.esm.min.js',
};

const results = [];
function check(name, ok, detail) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

for (const file of Object.values(FILES)) {
  if (!fs.existsSync(path.join(root, file))) {
    console.error(`Missing ${file}: npm run make_bundle, then node scripts/buildEditor.js`);
    process.exit(1);
  }
}

const start = `
  const game = new WEED.GameEngine({ debug: true });
  window.game = game;
  await game.loadScene(new URL('${SCENE}', location.href).href);
  window.__ready = true;`;
const PAGES = {
  '/__smoke/esm.html': `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{ "imports": { "@weed.js/engine": "/${FILES.debugEsm}", "@weed.js/editor": "/${FILES.editorEsm}" } }</script>
</head><body><script type="module">
  import WEED from '@weed.js/engine';${start}
</script></body></html>`,
  '/__smoke/script.html': `<!doctype html><html><head><meta charset="utf-8">
<script src="/${FILES.debugUmd}"></script><script src="/${FILES.editorUmd}"></script>
</head><body><script type="module">${start}
</script></body></html>`,
  '/__smoke/missing.html': `<!doctype html><html><head><meta charset="utf-8">
<script src="/${FILES.debugUmd}"></script>
</head><body><script type="module">${start}
</script></body></html>`,
};

const server = await createStaticBenchmarkServer(root, 0, {
  before: (req, res, headers) => {
    const page = PAGES[req.url.split('?')[0]];
    if (page === undefined) return false;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
    res.end(page);
    return true;
  },
});
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') });

/** Open a page, let its game run, press Shift+E; what the editor then is. */
async function run(name) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  const warnings = [];
  const srcRequests = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
    if (m.type() === 'warning') warnings.push(m.text());
  });
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (p.startsWith('/src/')) srcRequests.push(p);
  });
  await page.goto(`http://127.0.0.1:${server.port}/__smoke/${name}.html`);
  await page.waitForFunction(() => window.__ready === true, undefined, { timeout: 60000 });
  await page.waitForTimeout(1000);
  await page.mouse.click(600, 400); // the page has the keys
  await page.keyboard.press('Shift+E');
  await page.waitForFunction(() => window.game.debugUI.editing === true, undefined, { timeout: 5000 }).catch(() => {});
  const state = await page.evaluate(() => {
    const ui = window.game.debugUI;
    const editMode = ui.editMode;
    const out = { editing: ui.editing, kit: typeof globalThis.WEED_EDITOR_KIT, className: '', x: NaN, liveX: NaN };
    if (editMode) {
      const T = WEED.Transform;
      let player = -1;
      for (let i = 0; i < T.active.length && player < 0; i++) if (T.active[i]) player = i;
      editMode.selectFromList(player, false);
      out.className = editMode.selection.className;
      out.x = T.x[player];
      out.liveX = Number(document.querySelector('.debug-ui-inspector-prop input')?.value ?? NaN);
    }
    return out;
  });
  await page.close();
  return { ...state, errors, warnings, srcRequests };
}

try {
  const debugBundle = fs.readFileSync(path.join(root, FILES.debugUmd), 'utf8');
  const editorSize = fs.statSync(path.join(root, FILES.editorUmd)).size;
  const leaked = ['Copy to scene', 'Spawned by code, not by the scene file', 'Undid: '].filter((s) => debugBundle.includes(s));
  check(
    'size',
    leaked.length === 0,
    `weed.bundle.min.js ${(debugBundle.length / 1024).toFixed(0)} KB, with ${leaked.length ? leaked.join(', ') : 'no editor strings'}; weed.editor.min.js ${(editorSize / 1024).toFixed(1)} KB`,
  );

  const srcSeen = [];
  for (const name of ['esm', 'script']) {
    const r = await run(name);
    srcSeen.push(...r.srcRequests);
    check(
      name,
      r.editing && r.kit === 'object' && r.className === 'Player' && Number.isFinite(r.x) && r.errors.length === 0,
      `editing ${r.editing}, kit ${r.kit}, selected ${r.className || '(nothing)'} at x ${r.x?.toFixed?.(1)}, errors ${r.errors.length ? r.errors.slice(0, 2).join(' | ') : 'none'}`,
    );
  }
  const missing = await run('missing');
  srcSeen.push(...missing.srcRequests);
  check(
    'missing',
    !missing.editing && missing.warnings.some((w) => w.includes('@weed.js/editor')) && missing.errors.length === 0,
    `editing ${missing.editing}; ${missing.warnings.find((w) => w.includes('@weed.js/editor')) ?? 'no hint'}`,
  );
  check('no src', srcSeen.length === 0, srcSeen.slice(0, 3).join(', ') || 'no request for /src/');
} finally {
  await browser.close();
  await server.close();
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed;
