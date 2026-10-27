#!/usr/bin/env node
/**
 * The editor page's docks and status bar in Chromium (VISUAL_EDITOR_PLAN.md ED-50, ED-51, ED-52): the dev server's
 * /editor?scene=platformergame. Each check prints PASS or FAIL with what it read; the exit code is the number of
 * failures. Nothing is saved: the level files are not touched.
 *
 *   docks       at 1366×768 the bottom dock is the debug bar's strip alone; the status bar is under the view; the
 *               game page shows neither its tool indicator nor the overlay's pointer lines
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
 *   widths      the view at 1920, 1366, 1100 and 800 px wide: the side docks narrow under 1280 and open over the view
 *               under 1100, from the bar, with the view keeping the width; nothing leaves the bar
 *   status      the status bar follows the selection, the pointer (the world point the game reads), the zoom, the
 *               grid (G), placing; and writes nothing while nothing changes
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
  // The editor page opens editing, at the level's start once the scene is ready (ED-80).
  await page.waitForFunction(() => document.getElementById('game').contentWindow.game.debugUI.editMode?.settled === true, undefined, {
    timeout: 30000,
  });
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

const statusText = (page) =>
  page.evaluate(() => {
    const out = {};
    for (const span of document.querySelectorAll('[data-slot=status] [data-status]')) out[span.dataset.status] = span.textContent;
    return out;
  });

/**
 * Wait until the status bar's parts say what `want` says, or `timeout` ms; a check then reads them as they are.
 * @param {Record<string, string>} want - a part's text; 'hint^' a start of the hint, 'hint!^' a start it must not have
 */
async function statusWhen(page, want, timeout = 5000) {
  await page
    .waitForFunction(
      (w) => {
        const parts = {};
        for (const span of document.querySelectorAll('[data-slot=status] [data-status]')) parts[span.dataset.status] = span.textContent;
        for (const [key, value] of Object.entries(w)) {
          const hint = parts.hint ?? '';
          if (key === 'hint^' ? !hint.startsWith(value) : key === 'hint!^' ? hint.startsWith(value) : parts[key] !== value) return false;
        }
        return true;
      },
      want,
      { timeout },
    )
    .catch(() => {});
}

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
    const first = await page.evaluate(() => {
      const win = document.getElementById('game').contentWindow;
      const indicator = win.document.querySelector('.debug-ui-tool-indicator');
      return {
        bottom: document.querySelector('[data-dock=bottom]').getBoundingClientRect().height,
        handleShown: getComputedStyle(document.querySelector('[data-handle=bottom]')).display !== 'none',
        status: document.querySelector('[data-slot=status] .weed-editor-status-line') !== null,
        statusTop: document.querySelector('[data-slot=status]').getBoundingClientRect().top,
        viewBottom: document.getElementById('game').getBoundingClientRect().bottom,
        indicatorShown: indicator !== null && indicator.classList.contains('visible'),
        hud: win.game.debugUI.canvas.showHud,
      };
    });
    await shot(page, 'docks-1366');
    check(
      'docks',
      first.bottom <= 34 && !first.handleShown && first.status && near(first.statusTop, first.viewBottom, 1) && !first.indicatorShown && first.hud === false,
      `bottom dock ${first.bottom} px (the strip), its handle ${first.handleShown ? 'shown' : 'hidden'}; status bar under the view ` +
        `${first.status && near(first.statusTop, first.viewBottom, 1)}; indicator ${first.indicatorShown ? 'shown' : 'hidden'}, overlay lines ${first.hud ? 'on' : 'off'}`,
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
    await page.waitForTimeout(600); // the engine resizes 150 ms after its frame did
    const allFolded = await page.evaluate(() => ({
      right: getComputedStyle(document.querySelector('[data-dock=right]')).display,
      bottom: getComputedStyle(document.querySelector('[data-dock=bottom]')).display,
      pressed: [...document.querySelectorAll('[data-toggle]')].map((b) => b.getAttribute('aria-pressed')),
    }));
    const viewFolded = await gameView(page);
    // Its render worker shows a frame of the new size a moment later: in this software-rendered Chromium, a few seconds
    // after resizes in a row (the game page alone does the same). The screenshot waits for it.
    if (shotsDir) await page.waitForTimeout(5000);
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

    // The status bar, on this page: the selection, the pointer, the zoom, the grid, placing; no writes at rest. It follows
    // at the game page's ticks (100 ms), which run late while a page that just loaded is busy: each step waits for what
    // it expects, a few seconds at most, then reads.
    await page.click('[data-toggle=left]'); // unfolded again, from the bar (its own button is folded with it)
    await page.click('[data-tab=console]');
    // The view grew: the pointer's world point is read once the canvas follows its frame (a resized frame settles late
    // in headless Chromium, found item 30), or the "at rest" second sees it change.
    for (let k = 0; k < 50 && !followsFrame(await gameView(page)); k++) await page.waitForTimeout(100);
    await page.waitForTimeout(300);
    await editPlatform1(page);
    await statusWhen(page, { mode: 'EDIT', selection: '1 selected' });
    const selected = await statusText(page);
    const view = await box(page, '#game');
    await page.mouse.move(view.x + view.w * 0.4, view.y + view.h * 0.4);
    // The world point the game reads under the pointer, as the status bar writes it.
    const pointerText = () =>
      page.evaluate(() => {
        const WEED = document.getElementById('game').contentWindow.WEED;
        const coord = (n) => (n < 0 ? `\u2212${-n}` : `${n}`);
        return WEED.Mouse.isPresent ? `x ${coord(Math.round(WEED.Mouse.x))}\u2002y ${coord(Math.round(WEED.Mouse.y))}` : '';
      });
    const expectedPointer = await page.waitForFunction(() => document.getElementById('game').contentWindow.WEED.Mouse.isPresent).then(pointerText);
    await statusWhen(page, { pointer: expectedPointer });
    const pointed = await statusText(page);
    const world = await page.evaluate(() => {
      const WEED = document.getElementById('game').contentWindow.WEED;
      return { x: Math.round(WEED.Mouse.x), y: Math.round(WEED.Mouse.y), zoom: Math.round(WEED.Camera.zoom * 100) };
    });
    const coord = (n) => (n < 0 ? `\u2212${-n}` : `${n}`);
    // At rest: nothing written into the status bar for a second.
    const quiet = await page.evaluate(
      () =>
        new Promise((resolve) => {
          let writes = 0;
          const observer = new MutationObserver((records) => (writes += records.length));
          observer.observe(document.querySelector('[data-slot=status]'), { subtree: true, childList: true, characterData: true, attributes: true });
          setTimeout(() => {
            observer.disconnect();
            resolve(writes);
          }, 1000);
        }),
    );
    await page.keyboard.press('g'); // the focus is in the editor page: its keys go to the game page's editor
    const snap = await page.evaluate(() => document.getElementById('game').contentWindow.game.debugUI.editMode.move.snap);
    await statusWhen(page, { grid: `Grid ${snap} px` });
    const gridded = await statusText(page);
    await page.evaluate(() => {
      document.getElementById('game').contentWindow.game.debugUI.editMode.startPlacing('Goal');
      return true;
    });
    // The grid's own status line ("Grid 8 px") holds the hint for 3 s first.
    await statusWhen(page, { 'hint^': 'Placing Goal:' }, 8000);
    const placing = await statusText(page);
    await shot(page, 'status-placing-1366');
    await page.keyboard.press('Escape');
    await statusWhen(page, { 'hint!^': 'Placing' });
    const stopped = await statusText(page);
    check(
      'status',
      selected.mode === 'EDIT' &&
        selected.selection === '1 selected' &&
        selected.hint.startsWith('Platform1: ') &&
        pointed.pointer === `x ${coord(world.x)}\u2002y ${coord(world.y)}` &&
        pointed.zoom === `${world.zoom}%` &&
        quiet === 0 &&
        snap > 1 &&
        gridded.grid === `Grid ${snap} px` &&
        placing.hint.startsWith('Placing Goal:') &&
        !stopped.hint.startsWith('Placing'),
      `"${selected.mode}" "${selected.hint.slice(0, 40)}…" "${selected.selection}"; pointer "${pointed.pointer}" (the game reads ` +
        `${world.x}, ${world.y}), zoom "${pointed.zoom}"; ${quiet} writes in a second at rest; G: "${gridded.grid}" (step ${snap}); ` +
        `placing: "${placing.hint.slice(0, 32)}…", Esc: "${stopped.hint.slice(0, 32)}…"`,
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

    // ---- widths: the view at 1920, 1366, 1100 and 800 ----
    const rows = [];
    let barOk = true;
    let overlay = null;
    for (const [width, height] of [
      [1920, 1080],
      [1366, 768],
      [1100, 768],
      [800, 600],
    ]) {
      const p = await openEditor(browser, origin, { width, height, errors });
      await editPlatform1(p);
      await p.waitForTimeout(500);
      const v = await gameView(p);
      const docks = await p.evaluate(() =>
        ['left', 'right'].map((d) => {
          const el = document.querySelector(`[data-dock=${d}]`);
          return getComputedStyle(el).display === 'none' ? 0 : Math.round(el.getBoundingClientRect().width);
        }),
      );
      // Nothing leaves the bar: each of its parts inside it, on one line.
      const bar = await p.evaluate(() => {
        const bar = document.querySelector('.weed-editor-bar').getBoundingClientRect();
        const out = [];
        for (const el of document.querySelectorAll('.weed-editor-bar > *, .weed-editor-toolbar button, .weed-editor-toolbar span')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0) continue;
          if (r.left < bar.left - 0.5 || r.right > bar.right + 0.5) out.push(el.id || el.className || el.textContent);
        }
        return { height: bar.height, outside: out };
      });
      if (bar.outside.length > 0 || bar.height > 40) barOk = false;
      // The side docks: their default widths from 1280 up, 70 % of them at 1100, over the view (closed) below.
      const expected = width >= 1280 ? [250, 320] : width >= 1100 ? [175, 224] : [0, 0];
      rows.push({
        text: `${width}: view ${v.w}×${v.h}, docks ${docks.join(' + ')}, bar ${bar.height} px${bar.outside.length ? ` (outside: ${bar.outside})` : ''}`,
        ok: near(docks[0], expected[0], 1) && near(docks[1], expected[1], 1) && v.w === width - docks[0] - docks[1] && followsFrame(v),
      });
      await shot(p, `width-${width}`);
      if (width === 800) {
        // The debug strip's tabs by their icons, each naming itself on hover.
        const tabs = await p.evaluate(() =>
          [...document.querySelectorAll('[data-slot=debug] .debug-ui-tab')].map((tab) => ({
            title: tab.title,
            label: getComputedStyle(tab.children[1]).display,
          })),
        );
        if (tabs.length === 0 || !tabs.every((tab) => tab.title !== '' && tab.label === 'none')) {
          barOk = false;
          rows.push({ text: `strip tabs ${JSON.stringify(tabs)}`, ok: false });
        }
        await p.click('[data-toggle=right]');
        await p.waitForTimeout(500);
        const right = await box(p, '[data-dock=right]');
        const after = await gameView(p);
        await shot(p, 'width-800-inspector');
        await p.click('[data-toggle=left]');
        await p.waitForTimeout(300);
        await shot(p, 'width-800-both');
        const left = await box(p, '[data-dock=left]');
        overlay = { right, left, view: after.w, docksBefore: docks };
      }
      await p.close();
    }
    check(
      'widths',
      barOk &&
        rows.every((row) => row.ok) &&
        overlay !== null &&
        overlay.docksBefore.join() === '0,0' &&
        overlay.view === 800 &&
        overlay.right.shown &&
        near(overlay.right.x + overlay.right.w, 800, 1) &&
        overlay.left.shown &&
        near(overlay.left.x, 0, 1),
      `${rows.map((row) => row.text).join('; ')}; at 800 the inspector opens over the view (${Math.round(overlay?.right.x)}–${Math.round(
        (overlay?.right.x ?? 0) + (overlay?.right.w ?? 0),
      )} px) and the view keeps ${overlay?.view} px`,
    );

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
