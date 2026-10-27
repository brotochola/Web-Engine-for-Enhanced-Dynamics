#!/usr/bin/env node
/**
 * The editor page's docks in Chromium (VISUAL_EDITOR_PLAN.md ED-50): the dev server's
 * /editor?scene=platformergame. Each check prints PASS or FAIL with what it read; the exit code is the number of
 * failures. Nothing is saved: the level files are not touched.
 *
 *   docks       at 1366×768 the bottom dock is the debug bar's strip alone
 *   drag left, drag right, drag split
 *               a drag on a handle sizes its dock (the view gives or takes the same), writing one style per pointer
 *               move; the game's canvas then follows its frame (autoResize: the canvas and the camera have the frame's
 *               size, so nothing is stretched)
 *   bottom pane the Console opens a pane above the strip, which its handle sizes; a debug bar's panel opens in the
 *               same pane and closes the Console; closing it leaves the strip alone
 *   fold        the fold buttons, Ctrl+1, 2, 3 typed in the editor page and typed in the game's frame fold and unfold
 *               the docks; a section's title folds it and the other takes the column
 *   reload      the editor page reloaded: the sizes and folds are as they were left
 *   no storage  with localStorage throwing, the page opens with the default sizes and a drag still works
 *
 *   node tests/bench/editorLayoutSmoke.mjs [--headed] [--shots <dir>]   (--shots: screenshots, e.g. D:\tmp\claude\editor-shell)
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

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

const args = parseArgs();
const shotsDir = typeof args.shots === 'string' ? path.resolve(args.shots) : null;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
async function shot(page, name) {
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
}

/** Within a pixel or two: layout rounds. */
const near = (a, b, tolerance = 2) => Math.abs(a - b) <= tolerance;

/** An element's box in the editor page. */
const box = (page, selector) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, shown: r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none' };
  }, selector);

/** The view's frame, and the game's canvas and camera sizes inside it. */
const gameView = (page) =>
  page.evaluate(() => {
    const frame = document.getElementById('game');
    const r = frame.getBoundingClientRect();
    const win = frame.contentWindow;
    const game = win.game;
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      inner: [win.innerWidth, win.innerHeight],
      canvas: [game.canvasWidth, game.canvasHeight],
      css: [game.canvas.style.width, game.canvas.style.height],
      camera: [win.WEED.Camera.canvasWidth, win.WEED.Camera.canvasHeight],
    };
  });

/** The canvas follows its frame: the engine's size, the canvas's CSS size and the camera's are the frame's. */
const followsFrame = (v) =>
  v.canvas[0] === v.inner[0] &&
  v.canvas[1] === v.inner[1] &&
  v.camera[0] === v.inner[0] &&
  v.camera[1] === v.inner[1] &&
  (v.css[0] === '' || v.css[0] === `${v.inner[0]}px`) &&
  (v.css[1] === '' || v.css[1] === `${v.inner[1]}px`);

async function drag(page, selector, dx, dy) {
  const r = await box(page, selector);
  const x = r.x + r.w / 2;
  const y = r.y + r.h / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

/** Count the style writes on the layout's elements from here on (window.__styleWrites). */
const countStyleWrites = (page) =>
  page.evaluate(() => {
    const watched = new Set([
      document.body,
      document.querySelector('[data-dock=left]'),
      document.querySelector('[data-dock=right]'),
      document.querySelector('[data-dock=bottom]'),
      document.querySelector('[data-section=assets]'),
    ]);
    window.__styleWrites = 0;
    window.__styleObserver?.disconnect();
    window.__styleObserver = new MutationObserver((records) => {
      for (const r of records) if (watched.has(r.target)) window.__styleWrites++;
    });
    window.__styleObserver.observe(document.body, { attributes: true, attributeFilter: ['style'], subtree: true });
    return true;
  });
const styleWrites = (page) => page.evaluate(() => (window.__styleObserver.takeRecords(), window.__styleWrites));

async function openEditor(browser, origin, { width, height, blockStorage = false, errors }) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text());
  });
  if (blockStorage) {
    await page.addInitScript(() => {
      if (window.parent !== window) return; // the editor page only
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('blocked', 'SecurityError');
        },
      });
    });
  }
  await page.goto(`${origin}/editor?scene=platformergame`);
  await ready(page);
  return page;
}

async function ready(page) {
  await page.waitForFunction(() => window.__weedEditorHost?.connected === true, undefined, { timeout: 30000 });
  await page.waitForFunction(
    () => {
      const game = document.getElementById('game').contentWindow.game;
      return !!(game && game.state === 1 && game.currentScene && game.currentScene.sceneFile);
    },
    undefined,
    { timeout: 30000 },
  );
  await page.waitForTimeout(1200);
}

/** The game page's editor: edit mode, Platform1 selected. */
const editPlatform1 = (page) =>
  page.evaluate(() => {
    const editMode = document.getElementById('game').contentWindow.game.debugUI.editMode;
    editMode.enter();
    editMode.selectFromList(editMode.debugUI.scene._namedEntities.get('Platform1') >> 16 >>> 0, false);
    return true;
  });

async function main() {
  const server = await createStaticBenchmarkServer(repoRoot, 0, {
    before: (req, res, headers) =>
      handleDevRoute(req, res, repoRoot, headers) ||
      serveEditorPage(req, res, { shellDir: SHELL_DIR, headers, gamePage: '/demos/', root: repoRoot }),
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const browser = await chromium.launch({ headless: !args.headed });
  const errors = [];
  try {
    // ---- 1366×768: the docks, the handles, the folds ----
    const page = await openEditor(browser, origin, { width: 1366, height: 768, errors });
    await editPlatform1(page);
    await page.waitForTimeout(400);
    const first = await page.evaluate(() => ({
      bottom: document.querySelector('[data-dock=bottom]').getBoundingClientRect().height,
      handleShown: getComputedStyle(document.querySelector('[data-handle=bottom]')).display !== 'none',
      viewBottom: document.getElementById('game').getBoundingClientRect().bottom,
      bottomTop: document.querySelector('[data-dock=bottom]').getBoundingClientRect().top,
    }));
    await shot(page, 'docks-1366');
    check(
      'docks',
      first.bottom <= 34 && !first.handleShown && near(first.viewBottom, first.bottomTop, 1),
      `bottom dock ${first.bottom} px (the strip) right under the view, its handle ${first.handleShown ? 'shown' : 'hidden'}`,
    );

    // Drags: a handle sizes its dock, one style write per move; the game's canvas follows its frame.
    const before = { left: await box(page, '[data-dock=left]'), view: await gameView(page) };
    await countStyleWrites(page);
    await drag(page, '[data-handle=left]', 60, 0);
    const leftWrites = await styleWrites(page);
    await page.waitForTimeout(500); // the engine's resize waits 150 ms after the last
    const afterLeft = { left: await box(page, '[data-dock=left]'), view: await gameView(page) };
    check(
      'drag left',
      near(afterLeft.left.w - before.left.w, 60) && near(before.view.w - afterLeft.view.w, 60) && leftWrites <= 8 + 2 && followsFrame(afterLeft.view),
      `scene list ${before.left.w} → ${afterLeft.left.w} px, view ${before.view.w} → ${afterLeft.view.w} px, ${leftWrites} style writes ` +
        `for 8 moves and the release; canvas ${afterLeft.view.canvas}, camera ${afterLeft.view.camera}, frame ${afterLeft.view.inner}`,
    );

    const rightBefore = await box(page, '[data-dock=right]');
    await countStyleWrites(page);
    await drag(page, '[data-handle=right]', -50, 0);
    const rightWrites = await styleWrites(page);
    await page.waitForTimeout(500);
    const rightAfter = await box(page, '[data-dock=right]');
    const viewRight = await gameView(page);
    check(
      'drag right',
      near(rightAfter.w - rightBefore.w, 50) && near(afterLeft.view.w - viewRight.w, 50) && rightWrites <= 8 + 2 && followsFrame(viewRight),
      `inspector column ${rightBefore.w} → ${rightAfter.w} px, view ${afterLeft.view.w} → ${viewRight.w} px, ${rightWrites} style writes; ` +
        `canvas ${viewRight.canvas}, frame ${viewRight.inner}`,
    );

    const inspectorBefore = await box(page, '[data-section=inspector]');
    const assetsBefore = await box(page, '[data-section=assets]');
    await countStyleWrites(page);
    await drag(page, '[data-handle=split]', 0, 80);
    const splitWrites = await styleWrites(page);
    const inspectorAfter = await box(page, '[data-section=inspector]');
    const assetsAfter = await box(page, '[data-section=assets]');
    check(
      'drag split',
      near(inspectorAfter.h - inspectorBefore.h, 80) && near(assetsBefore.h - assetsAfter.h, 80) && splitWrites <= 8 + 1,
      `inspector ${inspectorBefore.h} → ${inspectorAfter.h} px, assets ${assetsBefore.h} → ${assetsAfter.h} px, ${splitWrites} style writes`,
    );

    // The bottom pane: the Console, its handle, a debug panel in its place.
    await page.click('[data-tab=console]');
    await page.waitForTimeout(200);
    const consoleOpen = await box(page, '[data-dock=bottom]');
    const paneHandle = await box(page, '[data-handle=bottom]');
    await drag(page, '[data-handle=bottom]', 0, -100);
    await page.waitForTimeout(200);
    const consoleTaller = await box(page, '[data-dock=bottom]');
    await shot(page, 'console-1366');
    await page.locator('[data-slot=debug] .debug-ui-tab', { hasText: 'Performance' }).click();
    await page.waitForTimeout(300);
    const debugPane = await page.evaluate(() => {
      const panel = document.querySelector('[data-slot=debug] .debug-ui-panel.open');
      const dock = document.querySelector('[data-dock=bottom]').getBoundingClientRect();
      const r = panel?.getBoundingClientRect();
      return {
        dock: dock.height,
        panel: r ? [Math.round(r.top - dock.top), Math.round(r.height)] : null,
        consoleShown: !document.querySelector('[data-pane=console]').hidden,
        consolePressed: document.querySelector('[data-tab=console]').getAttribute('aria-pressed'),
      };
    });
    await shot(page, 'debug-panel-1366');
    await page.locator('[data-slot=debug] .debug-ui-tab', { hasText: 'Performance' }).click();
    await page.waitForTimeout(200);
    const stripAgain = await box(page, '[data-dock=bottom]');
    check(
      'bottom pane',
      near(consoleOpen.h, 240) &&
        paneHandle.shown &&
        near(consoleTaller.h, 340) &&
        near(debugPane.dock, 340) &&
        debugPane.panel !== null &&
        debugPane.panel[1] > 250 &&
        !debugPane.consoleShown &&
        debugPane.consolePressed === 'false' &&
        stripAgain.h <= 34,
      `Console: the dock ${consoleOpen.h} px with its handle ${paneHandle.shown}, dragged up 100: ${consoleTaller.h} px; ` +
        `the Performance panel: dock ${debugPane.dock} px, panel at ${debugPane.panel} (top, height), Console closed ${!debugPane.consoleShown}; ` +
        `closed: the strip, ${stripAgain.h} px`,
    );

    // Folds: the buttons, the keys here and in the game's frame.
    const viewWide = await gameView(page);
    const leftW = (await box(page, '[data-dock=left]')).w;
    await page.click('[data-fold=left]');
    await page.waitForTimeout(100);
    const leftFolded = { left: await box(page, '[data-dock=left]'), view: (await gameView(page)).w };
    await page.click('.weed-editor-title'); // the keys go to the editor page
    await page.keyboard.press('Control+2');
    await page.keyboard.press('Control+3');
    // The engine resizes 150 ms after the frame did; its render worker shows the new size a moment later (in this
    // software-rendered Chromium a second or two: the screenshot waits for it).
    await page.waitForTimeout(2500);
    const allFolded = await page.evaluate(() => ({
      right: getComputedStyle(document.querySelector('[data-dock=right]')).display,
      bottom: getComputedStyle(document.querySelector('[data-dock=bottom]')).display,
      pressed: [...document.querySelectorAll('[data-toggle]')].map((b) => b.getAttribute('aria-pressed')),
    }));
    const viewFolded = await gameView(page);
    await shot(page, 'folded-1366');
    // The game's frame has the keys now: Ctrl+1, 2, 3 there unfold all three.
    await page.evaluate(() => {
      document.getElementById('game').contentWindow.focus();
      return true;
    });
    await page.locator('#game').focus();
    for (const key of ['Control+1', 'Control+2', 'Control+3']) await page.keyboard.press(key);
    await page.waitForTimeout(600);
    const unfolded = await page.evaluate(() => ({
      active: document.activeElement?.id,
      shown: ['left', 'right', 'bottom'].map((d) => getComputedStyle(document.querySelector(`[data-dock=${d}]`)).display !== 'none'),
      pressed: [...document.querySelectorAll('[data-toggle]')].map((b) => b.getAttribute('aria-pressed')),
    }));
    const viewBack = await gameView(page);
    // A section's title: the Assets fold, the Inspector takes the column.
    const inspectorOpen = await box(page, '[data-section=inspector]');
    await page.click('[data-fold=assets]');
    await page.waitForTimeout(100);
    const sections = { inspector: await box(page, '[data-section=inspector]'), assets: await box(page, '[data-section=assets]') };
    await shot(page, 'assets-folded-1366');
    await page.click('[data-fold=assets]');
    check(
      'fold',
      !leftFolded.left.shown &&
        near(leftFolded.view - viewWide.w, leftW) &&
        allFolded.right === 'none' &&
        allFolded.bottom === 'none' &&
        allFolded.pressed.join() === 'false,false,false' &&
        viewFolded.w === 1366 &&
        followsFrame(viewFolded) &&
        unfolded.shown.join() === 'true,true,true' &&
        unfolded.pressed.join() === 'true,true,true' &&
        viewBack.w === viewWide.w &&
        sections.assets.h <= 30 &&
        sections.inspector.h > inspectorOpen.h + 100,
      `scene list folded: view ${viewWide.w} → ${leftFolded.view} px; Ctrl+2, Ctrl+3: right ${allFolded.right}, bottom ${allFolded.bottom}, ` +
        `bar buttons ${allFolded.pressed}; view ${viewFolded.w}×${viewFolded.h}, canvas ${viewFolded.canvas}; Ctrl+1, 2, 3 in the game's frame ` +
        `(focus on #${unfolded.active}): shown ${unfolded.shown}, view ${viewBack.w} px; Assets folded: ${sections.assets.h} px, inspector ` +
        `${inspectorOpen.h} → ${sections.inspector.h} px`,
    );

    // Reload: the sizes and folds as left (the Console open at 340 px, the scene list folded).
    await page.click('[data-tab=console]');
    await page.click('[data-fold=left]');
    await page.waitForTimeout(200);
    const kept = {
      right: (await box(page, '[data-dock=right]')).w,
      bottom: (await box(page, '[data-dock=bottom]')).h,
      inspector: (await box(page, '[data-section=inspector]')).h,
    };
    await page.reload();
    await ready(page);
    const restored = await page.evaluate(() => ({
      left: getComputedStyle(document.querySelector('[data-dock=left]')).display,
      right: document.querySelector('[data-dock=right]').getBoundingClientRect().width,
      bottom: document.querySelector('[data-dock=bottom]').getBoundingClientRect().height,
      inspector: document.querySelector('[data-section=inspector]').getBoundingClientRect().height,
      console: !document.querySelector('[data-pane=console]').hidden,
    }));
    check(
      'reload',
      restored.left === 'none' && near(restored.right, kept.right) && near(restored.bottom, kept.bottom) && near(restored.inspector, kept.inspector) && restored.console,
      `scene list ${restored.left === 'none' ? 'folded' : 'shown'}, right ${kept.right} → ${restored.right} px, bottom ${kept.bottom} → ` +
        `${restored.bottom} px, inspector ${kept.inspector} → ${restored.inspector} px, Console ${restored.console ? 'open' : 'closed'}`,
    );
    await page.close();

    // ---- a blocked localStorage: the defaults, and a drag still works ----
    const blocked = await openEditor(browser, origin, { width: 1366, height: 768, blockStorage: true, errors });
    const blockedLeft = await box(blocked, '[data-dock=left]');
    await drag(blocked, '[data-handle=left]', 40, 0);
    const blockedAfter = await box(blocked, '[data-dock=left]');
    check(
      'no storage',
      near(blockedLeft.w, 250) && near(blockedAfter.w - blockedLeft.w, 40),
      `scene list ${blockedLeft.w} px (the default), dragged: ${blockedAfter.w} px`,
    );
    await blocked.close();

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
