#!/usr/bin/env node
/**
 * The editor page in Chromium (VISUAL_EDITOR_PLAN.md D9, ED-15): the platformer's own page (the demos page with
 * ?scene=platformergame) in the editor page's iframe. Each check prints PASS or FAIL with what it read; the exit code
 * is the number of failures. Nothing is saved: the level files are not touched.
 *
 *   docks    the page connects and fills the docks: the toolbar names 1-1.scene.json, the scene list has the
 *            platforms, the assets list the level files and the classes, the debug bar is below, and the debug UI's
 *            styles are in the editor page
 *   list     a click on Platform1's row enters edit mode and selects it; the inspector shows its fields
 *   keys     Shift+E typed in the editor page plays and edits again; Ctrl+Z typed there undoes
 *   edit     the inspector's width field makes Platform1 640 wide, unsaved
 *   reload   Reload game: a new game page has the unsaved document, edit mode, the selection and the view, and the
 *            toolbar's Undo then takes the width back to the file's
 *   no leak  5 more reloads with an unsaved document: Chrome's document count stays 2, and the JS heap after a GC
 *            within 2 MB of where it was
 *   stop     (ED-16) Play runs the game; the player put on the goal loads 1-2; Stop comes back to 1-1 in edit mode,
 *            with its unsaved document and undo stack
 *
 * Every wait's predicate returns a boolean: Playwright keeps a handle to what it returns, and a handle to the game's
 * scene would keep each reloaded page alive (it did, in the first leak runs of this script).
 *
 *   node tests/bench/editorShellSmoke.mjs [--headed]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { handleDevRoute } from '../../server/devRoutes.js';
import { parseArgs } from './microbenchHelpers.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const GAME = '/demos/index.html?scene=platformergame';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

/** The game page's editor and its Platform1, read through the iframe. */
const readGame = (page) =>
  page.evaluate(() => {
    const win = document.getElementById('game').contentWindow;
    const editMode = win.game.debugUI.editMode;
    const record = win.game.currentScene.sceneFile.entities.find((e) => e.name === 'Platform1');
    win.__smokePage ??= Math.random().toString(36).slice(2);
    return {
      page: win.__smokePage,
      active: editMode.active,
      selection: editMode.selection.name,
      dirty: editMode.dirty,
      canUndo: editMode.history.canUndo,
      width: record?.config?.width ?? null,
      view: [win.WEED?.Camera?._freeFollowX ?? null, win.WEED?.Camera?.zoom ?? null],
      toolbar: document.querySelector('[data-slot=toolbar]').innerText.replace(/\s*\n\s*/g, ' | '),
      inspector: document.querySelector('[data-slot=inspector]').innerText.replace(/\s*\n\s*/g, ' | ').slice(0, 160),
    };
  });

async function gameReady(page) {
  await page.waitForFunction(() => window.__weedEditorHost?.connected === true, undefined, { timeout: 30000 });
  await page.waitForFunction(
    () => {
      const game = document.getElementById('game').contentWindow.game;
      return !!(game && game.state === 1 && game.currentScene && game.currentScene.sceneFile);
    },
    undefined,
    { timeout: 30000 },
  );
}

async function reloadGame(page) {
  const before = await page.evaluate(() => document.getElementById('game').contentWindow.__smokePage ?? null);
  await page.click('#reload');
  await page.waitForFunction((old) => document.getElementById('game').contentWindow.__smokePage !== old || old === null, before, {
    timeout: 30000,
  });
  await gameReady(page);
  // The resume runs once the scene is ready: a fast swap when the document had unsaved changes.
  await page.waitForTimeout(2500);
}

async function domCounters(page, cdp) {
  for (let k = 0; k < 3; k++) {
    await cdp.send('HeapProfiler.collectGarbage');
    await page.waitForTimeout(200);
  }
  const { documents } = await cdp.send('Memory.getDOMCounters');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  return { documents, heapMb: usedSize / 1048576 };
}

async function main() {
  const args = parseArgs();
  const server = await createStaticBenchmarkServer(repoRoot, 0, {
    before: (req, res, headers) => handleDevRoute(req, res, repoRoot, headers),
  });
  const browser = await chromium.launch({ headless: !args.headed });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      // The test server has no hot reload route: the game page's EventSource gets a 404, as on any static server.
      if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text());
    });
    const cdp = await page.context().newCDPSession(page);
    await page.goto(`http://127.0.0.1:${server.port}/src/core/debug/editor/shell/?game=${encodeURIComponent(GAME)}`);
    await gameReady(page);
    await page.waitForTimeout(1500);

    const docks = await page.evaluate(() => {
      const text = (slot) => document.querySelector(`[data-slot=${slot}]`).innerText;
      return {
        toolbar: text('toolbar'),
        tree: text('tree'),
        assets: text('assets'),
        debug: document.querySelector('[data-slot=debug] .debug-ui') !== null,
        styles: document.querySelector('style[data-weed-styles="debug-ui-styles"]')?.textContent.length ?? 0,
      };
    });
    check(
      'docks',
      docks.toolbar.includes('1-1.scene.json') &&
        /Platform · 13 placed/.test(docks.tree) &&
        docks.assets.includes('1-2.scene.json') &&
        docks.assets.includes('Goal') &&
        docks.debug &&
        docks.styles > 1000,
      `toolbar "${docks.toolbar.replace(/\n/g, ' ')}", list "${docks.tree.split('\n')[1]}", debug bar ${docks.debug}, styles ${docks.styles} chars`,
    );

    const rows = page.locator('[data-slot=tree] [data-row]');
    await rows.filter({ hasText: /^▸ Platform\s+·/ }).click();
    await rows.filter({ hasText: /^Platform1\s/ }).click();
    await page.waitForTimeout(300);
    let state = await readGame(page);
    check(
      'list',
      state.active && state.selection === 'Platform1' && state.inspector.startsWith('Platform1') && state.inspector.includes('width'),
      `editing ${state.active}, selected ${state.selection}, inspector "${state.inspector.slice(0, 60)}…"`,
    );

    // Keys typed in the editor page (the scene list has the focus).
    await page.keyboard.press('Shift+E');
    await page.waitForTimeout(200);
    const played = (await readGame(page)).active;
    await page.locator('[data-slot=tree]').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Shift+E');
    await page.waitForTimeout(200);
    const editingAgain = (await readGame(page)).active;
    await page.evaluate(() => {
      const editMode = document.getElementById('game').contentWindow.game.debugUI.editMode;
      editMode.selectFromList(editMode.debugUI.scene._namedEntities.get('Platform1') >> 16 >>> 0, false);
    });

    const width = page.locator('[data-slot=inspector] input:not([type=range]):not([type=color])').nth(1);
    await width.fill('640');
    await width.press('Tab');
    await page.waitForTimeout(300);
    state = await readGame(page);
    check('edit', state.width === 640 && state.dirty && state.toolbar.includes('1-1.scene.json ●'), `width ${state.width}, unsaved ${state.dirty}`);

    await page.locator('[data-slot=tree]').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+Z');
    await page.waitForTimeout(300);
    const undone = (await readGame(page)).width;
    await page.keyboard.press('Control+Y');
    await page.waitForTimeout(300);
    const redone = (await readGame(page)).width;
    check('keys', played === false && editingAgain === true && undone === 1200 && redone === 640, `Shift+E played ${played === false}, edited again ${editingAgain}; Ctrl+Z ${undone}, Ctrl+Y ${redone}`);

    // The view, to see it come back.
    await page.evaluate(() => {
      const win = document.getElementById('game').contentWindow;
      win.WEED.Camera.setFreeTarget(1500, 1800);
      win.WEED.Camera.setZoom(0.75);
    });
    const before = await readGame(page);
    await reloadGame(page);
    state = await readGame(page);
    const viewKept = Math.abs(state.view[0] - 1500) < 1 && Math.abs(state.view[1] - 0.75) < 1e-3;
    check(
      'reload',
      state.page !== before.page && state.width === 640 && state.dirty && state.active && state.selection === 'Platform1' && viewKept,
      `new page ${state.page !== before.page}, width ${state.width}, unsaved ${state.dirty}, editing ${state.active}, selected ${state.selection}, view ${state.view}`,
    );
    await page.click('[data-slot=toolbar] button:has-text("Undo")');
    await page.waitForTimeout(300);
    state = await readGame(page);
    check('reload undo', state.width === 1200 && !state.dirty, `width ${state.width}, unsaved ${state.dirty}`);

    // Leaks: an unsaved document handed over each time, so every reload resumes with a fast swap.
    await page.click('[data-slot=toolbar] button:has-text("Redo")');
    await page.waitForTimeout(300);
    const first = await domCounters(page, cdp);
    let last = first;
    for (let r = 0; r < 5; r++) {
      await reloadGame(page);
      last = await domCounters(page, cdp);
    }
    state = await readGame(page);
    check(
      'no leak',
      last.documents === 2 && last.heapMb - first.heapMb < 2 && state.width === 640,
      `documents ${first.documents} → ${last.documents}, heap ${first.heapMb.toFixed(1)} → ${last.heapMb.toFixed(1)} MB, width ${state.width}`,
    );

    // Play and Stop (ED-16): play, the goal loads 1-2, Stop comes back to 1-1 with its unsaved document.
    await page.click('[data-slot=toolbar] button:has-text("Play")');
    await page.waitForTimeout(500);
    const playing = await page.evaluate(() => {
      const win = document.getElementById('game').contentWindow;
      const editMode = win.game.debugUI.editMode;
      const scene = win.game.currentScene;
      const goal = scene.getByName('Goal1');
      const player = win.WEED.GameObject.instances[scene.playerIndex];
      const out = { editing: editMode.active, playing: editMode.playing, scale: win.WEED.Time.scale };
      player.setPosition(goal.x, goal.y - 140); // it falls onto the goal
      return out;
    });
    await page.waitForFunction(
      () => String(document.getElementById('game').contentWindow.game.currentScene.sceneFileUrl).endsWith('/1-2.scene.json'),
      undefined,
      { timeout: 10000 },
    );
    await page.waitForTimeout(500);
    await page.click('[data-slot=toolbar] button:has-text("Stop")');
    await page.waitForFunction(
      () => {
        const game = document.getElementById('game').contentWindow.game;
        return String(game.currentScene.sceneFileUrl).endsWith('/1-1.scene.json') && game.debugUI.editMode.active === true;
      },
      undefined,
      { timeout: 10000 },
    );
    await page.waitForTimeout(300);
    state = await readGame(page);
    check(
      'stop',
      playing.scale > 0 && !playing.editing && playing.playing && state.active && state.width === 640 && state.dirty && state.canUndo,
      `playing at ${playing.scale}×; after Stop: editing ${state.active}, width ${state.width}, unsaved ${state.dirty}, undo ${state.canUndo}`,
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
