#!/usr/bin/env node
/**
 * The editor's Bake atlas and Export, in Chromium (VISUAL_EDITOR_PLAN.md ED-31, ED-32). Each check prints PASS or FAIL
 * with what it read; the exit code is the number of failures.
 *
 *   ED-31  the platformer's atlas, baked from the running scene through the dev server's file route, is a PNG of the
 *          canvas's size and the scene's atlas JSON (written to a folder under scratch/, removed after)
 *   ED-32  the palette's Export button (in edit mode) exports the platformer through POST /__weed/export: index.html,
 *          vendor/weed.js (the engine bundle given, byte for byte), game.min.js, assets/, _headers
 *          the export, served alone (its own folder, COOP/COEP), loads 1-1 with the production engine: no debug UI,
 *          the class names kept, the baked atlas loaded and kept as a canvas, the canvas drawn, nothing fetched from
 *          outside the export and nothing missing; the player put on the goal loads 1-2 by a fast swap (no full-load
 *          line, levelsDone 1)
 *
 * The engine the export ships is the production bundle of this tree's sources, built into a temporary folder
 * (WEED_DIST_DIR, about 2 minutes; dist/ is not touched), or the one --engine names. The dev page is the bench page with
 * ?src=1, served with the editor's routes (server/devRoutes.js). Every temporary folder is removed at the end
 * (--keep keeps the export and prints where it is).
 *
 *   node tests/bench/editorExportSmoke.mjs [--engine <folder with weed.prod.bundle.min.js>] [--headed] [--keep]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { analyzePng, captureCanvasPng } from '../helpers/visualPngCompare.mjs';
import { handleDevRoute } from '../../server/devRoutes.js';
import { ENGINE_BUNDLE_FILE } from '../../server/exportGame.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const LEVELS = '/demos/platformerGameScene/levels';
const W = 1280;
const H = 720;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

/** The production bundle of this tree, built into `dir` (scripts/buildBundle.js with WEED_DIST_DIR). */
async function buildEngine(dir) {
  console.log(`Building the engine bundles into ${dir} (about 2 minutes)…`);
  const started = Date.now();
  const log = fs.createWriteStream(path.join(dir, 'build.log'));
  const child = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'buildBundle.js')], {
    cwd: repoRoot,
    env: { ...process.env, WEED_DIST_DIR: path.join(dir, 'dist') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const code = await new Promise((resolve) => child.on('exit', resolve));
  if (code !== 0) throw new Error(`the engine build failed (exit ${code}): see ${path.join(dir, 'build.log')}`);
  console.log(`  built in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  return path.join(dir, 'dist', ENGINE_BUNDLE_FILE);
}

async function devPage(browser, port, log) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on('pageerror', (error) => log.errors.push(`dev: ${error}`));
  await page.goto(`http://127.0.0.1:${port}/tests/bench/integratedWorkerBenchmark.html?src=1`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.dataset.benchmarkReady === 'true', undefined, { timeout: 30000 });
  await page.evaluate(
    async ({ W, H, url }) => {
      const { default: WEED } = await import('/src/index.js');
      const game = new WEED.GameEngine({ autoResize: false, canvasWidth: W, canvasHeight: H, injectStyles: false, debug: true });
      globalThis.__exportSmoke = { WEED, game };
      await game.loadScene(url);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    },
    { W, H, url: `${LEVELS}/1-1.scene.json` },
  );
  return page;
}

/** ED-31: bake through the real route, into scratch/<folder>/ (the scene's own folder is demos/, left alone). */
async function checkBake(page, folder) {
  const baked = await page.evaluate(async (folder) => {
    const { bakeAtlas } = await import('/src/core/debug/editor/atlasBake.js');
    const scene = globalThis.__exportSmoke.game.currentScene;
    // The scene, as if its module were in the scratch folder: the bake goes beside the module.
    const stand = Object.create(scene, { sceneScriptUrl: { value: `${location.origin}/scratch/${folder}/scene.js` } });
    const done = await bakeAtlas(stand);
    return { ...done, canvas: { w: scene.bigAtlasCanvas.width, h: scene.bigAtlasCanvas.height }, json: JSON.stringify(scene.bigAtlasJson) };
  }, folder);
  const pngFile = path.join(repoRoot, 'scratch', folder, 'PlatformerGameScene.atlas.png');
  const png = fs.existsSync(pngFile) ? fs.readFileSync(pngFile) : Buffer.alloc(0);
  const isPng = png.length > 24 && png.readUInt32BE(0) === 0x89504e47;
  const size = isPng ? { w: png.readUInt32BE(16), h: png.readUInt32BE(20) } : null;
  check('ED-31 the bake is a PNG of the atlas canvas’s size', isPng && size.w === baked.canvas.w && size.h === baked.canvas.h,
    `${baked.png}: ${png.length} bytes, ${size ? `${size.w} × ${size.h}` : 'not a PNG'} (canvas ${baked.canvas.w} × ${baked.canvas.h})`);
  const jsonFile = path.join(repoRoot, 'scratch', folder, 'PlatformerGameScene.atlas.json');
  const json = fs.existsSync(jsonFile) ? fs.readFileSync(jsonFile, 'utf8') : '';
  check('ED-31 and its JSON is the scene’s atlas JSON', json === baked.json, `${Object.keys(JSON.parse(baked.json).frames).length} frames; ${baked.assets}`);
  return baked;
}

/** ED-32: the palette's Export button, in edit mode. */
async function checkExportButton(page, outDir, engineBundle) {
  await page.keyboard.press('Shift+E');
  const button = page.locator('button[title^="Build this game"]');
  await button.waitFor({ state: 'visible', timeout: 10000 });
  await button.click();
  const finished = await page
    .waitForFunction(() => {
      const note = globalThis.__exportSmoke.game.debugUI?.editMode?.palette?.ship?._note?.textContent || '';
      return note.startsWith('Exported to') || /failed|cannot|error/i.test(note);
    }, undefined, { timeout: 60000 })
    .then(() => true, () => false);
  const note = await page.evaluate(() => globalThis.__exportSmoke.game.debugUI.editMode.palette.ship._note.textContent);
  check('ED-32 the Export button exports the running game', finished && note.startsWith('Exported to'), note);
  const want = ['index.html', 'game.min.js', 'vendor/weed.js', '_headers', 'weed-sw.js', 'assets/PlatformerGameScene.atlas.png', 'assets/PlatformerGameScene.atlas.json'];
  const missing = want.filter((f) => !fs.existsSync(path.join(outDir, f)));
  const assets = listFiles(path.join(outDir, 'assets'));
  check('ED-32 the export’s layout', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `assets/: ${assets.join(', ')}`);
  const vendorSame = fs.existsSync(path.join(outDir, 'vendor/weed.js')) && fs.readFileSync(path.join(outDir, 'vendor/weed.js')).equals(fs.readFileSync(engineBundle));
  const game = fs.existsSync(path.join(outDir, 'game.min.js')) ? fs.readFileSync(path.join(outDir, 'game.min.js'), 'utf8') : '';
  check('ED-32 vendor/weed.js is the engine bundle, game.min.js the game alone', vendorSame && game.length > 0 && !/EditMode|__weedEditorHost|\/src\//.test(game),
    `vendor ${vendorSame ? 'byte for byte' : 'DIFFERS'}; game.min.js ${(game.length / 1024).toFixed(1)} KB`);
}

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}

/** The export, served alone: it loads 1-1 with the production engine, and its goal swaps to 1-2. */
async function checkExportedGame(browser, outDir, baked, log) {
  const server = await createStaticBenchmarkServer(outDir, 0);
  const origin = `http://127.0.0.1:${server.port}`;
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const requests = [];
  const failed = [];
  const consoleLines = [];
  page.on('pageerror', (error) => log.errors.push(`export: ${error}`));
  page.on('console', (message) => consoleLines.push(message.text()));
  page.on('request', (r) => requests.push(r.url()));
  page.on('response', (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });
  page.on('requestfailed', (r) => failed.push(`failed ${r.url()}`));
  try {
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    const loaded = await page
      .waitForFunction(() => {
        const scene = window.game?.currentScene;
        return Boolean(scene && window.game.state === 1 && !document.getElementById('loading') && String(scene.sceneFileUrl).endsWith('/levels/1-1.scene.json'));
      }, undefined, { timeout: 90000 })
      .then(() => true, () => false);
    const loadingText = await page.evaluate(() => document.getElementById('loading')?.textContent ?? '');
    check('ED-32 the export loads 1-1', loaded, loaded ? '' : `loading line: ${loadingText}`);
    if (!loaded) return;
    await page.waitForTimeout(1500);

    const state = await page.evaluate(() => {
      const { WEED, game } = window;
      const scene = game.currentScene;
      const placed = scene.sceneFile.entities.map((e) => e.name);
      return {
        bundle: WEED.BUNDLE_MODE === true,
        debugUI: Boolean(game.debugUI),
        sceneName: scene.constructor.name,
        classes: scene.registeredClasses.map((r) => r.class.name),
        components: [...new Set(scene.registeredClasses.flatMap((r) => WEED.GameObject._collectComponents(r.class).map((c) => c.name)))],
        placed: placed.length,
        live: placed.filter((name) => scene.getByName(name) !== null).length,
        atlas: scene.bigAtlasCanvas ? { w: scene.bigAtlasCanvas.width, h: scene.bigAtlasCanvas.height } : null,
        bigAtlas: scene.constructor.assets.bigAtlas,
      };
    });
    check('ED-32 with the production engine, no debug UI', state.bundle && !state.debugUI, `BUNDLE_MODE ${state.bundle}, debugUI ${state.debugUI}`);
    const names = ['PlatformerGameScene', 'BluePlatformerPlayer', 'Platform', 'Goal', 'PlatformerCharacterComponent'];
    const seen = [state.sceneName, ...state.classes, ...state.components];
    check('ED-32 class names kept', names.every((n) => seen.includes(n)), `${state.sceneName}; ${state.classes.join(', ')}; ${state.components.join(', ')}`);
    check('ED-32 every entity 1-1 places is live', state.placed > 0 && state.live === state.placed, `${state.live} / ${state.placed}`);
    check('ED-32 the baked atlas is loaded, and its canvas kept outside debug mode',
      state.atlas !== null && state.atlas.w === baked.canvas.w && state.atlas.h === baked.canvas.h && String(state.bigAtlas?.png).endsWith('/assets/PlatformerGameScene.atlas.png'),
      `${JSON.stringify(state.atlas)} from ${state.bigAtlas?.png}`);
    const drawn = await analyzePng(page, await captureCanvasPng(page));
    check('ED-32 it draws', drawn.nonBlack >= 100, `${drawn.nonBlack} of ${drawn.pixels} pixels not black`);

    const consoleFrom = consoleLines.length;
    const outcome = await page.evaluate(async () => {
      const { WEED, game } = window;
      const before = game.currentScene;
      const goal = before.getByName('Goal1');
      const player = WEED.GameObject.instances[before.playerIndex];
      player.setPosition(goal.x, goal.y - 140); // just above the goal: it falls onto it
      const start = performance.now();
      while (performance.now() - start < 10000 && !String(game.currentScene.sceneFileUrl).endsWith('1-2.scene.json')) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const scene = game.currentScene;
      return { url: scene.sceneFileUrl, sameScene: scene === before, data: scene.data, ms: Math.round(performance.now() - start) };
    });
    const fullLoads = consoleLines.slice(consoleFrom).filter((line) => line.includes('loadScene: full load'));
    check('ED-32 the goal loads 1-2 from game.min.js', String(outcome.url).endsWith('/levels/1-2.scene.json'), `${outcome.url} after ${outcome.ms} ms`);
    check('ED-32 by a fast swap', outcome.sameScene === true && fullLoads.length === 0, fullLoads.join(' | ') || 'scene object kept, no full-load line');
    check('ED-32 with what carries over', outcome.data?.levelsDone === 1, JSON.stringify(outcome.data));

    const outside = requests.filter((u) => !u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:'));
    check('ED-32 nothing fetched from outside the export, nothing missing', outside.length === 0 && failed.length === 0,
      [...outside, ...failed].slice(0, 5).join(' | ') || `${requests.length} requests, all to the export`);
  } finally {
    await page.close();
    await server.close();
  }
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-export-smoke-'));
  const scratchName = path.basename(work);
  const scratchDir = path.join(repoRoot, 'scratch', scratchName);
  fs.mkdirSync(scratchDir, { recursive: true });
  const outDir = path.join(work, 'export');
  const log = { errors: [] };
  let browser = null;
  let server = null;
  try {
    const given = option('--engine');
    const engineBundle = given ? path.join(path.resolve(given), ENGINE_BUNDLE_FILE) : await buildEngine(work);
    if (!fs.existsSync(engineBundle)) throw new Error(`no engine bundle at ${engineBundle}`);
    server = await createStaticBenchmarkServer(repoRoot, 0, {
      before: (req, res, headers) => handleDevRoute(req, res, repoRoot, headers, { export: { outDir, engineBundle } }),
    });
    browser = await chromium.launch({ headless: !flag('--headed') });
    const page = await devPage(browser, server.port, log);
    const baked = await checkBake(page, scratchName);
    await checkExportButton(page, outDir, engineBundle);
    await page.close();
    await checkExportedGame(browser, outDir, baked, log);
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
    fs.rmSync(scratchDir, { recursive: true, force: true });
    if (flag('--keep')) console.log(`kept: ${outDir}`);
    else fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  check('no page errors', log.errors.length === 0, log.errors.slice(0, 3).join(' | '));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exitCode = failed;
}

await main();
