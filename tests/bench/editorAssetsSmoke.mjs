#!/usr/bin/env node
/**
 * The editor's Assets dock in Chromium (VISUAL_EDITOR_PLAN.md ED-65, ED-66), in the editor page on the dev server's
 * short route (/editor?scene=…). Each check prints PASS or FAIL with what it read; the exit code is the number of
 * failures. Nothing is saved: the checks read the dock and the document in memory, and undo what they place.
 *
 *   littlecity pictures      (ED-65) every class row has a 32 px picture with pixels drawn; the houses, trees, people
 *                            and cars show what a live one of them shows (its sprite from the atlas)
 *   littlecity drag          (ED-66) a CityTree dragged from the dock onto the view while the game plays (Chromium's
 *                            own drag and drop, from the editor page into the game's frame): edit mode is entered, one
 *                            more tree is placed where it was dropped (the click's mapping of that point) and
 *                            selected, as one undo; Ctrl+Z takes it out
 *   platformergame pictures  (ED-65) the platforms and the goal are their tinted bars (live), the player (an Adobe
 *                            Animate character, no sprite) its initials
 *   platformergame drag      (ED-66) in edit mode on a 16 px grid, a Platform dragged onto the view: while it is over
 *                            the view the overlay draws its landing cross on the grid; dropped, one more platform
 *                            there, selected, as one undo; Ctrl+Z takes it out; + then a click still places a Goal
 *   game page drag           (ED-66) the platformer's own page (no editor page), Shift+E: a Goal dragged from the
 *                            floating palette onto the canvas is placed at the drop point; Ctrl+Z takes it out
 *   predator filter         (ED-65) its 18 classes get a filter field; "drop" leaves the Drop classes, Esc clears it
 *
 * Screenshots go to D:\tmp\claude\editor-assets\ (never the repository).
 *
 *   node tests/bench/editorAssetsSmoke.mjs [--headed]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { handleDevRoute } from '../../server/devRoutes.js';
import { serveEditorPage } from '../../server/editorPage.js';
import { parseArgs } from './microbenchHelpers.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const SHELL_DIR = path.join(repoRoot, 'src/core/debug/editor/shell');
const SHOTS = 'D:/tmp/claude/editor-assets';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

/** The game page's frame (the editor page's iframe). */
const gameFrame = (page) => page.frames().find((f) => f.parentFrame() === page.mainFrame());

async function gameReady(page, { sceneFile = true } = {}) {
  await page.waitForFunction(() => window.__weedEditorHost?.connected === true, undefined, { timeout: 60000 });
  await page.waitForFunction(
    (sceneFile) => {
      const game = document.getElementById('game').contentWindow.game;
      return !!(game && game.state === 1 && game.currentScene && (!sceneFile || game.currentScene.sceneFile));
    },
    sceneFile,
    { timeout: 60000 },
  );
  await page.waitForFunction(() => document.querySelectorAll('[data-slot=assets] [data-class-name]').length > 0, undefined, {
    timeout: 30000,
  });
}

/** Each class row of the dock: its name, its count, its picture's title and how many of its pixels are drawn. */
const readRows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-slot=assets] [data-class-name]')].map((row) => {
      const thumb = row.querySelector('canvas');
      const box = thumb.getBoundingClientRect();
      const pixels = thumb.getContext('2d').getImageData(0, 0, thumb.width, thumb.height).data;
      let drawn = 0;
      for (let k = 3; k < pixels.length; k += 4) if (pixels[k] > 0) drawn++;
      return {
        name: row.dataset.className,
        shown: row.style.display !== 'none',
        count: row.querySelector('[data-count]')?.textContent ?? null,
        title: thumb.title,
        size: Math.round(box.width),
        drawn,
        live: thumb.title.endsWith('as a live one shows it'),
      };
    }),
  );

/** A screenshot of the dock's class list, scrolled into view. */
async function shootClasses(page, file) {
  const list = page.locator('[data-slot=assets] [data-class-name]').first().locator('..');
  await list.scrollIntoViewIfNeeded();
  await list.screenshot({ path: `${SHOTS}/${file}` });
}

/** The editor's state and the document's records of a class, read through the iframe. */
const readEditor = (page, className) =>
  gameFrame(page).evaluate((className) => {
    const editMode = window.game.debugUI.editMode;
    const records = (window.game.currentScene.sceneFile?.entities || []).filter((e) => e.class === className);
    const last = records.at(-1) ?? null;
    return {
      active: editMode.active,
      selection: editMode.selection.name,
      records: records.length,
      last: last === null ? null : { name: last.name, x: last.x, y: last.y },
      undo: editMode.history._done.at(-1)?.label ?? null,
      undoCount: editMode.history._done.length,
      snap: editMode.move.snap,
    };
  }, className);

/** The world point a click at a page point maps to (Mouse's mapping: the canvas's box, then scene.camera). */
const worldAt = (page, x, y) =>
  page.evaluate(
    async ({ x, y }) => {
      const frame = document.getElementById('game').getBoundingClientRect();
      const win = document.getElementById('game').contentWindow;
      const { viewPointToWorld } = await win.eval('import("/src/core/debug/editor/dropPlace.js")');
      const point = viewPointToWorld(x - frame.left, y - frame.top, win.game.canvas.getBoundingClientRect(), win.game.currentScene.camera, {
        x: 0,
        y: 0,
      });
      return { x: point.x, y: point.y };
    },
    { x, y },
  );

/**
 * Until the drawn view (scene.camera, what a click and a drop map through) has not moved for 400 ms: entering edit mode
 * and a zoom ease in (Found item 23), and a point mapped before that is not where a drop lands.
 * @param {import('playwright').Page|import('playwright').Frame} target - where window.game is
 */
async function settled(target) {
  await target.waitForFunction(
    () => {
      const c = window.game.currentScene.camera;
      const key = `${c.x},${c.y},${c.zoom},${c.rotation}`;
      const now = performance.now();
      const s = (window.__smokeView ??= { key: '', since: now });
      if (s.key !== key) {
        s.key = key;
        s.since = now;
        return false;
      }
      return now - s.since > 400;
    },
    undefined,
    { timeout: 20000, polling: 50 },
  );
}

/** The view's middle, in the editor page's coordinates. */
async function viewMiddle(page) {
  const box = await page.locator('#game').boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * A mouse drag from a dock row's picture to a page point: Chromium's own HTML5 drag and drop, from the editor page into
 * the game's frame. With `hold`, what the drop placer had (the overlay's cross) after holding still over the point.
 */
async function dragRowTo(page, className, to, { hold = 0 } = {}) {
  const thumb = page.locator(`[data-slot=assets] [data-class-name="${className}"] canvas`);
  await thumb.scrollIntoViewIfNeeded();
  const from = await thumb.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 4, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  let during = null;
  if (hold > 0) {
    await page.waitForTimeout(hold);
    during = await gameFrame(page).evaluate(() => {
      const editMode = window.game.debugUI.editMode;
      const drops = editMode.palette.drops;
      return { overlay: editMode.wantsOverlay(), x: drops.x, y: drops.y, dragging: drops.dragging };
    });
    await page.screenshot({ path: `${SHOTS}/platformer-dragging.png` });
  }
  await page.mouse.up();
  await page.waitForTimeout(400);
  return during;
}

/** Ctrl+Z typed in the editor page (the scene list has the focus). */
async function undo(page) {
  await page.locator('[data-slot=tree]').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(300);
}

async function openEditor(browser, origin, scene, errors) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
  page.on('pageerror', (error) => errors.push(`${scene}: ${String(error)}`));
  page.on('console', (message) => {
    // The test server has no hot reload route: the game page's EventSource gets a 404, as on any static server.
    if (message.type() === 'error' && !message.text().includes('404')) errors.push(`${scene}: ${message.text()}`);
  });
  await page.goto(`${origin}/editor?scene=${scene}`);
  return page;
}

async function littleCity(browser, origin, errors) {
  const page = await openEditor(browser, origin, 'littlecity', errors);
  await gameReady(page);
  await page.waitForTimeout(1500);

  // ---- pictures (ED-65) ----
  const rows = await readRows(page);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  const liveOnes = ['CityHouse', 'CityTree', 'CityPerson', 'TrafficCar'];
  await shootClasses(page, 'littlecity-classes.png');
  check(
    'littlecity pictures',
    rows.length >= 4 &&
      rows.every((r) => r.size === 32 && r.drawn > 30) &&
      liveOnes.every((name) => byName[name]?.live === true) &&
      byName.CityHouse.count === '65 / 80',
    rows.map((r) => `${r.name} ${r.size}px ${r.drawn} px drawn (${r.title.split(': ')[1]}) ${r.count}`).join('; '),
  );

  // ---- a tree dragged onto the view while the game plays (ED-66) ----
  const before = await readEditor(page, 'CityTree');
  const middle = await viewMiddle(page);
  const target = { x: middle.x + 37, y: middle.y - 23 };
  await settled(gameFrame(page)); // littleCity follows nothing: the view stays while it plays
  const aimed = await worldAt(page, target.x, target.y);
  await dragRowTo(page, 'CityTree', target);
  const after = await readEditor(page, 'CityTree');
  await page.screenshot({ path: `${SHOTS}/littlecity-dropped.png` });
  const step = Math.max(after.snap, 1);
  const near =
    after.last !== null && Math.abs(after.last.x - aimed.x) <= step / 2 + 0.5 && Math.abs(after.last.y - aimed.y) <= step / 2 + 0.5;
  await undo(page);
  const undone = await readEditor(page, 'CityTree');
  check(
    'littlecity drag',
    !before.active &&
      after.active &&
      after.records === before.records + 1 &&
      near &&
      after.selection === after.last.name &&
      after.undoCount === before.undoCount + 1 &&
      after.undo === `place ${after.last.name}` &&
      undone.records === before.records,
    `playing ${!before.active} → editing ${after.active}; trees ${before.records} → ${after.records} → after Ctrl+Z ` +
      `${undone.records}; ${after.last?.name} at ${after.last?.x}, ${after.last?.y} for a drop at ${aimed.x.toFixed(1)}, ` +
      `${aimed.y.toFixed(1)} (grid ${after.snap}); selected ${after.selection}; undo "${after.undo}"`,
  );
  await page.close();
}

async function platformer(browser, origin, errors) {
  const page = await openEditor(browser, origin, 'platformergame', errors);
  await gameReady(page);
  await page.waitForTimeout(1500);

  // ---- pictures (ED-65) ----
  const rows = await readRows(page);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  await shootClasses(page, 'platformer-classes.png');
  check(
    'platformergame pictures',
    rows.length === 3 &&
      rows.every((r) => r.size === 32 && r.drawn > 30) &&
      byName.Platform?.live === true &&
      byName.Goal?.live === true &&
      /no picture yet/.test(byName.BluePlatformerPlayer?.title),
    rows.map((r) => `${r.name} ${r.drawn} px drawn (${r.title.split(': ')[1]}) ${r.count}`).join('; '),
  );

  // ---- a platform dragged onto the view in edit mode, on a 16 px grid (ED-66) ----
  await page.click('[data-slot=toolbar] button:has-text("Edit")');
  await gameFrame(page).evaluate(() => {
    window.game.debugUI.editMode.move.snap = 16;
    return true;
  });
  await settled(gameFrame(page));
  const before = await readEditor(page, 'Platform');
  const middle = await viewMiddle(page);
  const target = { x: middle.x - 61, y: middle.y + 47 };
  const aimed = await worldAt(page, target.x, target.y);
  const during = await dragRowTo(page, 'Platform', target, { hold: 300 });
  const after = await readEditor(page, 'Platform');
  await page.screenshot({ path: `${SHOTS}/platformer-dropped.png` });
  const onGrid = after.last !== null && after.last.x % 16 === 0 && after.last.y % 16 === 0;
  const near = after.last !== null && Math.abs(after.last.x - aimed.x) <= 8 && Math.abs(after.last.y - aimed.y) <= 8;
  await undo(page);
  const undone = await readEditor(page, 'Platform');
  // + then a click on the view still places.
  await page.locator('[data-slot=assets] [data-class-name="Goal"] [data-place]').click();
  const goalBefore = await readEditor(page, 'Goal');
  await page.mouse.click(middle.x + 80, middle.y - 40);
  await page.waitForTimeout(300);
  const goalAfter = await readEditor(page, 'Goal');
  await page.keyboard.press('Escape');
  await undo(page);
  const goalUndone = await readEditor(page, 'Goal');
  check(
    'platformergame drag',
    during !== null &&
      during.overlay &&
      during.dragging === 'Platform' &&
      during.x === after.last?.x &&
      during.y === after.last?.y &&
      after.records === before.records + 1 &&
      onGrid &&
      near &&
      after.selection === after.last.name &&
      after.undo === `place ${after.last.name}` &&
      after.undoCount === before.undoCount + 1 &&
      undone.records === before.records &&
      goalAfter.records === goalBefore.records + 1 &&
      goalUndone.records === goalBefore.records,
    `over the view: overlay ${during?.overlay}, cross at ${during?.x}, ${during?.y}; platforms ${before.records} → ` +
      `${after.records} → after Ctrl+Z ${undone.records}; ${after.last?.name} at ${after.last?.x}, ${after.last?.y} for a ` +
      `drop at ${aimed.x.toFixed(1)}, ${aimed.y.toFixed(1)} (grid 16); selected ${after.selection}; undo "${after.undo}"; ` +
      `+ and a click: goals ${goalBefore.records} → ${goalAfter.records} → ${goalUndone.records}`,
  );
  await page.close();
}

/** The game page alone (no editor page): Shift+E's floating palette, a Goal dragged onto the canvas. */
async function gamePageAlone(browser, origin, errors) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
  page.on('pageerror', (error) => errors.push(`game page: ${String(error)}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('404')) errors.push(`game page: ${message.text()}`);
  });
  await page.goto(`${origin}/demos/index.html?scene=platformergame`);
  await page.waitForFunction(() => !!(window.game?.state === 1 && window.game.currentScene?.sceneFile), undefined, { timeout: 60000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    window.game.debugUI.toggleEditMode(); // Shift+E
    return true;
  });
  await page.waitForFunction(() => document.querySelectorAll('[data-class-name]').length === 3, undefined, { timeout: 30000 });
  await settled(page);
  const read = () =>
    page.evaluate(() => {
      const editMode = window.game.debugUI.editMode;
      const goals = window.game.currentScene.sceneFile.entities.filter((e) => e.class === 'Goal');
      const last = goals.at(-1);
      return { active: editMode.active, goals: goals.length, last: { name: last.name, x: last.x, y: last.y }, selection: editMode.selection.name };
    });
  const before = await read();
  const canvas = await page.evaluate(() => {
    const r = window.game.canvas.getBoundingClientRect();
    return { x: r.left + r.width * 0.4, y: r.top + r.height * 0.6 };
  });
  const aimed = await page.evaluate(async ({ x, y }) => {
    const { viewPointToWorld } = await import('/src/core/debug/editor/dropPlace.js');
    return viewPointToWorld(x, y, window.game.canvas.getBoundingClientRect(), window.game.currentScene.camera, { x: 0, y: 0 });
  }, canvas);
  const thumb = page.locator('[data-class-name="Goal"] canvas');
  const from = await thumb.boundingBox();
  await page.mouse.move(from.x + 16, from.y + 16);
  await page.mouse.down();
  await page.mouse.move(from.x + 26, from.y + 20, { steps: 3 });
  await page.mouse.move(canvas.x, canvas.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await read();
  await page.screenshot({ path: `${SHOTS}/game-page-dropped.png` });
  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(300);
  const undone = await read();
  check(
    'game page drag',
    after.active &&
      after.goals === before.goals + 1 &&
      Math.abs(after.last.x - aimed.x) <= 1 &&
      Math.abs(after.last.y - aimed.y) <= 1 &&
      after.selection === after.last.name &&
      undone.goals === before.goals,
    `the floating palette's Goal dropped on the canvas: goals ${before.goals} → ${after.goals} → after Ctrl+Z ${undone.goals}; ` +
      `${after.last.name} at ${after.last.x}, ${after.last.y} for a drop at ${aimed.x.toFixed(1)}, ${aimed.y.toFixed(1)}; selected ${after.selection}`,
  );
  await page.close();
}

async function predator(browser, origin, errors) {
  const page = await openEditor(browser, origin, 'predator', errors);
  await gameReady(page, { sceneFile: false });
  await page.waitForTimeout(1000);
  const filter = page.locator('[data-slot=assets] input[type=search]');
  const present = (await filter.count()) === 1;
  const all = (await readRows(page)).length;
  let narrowed = [];
  let cleared = 0;
  if (present) {
    await filter.fill('drop');
    narrowed = (await readRows(page)).filter((r) => r.shown).map((r) => r.name);
    await filter.scrollIntoViewIfNeeded();
    await page.locator('[data-slot=assets]').screenshot({ path: `${SHOTS}/predator-filter.png` });
    await filter.press('Escape');
    cleared = (await readRows(page)).filter((r) => r.shown).length;
  }
  check(
    'predator filter',
    present && all > 8 && narrowed.length > 0 && narrowed.length < all && narrowed.every((n) => /drop/i.test(n)) && cleared === all,
    `${all} classes, filter ${present}; "drop": ${narrowed.join(', ')}; Esc: ${cleared} shown`,
  );
  await page.close();
}

async function main() {
  const args = parseArgs();
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await createStaticBenchmarkServer(repoRoot, 0, {
    before: (req, res, headers) =>
      handleDevRoute(req, res, repoRoot, headers) ||
      serveEditorPage(req, res, { shellDir: SHELL_DIR, headers, gamePage: '/demos/', root: repoRoot }),
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const browser = await chromium.launch({ headless: !args.headed });
  const errors = [];
  try {
    await littleCity(browser, origin, errors);
    await platformer(browser, origin, errors);
    await gamePageAlone(browser, origin, errors);
    await predator(browser, origin, errors);
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    await server.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
