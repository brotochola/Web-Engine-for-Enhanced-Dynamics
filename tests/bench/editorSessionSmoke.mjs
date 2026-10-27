#!/usr/bin/env node
/**
 * One dev's session in the editor page at 1366×768 (VISUAL_EDITOR_PLAN.md ED-73), on a scratch copy of the
 * platformer's 1-1 (levels/__session-check.scene.json, removed after) opened through tests/fixtures/editorLevel/. The
 * steps run in order, each on what the last left, as a session does. Each check prints PASS or FAIL with what it read;
 * the exit code is the number of failures.
 *
 *   open       the editor page shows the level, and the toolbar's Edit enters edit mode
 *   filter     the scene list's filter keeps the platforms; a click on a row selects it, F frames it
 *   transform  typed into the inspector: a position, a rotation in degrees, a scale; one undo each, the entity respawned
 *   paste      Ctrl+C, then Ctrl+V with the pointer over the view: a renamed copy at the pointer (moved from the original
 *              in steps of 16), its turn and scale kept
 *   place      a class dragged from the palette onto the view lands where it is dropped, selected
 *   docks      the scene list folded and back (Ctrl+1), the right dock dragged wider: the game's canvas follows its
 *              frame, and a click in the view still selects what is under it
 *   undo       Ctrl+Z down to the file as loaded (the records and the live entities); Ctrl+Y back to the edits
 *   save       Ctrl+S writes the file: the edits, the copy and the placed class
 *   reload     Reload game: the saved file loads, still editing, with the selection and the view
 *   reopen     the editor page reloaded: the level as saved
 *
 * Every wait's predicate returns a boolean (a handle to the game's objects would keep a reloaded page alive).
 *
 *   node tests/bench/editorSessionSmoke.mjs [--headed] [--shots <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { handleDevRoute } from '../../server/devRoutes.js';
import { parseArgs } from './microbenchHelpers.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const LEVELS = '/demos/platformerGameScene/levels';
const SCRATCH = '__session-check.scene.json';
const scratchPath = path.join(repoRoot, 'demos/platformerGameScene/levels', SCRATCH);
const GAME = `/tests/fixtures/editorLevel/index.html?file=${encodeURIComponent(`${LEVELS}/${SCRATCH}`)}`;
const W = 1366;
const H = 768;
const TURN = Math.PI / 6; // 30° typed

const args = parseArgs();
const shotsDir = typeof args.shots === 'string' ? path.resolve(args.shots) : null;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
async function shot(page, name) {
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `session-${name}.png`) });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

const near = (a, b, tolerance = 2) => Math.abs(a - b) <= tolerance;

/** An element's box in the editor page. */
const box = (page, selector) =>
  page.evaluate((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
  }, selector);

async function ready(page) {
  await page.waitForFunction(() => window.__weedEditorHost?.connected === true, undefined, { timeout: 60000 });
  await page.waitForFunction(
    () => {
      const game = document.getElementById('game').contentWindow.game;
      const tree = game?.debugUI?.hosted?.tree;
      return !!(game && game.state === 1 && game.currentScene?.sceneFile && tree && tree.model.groups.length > 0);
    },
    undefined,
    { timeout: 60000 },
  );
  await page.waitForTimeout(1200);
}

/** The editor and the level as the game page has them: the records, the live entities, the view. */
const state = (page) =>
  page.evaluate(() => {
    const win = document.getElementById('game').contentWindow;
    const game = win.game;
    const editMode = game.debugUI.editMode;
    const scene = game.currentScene;
    const { Transform, Camera } = win.WEED;
    const live = {};
    for (const record of scene.sceneFile.entities) {
      const packed = scene._namedEntities.get(record.name);
      const i = packed === undefined ? -1 : Math.floor(packed / 65536);
      live[record.name] =
        i >= 0 && Transform.active[i] === 1 ? { x: Transform.x[i], y: Transform.y[i], rotation: Transform.rotation[i] } : null;
    }
    return {
      editing: editMode.active,
      selection: editMode.selection.name,
      dirty: editMode.dirty,
      canUndo: editMode.history.canUndo,
      canRedo: editMode.history.canRedo,
      undo: editMode.history._done.map((change) => change.label),
      records: scene.sceneFile.entities.map((r) => ({
        name: r.name,
        class: r.class,
        x: r.x,
        y: r.y,
        rotation: r.rotation ?? 0,
        scaleX: r.scaleX ?? 1,
        scaleY: r.scaleY ?? 1,
      })),
      live,
      camera: [Camera._freeFollowX, Camera._freeFollowY],
      page: win.__sessionPage ?? null,
    };
  });

/** Read the state until `test` holds or the time is up: the last state read. */
async function until(page, test, timeout = 6000) {
  const end = Date.now() + timeout;
  let s = await state(page);
  while (!test(s) && Date.now() < end) {
    await page.waitForTimeout(100);
    s = await state(page);
  }
  return s;
}

const recordOf = (s, name) => s.records.find((r) => r.name === name) ?? null;

/** The records as the file has them, in the state's shape. */
const asRecords = (doc) =>
  doc.entities.map((r) => ({ name: r.name, class: r.class, x: r.x, y: r.y, rotation: r.rotation ?? 0, scaleX: r.scaleX ?? 1, scaleY: r.scaleY ?? 1 }));
const byName = (records) => JSON.stringify([...records].sort((a, b) => (a.name < b.name ? -1 : 1)));

/** A page point over the view, as the world point the game reads there. */
const worldAt = (page, at) =>
  page.evaluate((at) => {
    const frame = document.getElementById('game');
    const f = frame.getBoundingClientRect();
    const win = frame.contentWindow;
    const r = win.game.canvas.getBoundingClientRect();
    const k = win.WEED.Camera.canvasWidth / r.width;
    const w = win.WEED.Camera.screenToWorld((at.x - f.left - r.left) * k, (at.y - f.top - r.top) * k);
    return { x: w.x, y: w.y };
  }, at);

/** A world point, as a page point. */
const pageAt = (page, wx, wy) =>
  page.evaluate(
    ({ wx, wy }) => {
      const frame = document.getElementById('game');
      const f = frame.getBoundingClientRect();
      const win = frame.contentWindow;
      const r = win.game.canvas.getBoundingClientRect();
      const s = win.WEED.Camera.worldToScreen(wx, wy);
      const k = r.width / win.WEED.Camera.canvasWidth;
      return { x: f.left + r.left + s.x * k, y: f.top + r.top + s.y * k };
    },
    { wx, wy },
  );

/** The view's frame, and the game's canvas and camera sizes inside it. */
const gameView = (page) =>
  page.evaluate(() => {
    const frame = document.getElementById('game');
    const r = frame.getBoundingClientRect();
    const win = frame.contentWindow;
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      inner: [win.innerWidth, win.innerHeight],
      canvas: [win.game.canvasWidth, win.game.canvasHeight],
      camera: [win.WEED.Camera.canvasWidth, win.WEED.Camera.canvasHeight],
    };
  });
const followsFrame = (v) =>
  v.canvas[0] === v.inner[0] && v.canvas[1] === v.inner[1] && v.camera[0] === v.inner[0] && v.camera[1] === v.inner[1];

/** A mouse drag from a palette row's picture to a page point (Chromium's own HTML5 drag and drop into the frame). */
async function dragClassTo(page, className, to) {
  const thumb = page.locator(`[data-slot=assets] [data-class-name="${className}"] canvas`);
  await thumb.scrollIntoViewIfNeeded();
  const from = await thumb.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 4, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

async function dragBy(page, selector, dx, dy) {
  const r = await box(page, selector);
  const x = r.x + r.w / 2;
  const y = r.y + r.h / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

const inspectorInput = (page, title) => page.locator(`[data-slot=inspector] input[title="${title}"]`);

async function typeInto(page, title, text) {
  const input = inspectorInput(page, title);
  await input.fill(text);
  await input.press('Enter');
}

/** Mark the game page, so a reload is told by the mark going. */
const markPage = (page) =>
  page.evaluate(() => {
    document.getElementById('game').contentWindow.__sessionPage = Math.random().toString(36).slice(2);
    return true;
  });

async function main() {
  fs.copyFileSync(path.join(repoRoot, 'demos/platformerGameScene/levels/1-1.scene.json'), scratchPath);
  const original = JSON.parse(fs.readFileSync(scratchPath, 'utf8'));
  const originalRecords = asRecords(original);
  const server = await createStaticBenchmarkServer(repoRoot, 0, {
    before: (req, res, headers) => handleDevRoute(req, res, repoRoot, headers),
  });
  const browser = await chromium.launch({ headless: !args.headed });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      // The test server has no hot reload route: the game page's EventSource gets a 404, as on any static server.
      if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text());
    });
    const editorUrl = `http://127.0.0.1:${server.port}/src/core/debug/editor/shell/?game=${encodeURIComponent(GAME)}`;
    await page.goto(editorUrl);
    await ready(page);

    // ---- open ----
    const view0 = await box(page, '#game');
    await page.click('[data-slot=toolbar] button:has-text("Edit")');
    let s = await until(page, (s) => s.editing);
    check(
      'open',
      s.editing && view0.w > 700 && view0.h > 550 && s.records.length === originalRecords.length && !s.dirty,
      `view ${Math.round(view0.w)}×${Math.round(view0.h)}, ${s.records.length} records, editing ${s.editing}`,
    );
    await shot(page, 'open');

    // ---- filter ----
    await page.click('[data-slot=tree] .weed-tree-filter');
    await page.keyboard.type('platform');
    await page.waitForTimeout(300);
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('[data-slot=tree] [data-row]')]
        .filter((row) => row.style.display !== 'none')
        .map((row) => row.textContent),
    );
    await page.locator('[data-slot=tree] [data-row]', { hasText: /^Platform3\s+#/ }).click();
    s = await until(page, (s) => s.selection === 'Platform3');
    await page.keyboard.press('f');
    const p3 = recordOf(s, 'Platform3');
    s = await until(page, (s) => near(s.camera[0], p3.x, 40) && near(s.camera[1], p3.y, 40), 3000);
    const platformRows = rows.filter((text) => /^Platform\d+\s+#/.test(text)).length;
    check(
      'filter',
      platformRows === 13 && !rows.some((text) => text.startsWith('Goal1')) && s.selection === 'Platform3' && near(s.camera[0], p3.x, 40),
      `${rows.length} rows shown (${platformRows} platforms, Goal1 ${rows.some((t) => t.startsWith('Goal1')) ? 'shown' : 'not shown'}); ` +
        `selected ${s.selection}; F: the view on ${s.camera.map(Math.round).join(', ')} (Platform3 at ${p3.x}, ${p3.y})`,
    );

    // ---- transform ----
    const undoBefore = s.undo.length;
    await typeInto(page, 'Position X', '2240');
    s = await until(page, (s) => recordOf(s, 'Platform3').x === 2240 && near(s.live.Platform3?.x ?? 0, 2240, 0.5));
    await typeInto(page, 'Rotation in degrees', '30');
    s = await until(page, (s) => near(recordOf(s, 'Platform3').rotation, TURN, 1e-3) && near(s.live.Platform3?.rotation ?? 0, TURN, 1e-3));
    await typeInto(page, 'Scale X', '1.5');
    s = await until(page, (s) => recordOf(s, 'Platform3').scaleX === 1.5);
    const turned = recordOf(s, 'Platform3');
    check(
      'transform',
      turned.x === 2240 &&
        near(turned.rotation, TURN, 1e-3) &&
        turned.scaleX === 1.5 &&
        near(s.live.Platform3?.x ?? 0, 2240, 0.5) &&
        near(s.live.Platform3?.rotation ?? 0, TURN, 1e-3) &&
        s.undo.length === undoBefore + 3,
      `record x ${turned.x}, rotation ${turned.rotation.toFixed(4)}, scaleX ${turned.scaleX}; live x ${s.live.Platform3?.x}, ` +
        `rotation ${s.live.Platform3?.rotation?.toFixed(4)}; undo ${s.undo.slice(undoBefore).join(' | ')}`,
    );
    await shot(page, 'transform');

    // ---- paste ----
    const view = await box(page, '#game');
    const pasteAt = { x: view.x + view.w * 0.25, y: view.y + view.h * 0.2 };
    await page.mouse.move(pasteAt.x, pasteAt.y);
    await page.waitForTimeout(200);
    const pasteWorld = await worldAt(page, pasteAt);
    const count = s.records.length;
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+v');
    s = await until(page, (s) => s.records.length === count + 1 && s.live[s.records[s.records.length - 1].name] !== null);
    const copy = s.records[s.records.length - 1];
    check(
      'paste',
      copy.class === 'Platform' &&
        copy.name !== 'Platform3' &&
        near(copy.rotation, TURN, 1e-3) &&
        copy.scaleX === 1.5 &&
        // At the pointer by an offset in steps of 16 (no snap set), so a copy stays on its original's grid.
        near(copy.x, pasteWorld.x, 8) &&
        near(copy.y, pasteWorld.y, 8) &&
        (copy.x - turned.x) % 16 === 0 &&
        (copy.y - turned.y) % 16 === 0 &&
        s.selection === copy.name,
      `${copy.name} at ${copy.x}, ${copy.y} (the pointer at ${pasteWorld.x.toFixed(1)}, ${pasteWorld.y.toFixed(1)}), ` +
        `rotation ${copy.rotation.toFixed(4)}, scaleX ${copy.scaleX}; selected ${s.selection}`,
    );

    // ---- place ----
    const dropAt = { x: view.x + view.w * 0.75, y: view.y + view.h * 0.2 };
    const dropWorld = await worldAt(page, dropAt);
    await dragClassTo(page, 'Goal', dropAt);
    s = await until(page, (s) => s.records.length === count + 2);
    const placed = s.records[s.records.length - 1];
    check(
      'place',
      placed.class === 'Goal' && near(placed.x, dropWorld.x, 3) && near(placed.y, dropWorld.y, 3) && s.selection === placed.name,
      `${placed.name} (${placed.class}) at ${placed.x}, ${placed.y} (dropped at ${dropWorld.x.toFixed(1)}, ${dropWorld.y.toFixed(1)}); ` +
        `selected ${s.selection}`,
    );
    await shot(page, 'placed');

    // ---- docks ----
    await page.mouse.move(view.x + view.w / 2, view.y + 10); // off the view's entities: Ctrl+1 is typed in the editor page
    await page.keyboard.press('Control+1');
    await page.waitForTimeout(500);
    const folded = await box(page, '#game');
    await page.keyboard.press('Control+1');
    await page.waitForTimeout(500);
    const unfolded = await box(page, '#game');
    const rightBefore = await box(page, '[data-dock=right]');
    await dragBy(page, '[data-handle=right]', -60, 0);
    await page.waitForTimeout(800);
    const rightAfter = await box(page, '[data-dock=right]');
    const frameNow = await gameView(page);
    const copyAt = await pageAt(page, copy.x, copy.y);
    await page.mouse.click(copyAt.x, copyAt.y);
    s = await until(page, (s) => s.selection === copy.name);
    check(
      'docks',
      folded.w > unfolded.w + 100 && near(rightAfter.w, rightBefore.w + 60, 3) && followsFrame(frameNow) && s.selection === copy.name,
      `the view ${Math.round(unfolded.w)} wide, ${Math.round(folded.w)} with the scene list folded; the right dock ` +
        `${Math.round(rightBefore.w)} → ${Math.round(rightAfter.w)}; canvas ${frameNow.canvas.join('×')} in a ` +
        `${frameNow.inner.join('×')} frame; a click on ${copy.name} selects ${s.selection}`,
    );
    await shot(page, 'docks');

    // ---- undo ----
    const edits = s.undo.length;
    let undos = 0;
    while ((await state(page)).canUndo && undos < 30) {
      await page.keyboard.press('Control+z');
      undos++;
      await page.waitForTimeout(120);
    }
    s = await until(
      page,
      (s) => !s.canUndo && byName(s.records) === byName(originalRecords) && near(s.live.Platform3?.x ?? 0, p3.x, 0.5),
    );
    const undone = byName(s.records) === byName(originalRecords);
    const liveBack = near(s.live.Platform3?.x ?? 0, p3.x, 0.5) && near(s.live.Platform3?.rotation ?? 1, 0, 1e-3);
    let redos = 0;
    while ((await state(page)).canRedo && redos < 30) {
      await page.keyboard.press('Control+y');
      redos++;
      await page.waitForTimeout(120);
    }
    s = await until(page, (s) => !s.canRedo && s.records.length === count + 2 && recordOf(s, 'Platform3').x === 2240);
    check(
      'undo',
      undone && liveBack && undos === edits && redos === edits && s.records.length === count + 2 && recordOf(s, 'Platform3').x === 2240,
      `${undos} undos back to the file as loaded (records ${undone}, Platform3 live at ${p3.x}, unturned: ${liveBack}); ` +
        `${redos} redos: ${s.records.length} records, Platform3.x ${recordOf(s, 'Platform3').x}`,
    );

    // ---- save ----
    await page.keyboard.press('Control+s');
    s = await until(page, (s) => !s.dirty);
    const saved = JSON.parse(fs.readFileSync(scratchPath, 'utf8'));
    const savedRecords = asRecords(saved);
    const sp3 = savedRecords.find((r) => r.name === 'Platform3');
    check(
      'save',
      !s.dirty &&
        byName(savedRecords) === byName(s.records) &&
        sp3.x === 2240 &&
        near(sp3.rotation, TURN, 1e-3) &&
        sp3.scaleX === 1.5 &&
        savedRecords.some((r) => r.name === copy.name) &&
        savedRecords.some((r) => r.name === placed.name),
      `the file: ${savedRecords.length} records, Platform3 at ${sp3.x} turned ${sp3.rotation.toFixed(4)} scaled ${sp3.scaleX}, ` +
        `${copy.name} and ${placed.name} in it; unsaved ${s.dirty}`,
    );

    // ---- reload (the game page; the editor page hands its state over) ----
    const beforeReload = await state(page);
    await markPage(page);
    await page.click('#reload');
    await page.waitForFunction(() => !document.getElementById('game').contentWindow.__sessionPage, undefined, { timeout: 30000 });
    await ready(page);
    s = await until(page, (s) => s.editing && s.selection === beforeReload.selection, 8000);
    check(
      'reload',
      s.editing &&
        !s.dirty &&
        s.selection === beforeReload.selection &&
        near(s.camera[0], beforeReload.camera[0], 2) &&
        near(s.camera[1], beforeReload.camera[1], 2) &&
        byName(s.records) === byName(savedRecords) &&
        near(s.live.Platform3?.rotation ?? 0, TURN, 1e-3),
      `editing ${s.editing}, unsaved ${s.dirty}, selected ${s.selection}, the view on ${s.camera.map(Math.round).join(', ')} ` +
        `(was ${beforeReload.camera.map(Math.round).join(', ')}), the records as saved ${byName(s.records) === byName(savedRecords)}`,
    );

    // ---- reopen (the editor page itself) ----
    await page.reload();
    await ready(page);
    s = await state(page);
    check(
      'reopen',
      byName(s.records) === byName(savedRecords) && near(s.live.Platform3?.x ?? 0, 2240, 0.5) && !s.dirty,
      `${s.records.length} records as saved ${byName(s.records) === byName(savedRecords)}, Platform3 live at ${s.live.Platform3?.x}`,
    );
    await shot(page, 'reopened');

    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    await server.close();
    fs.rmSync(scratchPath, { force: true });
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed;
}

main().catch((error) => {
  console.error(error);
  fs.rmSync(scratchPath, { force: true });
  process.exitCode = 1;
});
