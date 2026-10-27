#!/usr/bin/env node
/**
 * The editor page in Chromium (VISUAL_EDITOR_PLAN.md D9, ED-15): the platformer's own page (the demos page with
 * ?scene=platformergame) in the editor page's iframe. Each check prints PASS or FAIL with what it read; the exit code
 * is the number of failures. Nothing is saved: the level files are not touched.
 *
 *   docks    the page connects and fills the docks: the toolbar names 1-1.scene.json, the scene list has the
 *            platforms, the assets list the level files and the classes, the debug bar is below, and the debug UI's
 *            styles are in the editor page
 *   list     a click on Platform1's row selects it and the game plays on (ED-17); the inspector shows its fields and
 *            its live values; the toolbar's Edit then holds the world with Platform1 still selected
 *   keys     Shift+E typed in the editor page plays and edits again; Ctrl+Z typed there undoes
 *   edit     the inspector's width field makes Platform1 640 wide, unsaved
 *   reload   Reload game: a new game page has the unsaved document, edit mode, the selection and the view, and the
 *            toolbar's Undo then takes the width back to the file's
 *   no leak  5 more reloads with an unsaved document: Chrome's document count stays 2, and the JS heap after a GC
 *            within 2 MB of where it was
 *   stop     (ED-16) Play runs the game; the player put on the goal loads 1-2; Stop comes back to 1-1 in edit mode,
 *            with its unsaved document and undo stack
 *   live     (ED-17) while playing, a click in the list selects Platform1 without leaving play; its live fields
 *            follow the entity; a live alpha written in the inspector reaches the entity; Copy to scene puts it in
 *            the record (one undo); a live tint not copied is gone after Stop
 *   console  (ED-18) another game, tests/fixtures/editorConsoleScene.js in the bench page: the Console dock has a
 *            logic worker's log from the load and one after it, the game page's own warning, and one row for the
 *            talkers' tick error with its count; a click on that row selects the entity that threw
 *   short url  the dev server's /editor (server/editorPage.js, the game page /demos/): /editor?scene=platformergame
 *            opens the platformer and keeps that address; /editor alone shows the demo list, and choosing the
 *            platformer there turns the address into /editor?scene=platformergame; the game page's own Scene panel
 *            button opens /editor?game=…, which becomes /editor?scene=platformergame
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
import { serveEditorPage } from '../../server/editorPage.js';
import { parseArgs } from './microbenchHelpers.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const GAME = '/demos/index.html?scene=platformergame';
const SHELL_DIR = path.join(repoRoot, 'src/core/debug/editor/shell');

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
      inspector: document.querySelector('[data-slot=inspector]').innerText.replace(/\s*\n\s*/g, ' | '),
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
    before: (req, res, headers) =>
      handleDevRoute(req, res, repoRoot, headers) ||
      serveEditorPage(req, res, { shellDir: SHELL_DIR, headers, gamePage: '/demos/', root: repoRoot }),
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
    const listed = state;
    await page.click('[data-slot=toolbar] button:has-text("Edit")');
    await page.waitForTimeout(300);
    state = await readGame(page);
    check(
      'list',
      !listed.active &&
        listed.selection === 'Platform1' &&
        listed.inspector.startsWith('Platform1') &&
        listed.inspector.includes('width') &&
        listed.inspector.includes('Live') &&
        state.active &&
        state.selection === 'Platform1',
      `playing on ${!listed.active}, selected ${listed.selection}, inspector "${listed.inspector.slice(0, 60)}…"; ` +
        `after Edit: editing ${state.active}, selected ${state.selection}`,
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

    const width = page.locator('[data-slot=inspector] div[data-key="width"] input[type="number"]');
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

    // The live inspector (ED-17), while playing.
    await page.click('[data-slot=toolbar] button:has-text("Play")');
    await page.waitForTimeout(300);
    await rows.filter({ hasText: /^Platform1\s/ }).click();
    await page.waitForTimeout(300);
    // The Live section starts folded (ED-54): open it.
    const liveSection = page.locator('[data-slot=inspector] [data-section=live]');
    if ((await liveSection.locator('.debug-ui-inspector-prop').count()) === 0) await liveSection.locator('> div').first().click();
    await page.waitForTimeout(200);
    const liveField = (label) =>
      page
        .locator('[data-slot=inspector] .debug-ui-inspector-prop', {
          has: page.locator('.debug-ui-inspector-prop-label', { hasText: new RegExp('^' + label + '$') }),
        })
        .locator('input')
        .first();
    const liveRead = () =>
      page.evaluate(() => {
        const win = document.getElementById('game').contentWindow;
        const scene = win.game.currentScene;
        const editMode = win.game.debugUI.editMode;
        const i = editMode.selection.index;
        const record = scene.sceneFile.entities.find((e) => e.name === 'Platform1');
        return {
          editing: editMode.active,
          selected: editMode.selection.name,
          alpha: win.WEED.SpriteRenderer.alpha[i],
          tint: win.WEED.SpriteRenderer.tint[i],
          x: win.WEED.Transform.x[i],
          recordAlpha: record.config?.alpha ?? null,
          undo: editMode.history._done.at(-1)?.label ?? null,
        };
      });
    const beforeLive = await liveRead();
    const xShown = await liveField('x').inputValue();
    await liveField('alpha').fill('0.5');
    await liveField('alpha').press('Enter');
    await page.waitForTimeout(300);
    const afterAlpha = await liveRead();
    await page.click('[data-slot=inspector] button:has-text("Copy to scene")');
    await page.waitForTimeout(400);
    const copied = await liveRead();
    await liveField('tint').fill('0xff0000');
    await liveField('tint').press('Enter');
    await page.waitForTimeout(300);
    const tinted = await liveRead();
    await page.click('[data-slot=toolbar] button:has-text("Stop")');
    await page.waitForFunction(() => document.getElementById('game').contentWindow.game.debugUI.editMode.active === true, undefined, {
      timeout: 10000,
    });
    await page.waitForTimeout(400);
    const stopped = await liveRead();
    check(
      'live',
      !beforeLive.editing &&
        beforeLive.selected === 'Platform1' &&
        Math.abs(Number(xShown) - beforeLive.x) < 1 &&
        Math.abs(afterAlpha.alpha - 0.5) < 1e-6 &&
        copied.recordAlpha === 0.5 &&
        copied.undo === 'copy live Platform1 to the scene' &&
        tinted.tint === 0xff0000 &&
        stopped.tint !== 0xff0000 &&
        Math.abs(stopped.alpha - 0.5) < 1e-6,
      'selected while playing ' + (!beforeLive.editing && beforeLive.selected === 'Platform1') + ', x field ' + xShown +
        '; live alpha ' + afterAlpha.alpha + '; copied alpha ' + copied.recordAlpha + ' (' + copied.undo + '); live tint ' +
        tinted.tint.toString(16) + ' → after Stop ' + stopped.tint.toString(16) + ', alpha ' + stopped.alpha,
    );

    // The console (ED-18), with a game that logs and throws.
    await page.close();
    const consolePage = await browser.newPage({ viewport: { width: 1400, height: 860 } });
    consolePage.on('pageerror', (error) => errors.push(String(error)));
    await consolePage.goto(
      `http://127.0.0.1:${server.port}/src/core/debug/editor/shell/?game=${encodeURIComponent('/tests/bench/integratedWorkerBenchmark.html?src=1')}`,
    );
    await consolePage.waitForFunction(
      () => document.getElementById('game').contentDocument?.body?.dataset.benchmarkReady === 'true',
      undefined,
      { timeout: 30000 },
    );
    // The game's frame, not the editor page (whose own URL names the game page in its query).
    const frame = consolePage.frames().find((f) => f.parentFrame() !== null);
    await frame.evaluate(async () => {
      const { default: WEED } = await import('/src/index.js');
      if (typeof WEED.ensureEmbeddedSources === 'function') await WEED.ensureEmbeddedSources();
      const game = new WEED.GameEngine({ autoResize: true, debug: true, injectStyles: false });
      globalThis.game = game;
      await game.loadScene('/tests/fixtures/editorConsoleScene.js', { export: 'EditorConsoleScene' });
      return true;
    });
    await consolePage.waitForTimeout(800);
    await frame.evaluate(async () => {
      const { Talker } = await import('/tests/fixtures/editorConsoleScene.js');
      Talker.spawn({ x: 400, y: 400 });
      console.warn('a warning of the game page');
      return true;
    });
    await consolePage.waitForTimeout(1500);
    await consolePage.click('[data-tab=console]');
    // Each row: its source, its text, its count.
    const lines = await consolePage.evaluate(() =>
      [...document.querySelectorAll('[data-console-rows] > div')].map((row) => [...row.children].map((cell) => cell.innerText)),
    );
    const spawned = lines.filter(([source, text]) => source === 'logic0' && /^talker #\d+ spawned$/.test(text));
    const warned = lines.findIndex(([source, text]) => source === 'page' && text === 'a warning of the game page');
    const errorRow = lines.find(([, text]) => /^Talker #\d+ · tick threw: talker tick broke$/.test(text)) || ['', '', ''];
    const thrower = Number((/Talker #(\d+)/.exec(errorRow[1]) || [])[1]);
    await consolePage.locator('[data-slot=console] [data-entity]').first().click();
    await consolePage.waitForTimeout(300);
    const selected = await frame.evaluate(() => globalThis.game.debugUI.editMode.selection.index);
    check(
      'console',
      spawned.length === 3 &&
        lines.indexOf(spawned[1]) < warned &&
        lines.indexOf(spawned[2]) > warned &&
        /^logic/.test(errorRow[0]) &&
        /^×\d+$/.test(errorRow[2]) &&
        selected === thrower,
      `${spawned.length} talkers' logs from logic0 (2 from the load, before the page's warning, row ${warned}); ` +
        `error row ${JSON.stringify(errorRow)}; a click selected #${selected}`,
    );

    // The short route (/editor), its address following the game page.
    await consolePage.close();
    const origin = `http://127.0.0.1:${server.port}`;
    const shortPage = await browser.newPage({ viewport: { width: 1400, height: 860 } });
    shortPage.on('pageerror', (error) => errors.push(String(error)));
    // The editor page's address and its game page's, once the address has followed the game page (the demos page
    // sets its own key for a scene: ?scene=platformergamescene).
    const follows = async () => {
      await shortPage
        .waitForFunction(() => location.search === document.getElementById('game').contentWindow.location.search, undefined, {
          timeout: 10000,
        })
        .catch(() => {});
      return shortPage.evaluate(() => {
        const game = document.getElementById('game').contentWindow.location;
        return { address: location.pathname + location.search, game: game.pathname + game.search };
      });
    };
    const isPlatformer = ({ address, game }) =>
      /^\/demos\/(index\.html)?\?scene=platformergame(scene)?$/.test(game) && address === `/editor${game.slice(game.indexOf('?'))}`;
    await shortPage.goto(`${origin}/editor?scene=platformergame`);
    await gameReady(shortPage);
    const opened = await follows();
    await shortPage.goto(`${origin}/editor`);
    await shortPage.waitForFunction(
      () => document.getElementById('game').contentDocument?.querySelectorAll('.scene_chooser_button').length > 0,
      undefined,
      { timeout: 30000 },
    );
    const listAddress = await shortPage.evaluate(() => location.pathname + location.search);
    const listFrame = shortPage.frames().find((f) => f.parentFrame() !== null);
    await listFrame.locator('.scene_chooser_button', { hasText: 'platformer game' }).click();
    await gameReady(shortPage);
    const chosen = await follows();
    await shortPage.goto(`${origin}${GAME}`);
    await shortPage.waitForFunction(() => !!window.game?.currentScene?.sceneFile, undefined, { timeout: 30000 });
    await shortPage.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Editor page')).click();
      return true;
    });
    await shortPage.waitForURL(/\/editor\?/, { timeout: 10000 });
    await gameReady(shortPage);
    const fromButton = await follows();
    check(
      'short url',
      isPlatformer(opened) && listAddress === '/editor' && isPlatformer(chosen) && isPlatformer(fromButton),
      `/editor?scene=platformergame: ${opened.address} with ${opened.game}; /editor: ${listAddress}, the platformer chosen: ` +
        `${chosen.address}; the Scene panel's button: ${fromButton.address} with ${fromButton.game}`,
    );
    await shortPage.close();

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
