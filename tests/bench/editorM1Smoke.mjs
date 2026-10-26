#!/usr/bin/env node
/**
 * The editor's milestone M1 and the platformer's scene-file checks, in Chromium (VISUAL_EDITOR_PLAN.md ED-3, ED-37,
 * Stage 2's M1). Each check prints PASS or FAIL with what it read; the exit code is the number of failures.
 *
 *   ED-3   the platformer loaded from levels/1-1.scene.json: each platform's components hold the file's x, y, width,
 *          height and tint (the declared defaults where the file has none)
 *   M1     on a scratch copy of 1-1 (levels/__m1-check.scene.json, removed after): Shift+E, a click selects a
 *          platform, a drag moves it, its Width field widens it, Ctrl+S writes the file through the dev server's
 *          route, and a fresh page that loads the file has the platform where it was left, that wide
 *   ED-37  1-1's player put on its goal: the contact loads 1-2 by a fast swap (the scene object kept, no full-load
 *          console line), with levelsDone 1
 *
 * The page is the bench page with ?src=1 (the source tree), served with the editor's routes (server/devRoutes.js).
 *
 *   node tests/bench/editorM1Smoke.mjs [--headed]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { handleDevRoute } from '../../server/devRoutes.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const LEVELS = '/demos/platformerGameScene/levels';
const SCRATCH = '__m1-check.scene.json';
const scratchPath = path.join(repoRoot, 'demos/platformerGameScene/levels', SCRATCH);
const W = 1280;
const H = 720;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

async function enginePage(browser, port, log) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on('pageerror', (error) => log.errors.push(String(error)));
  page.on('console', (message) => log.console.push(message.text()));
  await page.goto(`http://127.0.0.1:${port}/tests/bench/integratedWorkerBenchmark.html?src=1`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.dataset.benchmarkReady === 'true', undefined, { timeout: 30000 });
  await page.evaluate(
    async ({ W, H }) => {
      const { default: WEED } = await import('/src/index.js');
      if (typeof WEED.ensureEmbeddedSources === 'function') await WEED.ensureEmbeddedSources();
      const game = new WEED.GameEngine({ autoResize: false, canvasWidth: W, canvasHeight: H, injectStyles: false, debug: true });
      globalThis.__m1 = { WEED, game, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
    },
    { W, H },
  );
  return page;
}

/** Load a scene file and let it run `ms` (the player lands, the camera settles). */
const load = (page, url, ms, data) =>
  page.evaluate(
    async ({ url, ms, data }) => {
      const { game, sleep } = globalThis.__m1;
      await game.loadScene(url, data === undefined ? {} : { data });
      await sleep(ms);
    },
    { url, ms, data },
  );

/** Each platform the running file places: its record (with the declared defaults) and its components. */
const platformsOf = (page) =>
  page.evaluate(() => {
    const { WEED, game } = globalThis.__m1;
    const scene = game.currentScene;
    const { Transform, Collider, SpriteRenderer, Camera } = WEED;
    const Platform = scene.registeredClasses.find((r) => r.class.name === 'Platform').class;
    const d = Platform.spawnParams;
    return scene.sceneFile.entities
      .filter((record) => record.class === 'Platform')
      .map((record) => {
        const entity = scene.getByName(record.name);
        const i = entity ? entity.index : -1;
        const screen = i < 0 ? null : Camera.worldToScreen(Transform.x[i], Transform.y[i]);
        return {
          name: record.name,
          want: {
            x: record.x,
            y: record.y,
            width: record.config?.width ?? d.width.value,
            height: record.config?.height ?? d.height.value,
            tint: record.config?.tint ?? d.tint.value,
          },
          got:
            i < 0
              ? null
              : { x: Transform.x[i], y: Transform.y[i], width: Collider.width[i], height: Collider.height[i], tint: SpriteRenderer.baseTint[i] },
          screen: screen ? { x: screen.x, y: screen.y } : null,
        };
      });
  });

const same = (a, b) => a !== null && b !== null && Object.keys(a).every((k) => Math.abs(a[k] - b[k]) < 1e-3);

async function checkEd3(page) {
  await load(page, `${LEVELS}/1-1.scene.json`, 1500);
  const platforms = await platformsOf(page);
  const off = platforms.filter((p) => !same(p.want, p.got));
  check('ED-3 every platform of 1-1 has the file’s x, y, width, height and tint', platforms.length > 0 && off.length === 0,
    off.length ? off.map((p) => `${p.name} want ${JSON.stringify(p.want)} got ${JSON.stringify(p.got)}`).join('; ') : `${platforms.length} platforms`);
}

async function checkM1(browser, port, log) {
  fs.copyFileSync(path.join(repoRoot, 'demos/platformerGameScene/levels/1-1.scene.json'), scratchPath);
  let page = await enginePage(browser, port, log);
  await load(page, `${LEVELS}/${SCRATCH}`, 2500);

  await page.keyboard.press('Shift+E');
  await page.waitForTimeout(300);
  const editing = await page.evaluate(() => globalThis.__m1.game.debugUI.editing);
  check('M1 Shift+E enters edit mode', editing === true);

  // A platform away from the panels (the Editor panel on the left, the palette on the right) and the player.
  const view = await page.evaluate(() => {
    const { WEED, game } = globalThis.__m1;
    const scene = game.currentScene;
    const player = WEED.GameObject.instances[scene.playerIndex];
    const p = WEED.Camera.worldToScreen(player.x, player.y);
    return { zoom: WEED.Camera.zoom, player: { x: p.x, y: p.y } };
  });
  const platforms = await platformsOf(page);
  const farFromPlayer = (s) => {
    const dx = s.x - view.player.x;
    const dy = s.y - view.player.y;
    return Math.sqrt(dx * dx + dy * dy) > 90;
  };
  const target = platforms.find(
    (p) => p.screen && p.screen.x > 380 && p.screen.x < 980 && p.screen.y > 150 && p.screen.y < 680 && farFromPlayer(p.screen),
  );
  check('M1 a platform is in view to click', Boolean(target), target ? `${target.name} at ${target.screen.x.toFixed(0)}, ${target.screen.y.toFixed(0)}` : JSON.stringify(platforms.map((p) => p.screen)));
  if (!target) return page;

  await page.mouse.click(target.screen.x, target.screen.y);
  await page.waitForTimeout(200);
  const selected = await page.evaluate(() => globalThis.__m1.game.debugUI.editMode.selection.name);
  check('M1 a click selects it', selected === target.name, `selected ${selected}`);

  const dx = 120;
  const dy = 40;
  await page.mouse.move(target.screen.x, target.screen.y);
  await page.mouse.down();
  await page.mouse.move(target.screen.x + dx, target.screen.y + dy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const moved = await page.evaluate((name) => {
    const record = globalThis.__m1.game.currentScene.sceneFile.entities.find((e) => e.name === name);
    return { x: record.x, y: record.y };
  }, target.name);
  const wantX = target.want.x + Math.round(dx / view.zoom);
  const wantY = target.want.y + Math.round(dy / view.zoom);
  check('M1 a drag moves it (record and respawn)', Math.abs(moved.x - wantX) <= 1 && Math.abs(moved.y - wantY) <= 1,
    `${target.want.x},${target.want.y} → ${moved.x},${moved.y} (want about ${wantX},${wantY})`);

  const widthField = page.locator('div[data-key="width"] input[type="number"]');
  await widthField.fill('640');
  await widthField.press('Tab');
  await page.waitForTimeout(300);
  const widened = await page.evaluate((name) => {
    const { WEED, game } = globalThis.__m1;
    const scene = game.currentScene;
    const record = scene.sceneFile.entities.find((e) => e.name === name);
    const entity = scene.getByName(name);
    return { record: record.config?.width, collider: entity ? WEED.Collider.width[entity.index] : null };
  }, target.name);
  check('M1 the Width field widens it', widened.record === 640 && widened.collider === 640, JSON.stringify(widened));

  await page.keyboard.press('Control+s');
  const deadline = Date.now() + 5000;
  let saved = null;
  while (Date.now() < deadline) {
    const doc = JSON.parse(fs.readFileSync(scratchPath, 'utf8'));
    const record = doc.entities.find((e) => e.name === target.name);
    if (record && record.config?.width === 640 && record.x === moved.x && record.y === moved.y) {
      saved = record;
      break;
    }
    await page.waitForTimeout(100);
  }
  const status = await page.evaluate(() => globalThis.__m1.game.debugUI.editMode.status);
  check('M1 Ctrl+S writes the file', saved !== null, saved ? `${JSON.stringify(saved)}; indicator: ${status}` : `file unchanged; indicator: ${status}`);

  await page.close();
  page = await enginePage(browser, port, log);
  await load(page, `${LEVELS}/${SCRATCH}`, 1500);
  const after = (await platformsOf(page)).find((p) => p.name === target.name);
  check('M1 after a reload it is still there', after && after.got && Math.abs(after.got.x - moved.x) < 1e-3 && Math.abs(after.got.y - moved.y) < 1e-3 && after.got.width === 640,
    after ? JSON.stringify(after.got) : 'not found');
  return page;
}

async function checkEd37(page, log) {
  await load(page, `${LEVELS}/1-1.scene.json`, 1500, { levelsDone: 0 });
  const consoleFrom = log.console.length;
  const outcome = await page.evaluate(async () => {
    const { WEED, game, sleep } = globalThis.__m1;
    const before = game.currentScene;
    const goal = before.getByName('Goal1');
    const player = WEED.GameObject.instances[before.playerIndex];
    // Just above the goal: it falls onto it.
    player.setPosition(goal.x, goal.y - 140);
    const start = performance.now();
    while (performance.now() - start < 8000 && !String(game.currentScene.sceneFileUrl).endsWith('1-2.scene.json')) await sleep(100);
    const scene = game.currentScene;
    return { url: scene.sceneFileUrl, sameScene: scene === before, data: scene.data, ms: Math.round(performance.now() - start) };
  });
  const fullLoads = log.console.slice(consoleFrom).filter((line) => line.includes('loadScene: full load'));
  check('ED-37 the goal loads 1-2', String(outcome.url).endsWith('/levels/1-2.scene.json'), `${outcome.url} after ${outcome.ms} ms`);
  check('ED-37 by a fast swap', outcome.sameScene === true && fullLoads.length === 0, fullLoads.join(' | ') || 'scene object kept, no full-load line');
  check('ED-37 with what carries over', outcome.data?.levelsDone === 1, JSON.stringify(outcome.data));
}

async function main() {
  const headed = process.argv.includes('--headed');
  const server = await createStaticBenchmarkServer(repoRoot, 0, {
    before: (req, res, headers) => handleDevRoute(req, res, repoRoot, headers),
  });
  const browser = await chromium.launch({ headless: !headed });
  const log = { errors: [], console: [] };
  try {
    let page = await enginePage(browser, server.port, log);
    await checkEd3(page);
    await page.close();
    page = await checkM1(browser, server.port, log);
    await checkEd37(page, log);
    await page.close();
  } finally {
    await browser.close();
    await server.close();
    fs.rmSync(scratchPath, { force: true });
  }
  check('no page errors', log.errors.length === 0, log.errors.slice(0, 3).join(' | '));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exitCode = failed;
}

await main();
