#!/usr/bin/env node
/**
 * The editor page's scene list in Chromium (VISUAL_EDITOR_PLAN.md ED-62, ED-63, ED-64): littleCity (1,243 placed trees, 65 houses,
 * 8,000 runtime people, cars) and the platformer, each at /editor?scene=…, with real keys and clicks. Each check prints
 * PASS or FAIL with what it read; the exit code is the number of failures. Nothing is saved: the level files are not
 * touched. Screenshots go to D:\tmp\claude\editor-tree\ (or --shots <dir>).
 *
 *   littleCity
 *     filter    Ctrl+F in the list puts the focus in the filter; "tree" typed keeps CityTree's 1,243 rows, unfolded,
 *               with its count, and no other class; the field's count says 1243
 *     typing    each keystroke's work (filter and draw: the input event's handlers), under a frame; the page's frames
 *               while typing against its frames at rest, and long tasks
 *     by name   "tree12" keeps CityTree12, 120 to 129 and 1200 to 1243 (55 rows); Esc clears it: every class back
 *     keys      in edit mode, filtered on "tree": ↓ from the field goes to the list at CityTree1; ↓ ↓ ↑ selects CityTree2;
 *               40 × ↓ CityTree42, its row scrolled into view; Enter frames it; nothing moved (the editor's own arrows
 *               would have nudged the tree: one action per key)
 *     rename    F2 opens a field over the row; "CityTree43" is refused (the field stays, the status says why); "Oak"
 *               is kept, one undo; Ctrl+Z (the editor's) takes it back
 *     Del and Ctrl+D once   Del takes one record out, Ctrl+D adds one (a second Ctrl+D would add another), each one undo
 *     double click          on CityTree45: selects it and frames it
 *     menu      a right click on CityTree45: Frame, Rename…, Duplicate, (Copy, once the editor has it), Delete, Select all
 *               CityTree (1243), in the editor page's document, in view, with the focus; Esc closes it and the tree
 *               stays selected (the editor's Esc would have let go of it)
 *     select all            the menu's Select all: 1,243 selected, CityTree45 the inspector's; the pick's time
 *     menu placement and runtime   opened at the viewport's corner it stays inside; a runtime person's menu: Frame and
 *               Select all (disabled: no person is placed), read-only; a click elsewhere closes it
 *     held key  20 repeated ↓ in a burst: 20 rows on, selected once (one frame), the burst well under a frame's work
 *               per key (a selection rebuilds the inspector: one per repeat would queue)
 *   platformer
 *     filter    "PLAT" (case aside) keeps two classes whole, the player's (BluePlatformerPlayer) and the 13 platforms;
 *               "goal" the goal; Esc clears it
 *     keys      in edit mode, "platform1", Enter: Platform1 selected; F2 "Ledge" renames it (the inspector follows),
 *               Ctrl+Z takes it back; Del deletes it, Ctrl+Z puts it back; nothing left unsaved
 *     menu      Platform3's menu; its Delete takes it out (one undo), Ctrl+Z puts it back; Shift+F10 in the list opens
 *               the selection's, its first item active; the player's row (the level's Player): a placed entity's menu
 *
 *   node tests/bench/editorTreeSmoke.mjs [--headed] [--shots <dir>]
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
const LIST = '[data-slot=tree] .weed-tree-list';
const FILTER = '[data-slot=tree] .weed-tree-filter';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

/** The game's page connected, its scene ready with its file, and the scene list made. */
async function editorReady(page) {
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
  // The editor page opens editing, at the level's start once the scene is ready (ED-80).
  await page.waitForFunction(() => document.getElementById('game').contentWindow.game.debugUI.editMode?.settled === true, undefined, {
    timeout: 30000,
  });
}

/** What the scene list shows: the model's counts, the rows drawn, the field's count, where the focus is. */
const readList = (page) =>
  page.evaluate(() => {
    const tree = document.getElementById('game').contentWindow.game.debugUI.hosted.tree;
    const slot = document.querySelector('[data-slot=tree]');
    const rows = [...slot.querySelectorAll('[data-row]')]
      .filter((row) => row.style.display !== 'none')
      .sort((a, b) => Number(a.dataset.row) - Number(b.dataset.row))
      .map((row) => row.textContent);
    const active = document.activeElement;
    return {
      query: tree.model.query,
      matchCount: tree.model.matchCount,
      rowCount: tree.model.rowCount,
      groups: tree.model.groups.map((g) => g.name),
      rows,
      count: slot.querySelector('.weed-tree-filter + span')?.textContent ?? '',
      filterValue: slot.querySelector('.weed-tree-filter').value,
      focus: active?.classList?.contains('weed-tree-filter') ? 'filter' : active?.classList?.contains('weed-tree-list') ? 'list' : active?.tagName,
    };
  });

/** The editor's state as the scene list's keys change it, read through the game page. */
const readEditor = (page) =>
  page.evaluate(() => {
    const win = document.getElementById('game').contentWindow;
    const editMode = win.game.debugUI.editMode;
    const scene = win.game.currentScene;
    const tree = win.game.debugUI.hosted.tree;
    const selection = editMode.selection;
    const i = selection.index;
    const list = tree._list;
    const row = i >= 0 ? tree.model.rowOf(i, selection.name) : -1;
    const active = document.activeElement;
    const record = selection.name === null ? null : scene.sceneFile.entities.find((r) => r.name === selection.name);
    return {
      editing: editMode.active,
      selection: selection.name,
      index: i,
      record: record ? [record.x, record.y] : null,
      records: scene.sceneFile.entities.length,
      undo: editMode.history._done.map((change) => change.label),
      dirty: editMode.dirty,
      rowShown: row >= 0 && row * 20 >= list.scrollTop && row * 20 + 20 <= list.scrollTop + list.clientHeight,
      renaming: tree.renaming,
      renameValue: tree._rename?.value ?? null,
      focus: active === list ? 'list' : active === tree._filter ? 'filter' : active === tree._rename ? 'rename' : (active?.tagName ?? null),
      camera: [win.WEED.Camera._freeFollowX, win.WEED.Camera._freeFollowY],
      at: i >= 0 ? [win.WEED.Transform.x[i], win.WEED.Transform.y[i]] : null,
      inspector: document.querySelector('[data-slot=inspector]').innerText.split('\n')[0],
      status: editMode.status,
    };
  });

/** The scene list's context menu as shown (null when closed): its items, where it is, whether it has the focus. */
const readMenu = (page) =>
  page.evaluate(() => {
    const menu = document.getElementById('game').contentWindow.game.debugUI.hosted.tree._menu;
    if (!menu.isOpen) return null;
    const box = menu.el.getBoundingClientRect();
    return {
      labels: menu.labels,
      active: menu._active,
      disabled: menu._items.map((item) => item.disabled),
      caption: menu.el.children[0].textContent,
      box: [box.left, box.top, box.width, box.height].map(Math.round),
      inView: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
      inEditorPage: menu.el.ownerDocument === document && menu.el.parentNode === document.body,
      focused: document.activeElement === menu.el,
    };
  });

/** The menu's item with this label (a locator in the editor page's document). */
const menuItem = (page, label) => page.locator('[role=menu] [role=menuitem]', { hasText: label });

/** What Copy adds to a placed entity's items, when the editor has it (EditMode.copySelected, ED-59). */
const copyLabels = (page, count = '') =>
  page.evaluate((n) => {
    const editMode = document.getElementById('game').contentWindow.game.debugUI.editMode;
    return typeof editMode.copySelected === 'function' ? [n ? `Copy ${n}` : 'Copy'] : [];
  }, count);

/**
 * Where framing the selection puts the free camera: the center of its box (EditMode.frameSelection, frame.js, ED-57),
 * or before the editor had it, the entity's position (the view centered on it).
 */
const frameCenter = (page) =>
  page
    .frames()
    .find((frame) => frame.parentFrame() !== null)
    .evaluate(async () => {
      const editMode = window.game.debugUI.editMode;
      const i = editMode.selection.index;
      if (i < 0) return null;
      const { Transform } = window.WEED;
      if (typeof editMode.frameSelection !== 'function') return [Transform.x[i], Transform.y[i]];
      const { entityBox } = await import('/src/core/debug/editor/pick.js'); // the editor's own module
      const box = new Float64Array(6);
      return entityBox(i, box) ? [box[0], box[1]] : [Transform.x[i], Transform.y[i]];
    });

/** Whether the free camera's target is where framing the selection puts it (Enter, a double click). */
const framed = (state, center) =>
  center !== null && Math.abs(state.camera[0] - center[0]) < 2 && Math.abs(state.camera[1] - center[1]) < 2;

/** Edit mode: the page opens in it; playing, the toolbar's Stop goes back to the level's start (ED-80). */
async function enterEdit(page) {
  const playing = await page.evaluate(() => !document.getElementById('game').contentWindow.game.debugUI.editMode.active);
  if (playing) await page.click('[data-slot=toolbar] button:has-text("Stop")');
  await page.waitForFunction(() => document.getElementById('game').contentWindow.game.debugUI.editMode.settled === true, undefined, {
    timeout: 30000,
  });
}

/** Count frames and long tasks in the editor page, and time each input event's handlers in the scene list. */
const instrument = (page) =>
  page.evaluate(() => {
    const slot = document.querySelector('[data-slot=tree]');
    const probe = { inputs: [], frames: [], longTasks: 0, recording: false };
    window.__treeProbe = probe;
    let t0 = 0;
    // Capture on the dock runs before the field's own listener, bubbling after it: the difference is the list's work.
    slot.addEventListener('input', () => (t0 = performance.now()), true);
    slot.addEventListener('input', () => probe.inputs.push(performance.now() - t0));
    let last = 0;
    const frame = (time) => {
      if (probe.recording && last > 0) probe.frames.push(time - last);
      last = time;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    try {
      new PerformanceObserver((list) => {
        if (probe.recording) probe.longTasks += list.getEntries().length;
      }).observe({ type: 'longtask' });
    } catch {
      probe.longTasks = -1; // not supported
    }
    return true;
  });

/** Record the page's frames (and the list's input work) while `act` runs. */
async function record(page, act) {
  await page.evaluate(() => {
    const probe = window.__treeProbe;
    probe.inputs.length = 0;
    probe.frames.length = 0;
    probe.longTasks = Math.min(probe.longTasks, 0);
    probe.recording = true;
    return true;
  });
  await act();
  return page.evaluate(() => {
    const probe = window.__treeProbe;
    probe.recording = false;
    const sorted = probe.frames.slice().sort((a, b) => a - b);
    const at = (q) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
    return {
      inputs: probe.inputs.slice(),
      frames: sorted.length,
      p50: at(0.5),
      p95: at(0.95),
      max: sorted.at(-1) ?? 0,
      longTasks: probe.longTasks,
    };
  });
}

const ms = (value) => `${value.toFixed(1)} ms`;

async function openEditor(browser, server, scene, errors) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
  page.on('pageerror', (error) => errors.push(`${scene}: ${error}`));
  page.on('console', (message) => {
    // The test server has no hot reload route: the game page's EventSource gets a 404, as on any static server.
    if (message.type() === 'error' && !message.text().includes('404')) errors.push(`${scene}: ${message.text()}`);
  });
  await page.goto(`http://127.0.0.1:${server.port}/editor?scene=${scene}`);
  await editorReady(page);
  await page.waitForTimeout(1500);
  return page;
}

async function littleCity(browser, server, shots, errors) {
  const page = await openEditor(browser, server, 'littlecity', errors);
  await instrument(page);
  const before = await readList(page);

  // ---- filter ----
  await page.focus(LIST);
  await page.keyboard.press('Control+F');
  const focused = (await readList(page)).focus;
  const rest = await record(page, () => page.waitForTimeout(1500));
  const typing = await record(page, () => page.keyboard.type('tree', { delay: 150 }));
  await page.waitForTimeout(200);
  const tree = await readList(page);
  check(
    'littleCity filter',
    focused === 'filter' &&
      tree.query === 'tree' &&
      tree.matchCount === 1243 &&
      tree.rowCount === 1244 &&
      tree.rows[0] === '▾ CityTree  ·  1243 of 1243 match' &&
      tree.rows.slice(1).every((row) => /^CityTree\d+\s/.test(row)) &&
      tree.count === '1243',
    `Ctrl+F → ${focused}; "tree": ${tree.matchCount} match, ${tree.rowCount} rows; first rows ` +
      `${JSON.stringify(tree.rows.slice(0, 3))}; the field's count "${tree.count}"; classes ${before.groups.join(', ')}`,
  );
  await page.screenshot({ path: path.join(shots, 'littlecity-filter-tree.png') });

  // ---- typing: each keystroke's work under a frame ----
  const worst = Math.max(...typing.inputs);
  check(
    'littleCity typing',
    typing.inputs.length === 4 && worst < 16,
    `each keystroke ${typing.inputs.map(ms).join(', ')} (worst ${ms(worst)}); frames typing p50 ${ms(typing.p50)}, ` +
      `p95 ${ms(typing.p95)}, max ${ms(typing.max)} (${typing.frames} frames), at rest p50 ${ms(rest.p50)}, ` +
      `p95 ${ms(rest.p95)}, max ${ms(rest.max)}; long tasks typing ${typing.longTasks}, at rest ${rest.longTasks}`,
  );

  // ---- by name ----
  await page.keyboard.type('12', { delay: 60 });
  await page.waitForTimeout(150);
  const byName = await readList(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const cleared = await readList(page);
  check(
    'littleCity by name',
    byName.matchCount === 55 &&
      byName.rows[0] === '▾ CityTree  ·  55 of 1243 match' &&
      byName.rows[1].startsWith('CityTree12 ') &&
      byName.rows[2].startsWith('CityTree120 ') &&
      cleared.query === '' &&
      cleared.filterValue === '' &&
      cleared.rowCount === before.rowCount &&
      cleared.count === '',
    `"tree12": ${byName.matchCount} match, ${JSON.stringify(byName.rows.slice(0, 3))}; Esc: filter "${cleared.filterValue}", ` +
      `${cleared.rowCount} rows (before ${before.rowCount})`,
  );

  // ---- keys (ED-63), in edit mode: a key that also reached the editor's own would nudge or duplicate again ----
  await enterEdit(page);
  const start = await readEditor(page);
  await page.click(FILTER);
  await page.keyboard.type('tree');
  await page.keyboard.press('ArrowDown'); // to the list, at the first match
  await page.waitForTimeout(100);
  const first = await readEditor(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(100);
  const stepped = await readEditor(page);
  for (let k = 0; k < 40; k++) await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  const far = await readEditor(page);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const entered = await readEditor(page);
  const enteredCenter = await frameCenter(page);
  check(
    'littleCity keys',
    first.focus === 'list' &&
      first.selection === 'CityTree1' &&
      stepped.selection === 'CityTree2' &&
      far.selection === 'CityTree42' &&
      far.rowShown &&
      framed(entered, enteredCenter) &&
      entered.undo.length === 0 &&
      !entered.dirty,
    `↓ from the filter: ${first.selection} (focus ${first.focus}); ↓ ↓ ↑: ${stepped.selection}; 40 × ↓: ${far.selection}, its row in ` +
      `view ${far.rowShown}; Enter: camera ${entered.camera.map(Math.round)}, framed at ${enteredCenter?.map(Math.round)}; ` +
      `undo stack ${entered.undo.length} (an arrow the editor also took would move the tree)`,
  );

  // ---- F2: a name the file has is refused, another kept; Ctrl+Z (the editor's) takes it back ----
  await page.keyboard.press('F2');
  await page.waitForTimeout(100);
  const opened = await readEditor(page);
  await page.keyboard.type('CityTree43'); // over the selected name
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  const refused = await readEditor(page);
  await page.screenshot({ path: path.join(shots, 'littlecity-rename-refused.png') });
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Oak');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const renamed = await readEditor(page);
  const oakRow = await page.evaluate(
    () =>
      [...document.querySelectorAll('[data-slot=tree] [data-row]')].find((row) => row.style.display !== 'none' && row.textContent.startsWith('Oak '))
        ?.textContent ?? null,
  );
  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(300);
  const undone = await readEditor(page);
  check(
    'littleCity rename',
    opened.renaming &&
      opened.focus === 'rename' &&
      opened.renameValue === 'CityTree42' &&
      refused.renaming &&
      refused.focus === 'rename' &&
      refused.selection === 'CityTree42' &&
      refused.status.includes('already has a CityTree43') &&
      renamed.selection === 'Oak' &&
      !renamed.renaming &&
      renamed.focus === 'list' &&
      renamed.undo.at(-1) === 'rename CityTree42 to Oak' &&
      oakRow !== null &&
      undone.selection === 'CityTree42' &&
      undone.undo.length === 0,
    `F2: field "${opened.renameValue}" (focus ${opened.focus}); "CityTree43": still open ${refused.renaming}, "${refused.status}"; ` +
      `"Oak": ${renamed.selection}, row "${oakRow}", undo "${renamed.undo.at(-1)}", focus ${renamed.focus}; Ctrl+Z: ${undone.selection}`,
  );

  // ---- Del and Ctrl+D act once (the editor's own Del and Ctrl+D do not run again), each one undo ----
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
  const deleted = await readEditor(page);
  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(300);
  const restored = await readEditor(page);
  await page.keyboard.press('Control+D');
  await page.waitForTimeout(300);
  const duplicated = await readEditor(page);
  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(300);
  const back = await readEditor(page);
  check(
    'littleCity Del and Ctrl+D once',
    deleted.records === start.records - 1 &&
      deleted.undo.join() === 'delete CityTree42' &&
      restored.records === start.records &&
      restored.selection === 'CityTree42' &&
      duplicated.records === start.records + 1 &&
      duplicated.undo.join() === 'duplicate CityTree42' &&
      back.records === start.records &&
      back.undo.length === 0,
    `records ${start.records} → Del ${deleted.records} (${deleted.undo}) → Ctrl+Z ${restored.records} → Ctrl+D ` +
      `${duplicated.records} (${duplicated.undo}) → Ctrl+Z ${back.records}`,
  );

  // ---- a double click frames (the list scrolled back to the trees around 45: the copy's row was at its end) ----
  await page.evaluate(() => {
    document.querySelector('[data-slot=tree] .weed-tree-list').scrollTop = 30 * 20;
    return true;
  });
  await page.waitForTimeout(150);
  await page.locator('[data-slot=tree] [data-row]', { hasText: /^CityTree45\s/ }).dblclick();
  await page.waitForTimeout(800);
  const doubled = await readEditor(page);
  const doubledCenter = await frameCenter(page);
  check(
    'littleCity double click',
    doubled.selection === 'CityTree45' && framed(doubled, doubledCenter),
    `${doubled.selection}: camera ${doubled.camera.map(Math.round)}, framed at ${doubledCenter?.map(Math.round)}`,
  );

  // ---- the menu (ED-64): a placed row's, Esc, Select all ----
  const row45 = page.locator('[data-slot=tree] [data-row]', { hasText: /^CityTree45\s/ });
  await row45.click({ button: 'right' });
  await page.waitForTimeout(150);
  const placedMenu = await readMenu(page);
  const copy = await copyLabels(page);
  await page.screenshot({ path: path.join(shots, 'littlecity-menu.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  const escaped = await readEditor(page);
  const closed = await readMenu(page);
  check(
    'littleCity menu',
    placedMenu !== null &&
      JSON.stringify(placedMenu.labels) ===
        JSON.stringify(['Frame', 'Rename…', 'Duplicate', ...copy, 'Delete', '—', 'Select all CityTree (1243)']) &&
      placedMenu.caption.startsWith('CityTree45') &&
      placedMenu.inEditorPage &&
      placedMenu.inView &&
      placedMenu.focused &&
      closed === null &&
      escaped.focus === 'list' &&
      escaped.selection === 'CityTree45',
    `${JSON.stringify(placedMenu?.labels)} "${placedMenu?.caption}" at ${placedMenu?.box}, in the editor page's document ` +
      `${placedMenu?.inEditorPage}, focused ${placedMenu?.focused}; Esc: closed ${closed === null}, focus ${escaped.focus}, ` +
      `still selected ${escaped.selection} (the editor's Esc would have let go of it)`,
  );

  await row45.click({ button: 'right' });
  await page.evaluate(() => {
    // The pick's work: from the click's capture on the document to its bubbling there (the menu's handler between);
    // and the list's own share of it (its onSelectionChanged, after the layout the inspector's new fields leave).
    const tree = document.getElementById('game').contentWindow.game.debugUI.hosted.tree;
    const probe = (window.__pickProbe = { ms: -1, list: 0, calls: 0 });
    const own = tree.onSelectionChanged;
    tree.onSelectionChanged = function timed() {
      void document.body.offsetHeight;
      const t = performance.now();
      own.call(tree);
      probe.list += performance.now() - t;
      probe.calls++;
    };
    let t0 = 0;
    const before = () => (t0 = performance.now());
    const after = () => {
      probe.ms = performance.now() - t0;
      document.removeEventListener('click', before, true);
      document.removeEventListener('click', after);
      delete tree.onSelectionChanged;
    };
    document.addEventListener('click', before, true);
    document.addEventListener('click', after);
    return true;
  });
  await menuItem(page, 'Select all CityTree').click();
  await page.waitForTimeout(300);
  const pick = await page.evaluate(() => ({ ...window.__pickProbe }));
  const all = await page.evaluate(() => {
    const editMode = document.getElementById('game').contentWindow.game.debugUI.editMode;
    return { count: editMode.multi.selectedNames().length, first: editMode.selection.name };
  });
  await page.screenshot({ path: path.join(shots, 'littlecity-select-all.png') });
  check(
    'littleCity select all',
    all.count === 1243 && all.first === 'CityTree45' && pick.calls > 0 && pick.list < 16,
    `${all.count} selected, the inspector's ${all.first}; the pick took ${ms(pick.ms)}, of it the list's own ` +
      `${ms(pick.list)} (${pick.calls} calls); the rest is the editor's multi-select and the inspector's new fields`,
  );

  // ---- the menu at the viewport's corner stays inside it; a runtime row's: Frame and Select all; a click elsewhere ----
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-slot=tree] [data-row]')].find((el) => el.style.display !== 'none' && /^CityTree\d/.test(el.textContent));
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: innerWidth - 3, clientY: innerHeight - 3 }));
    return true;
  });
  await page.waitForTimeout(100);
  const corner = await readMenu(page);
  await page.keyboard.press('Escape');
  await page.fill(FILTER, 'person');
  await page.waitForTimeout(150);
  await page.locator('[data-slot=tree] [data-row]', { hasText: /^#\d+\s+runtime/ }).first().click({ button: 'right' });
  await page.waitForTimeout(150);
  const runtimeMenu = await readMenu(page);
  await page.screenshot({ path: path.join(shots, 'littlecity-menu-runtime.png') });
  await page.mouse.click(1150, 49); // the Inspector dock's header
  await page.waitForTimeout(100);
  const afterOutside = await readMenu(page);
  check(
    'littleCity menu placement and runtime',
    corner !== null &&
      corner.inView &&
      runtimeMenu !== null &&
      JSON.stringify(runtimeMenu.labels) === JSON.stringify(['Frame', '—', 'Select all CityPerson']) &&
      runtimeMenu.disabled.at(-1) === true &&
      runtimeMenu.caption.includes('read-only') &&
      afterOutside === null,
    `opened at the corner: ${corner?.box} in view ${corner?.inView}; a runtime person's: ${JSON.stringify(runtimeMenu?.labels)} ` +
      `(Select all disabled ${runtimeMenu?.disabled.at(-1)}), "${runtimeMenu?.caption}"; a click elsewhere closes it ${afterOutside === null}`,
  );

  // ---- a held ↓ (ED-63): a burst of repeats moves the row at once and selects once a frame (a selection rebuilds the
  // inspector, 60 to 110 ms here: one per repeat would queue and run on after the key is let go) ----
  const held = await page.evaluate(async () => {
    const win = document.getElementById('game').contentWindow;
    const tree = win.game.debugUI.hosted.tree;
    const editMode = win.game.debugUI.editMode;
    tree._list.focus();
    const from = tree.model.rowOf(editMode.selection.index, editMode.selection.name);
    let selects = 0;
    const own = editMode.selectFromList;
    editMode.selectFromList = function counted(index, center) {
      selects++;
      return own.call(this, index, center);
    };
    const t0 = performance.now();
    for (let k = 0; k < 20; k++) {
      tree._list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', repeat: true, bubbles: true, cancelable: true }));
    }
    const burst = performance.now() - t0;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    delete editMode.selectFromList;
    return { from, to: tree.model.rowOf(editMode.selection.index, editMode.selection.name), selects, burst };
  });
  check(
    'littleCity held key',
    held.from >= 0 && held.to - held.from === 20 && held.selects === 1 && held.burst < 50,
    `20 repeated ↓ in ${ms(held.burst)}: row ${held.from} → ${held.to}, selected ${held.selects} time(s)`,
  );
  await page.close();
}

async function platformer(browser, server, shots, errors) {
  const page = await openEditor(browser, server, 'platformergame', errors);
  await page.focus(LIST);
  await page.keyboard.press('Control+F');
  await page.keyboard.type('PLAT', { delay: 40 });
  await page.waitForTimeout(150);
  const platforms = await readList(page);
  await page.screenshot({ path: path.join(shots, 'platformer-filter-plat.png') });
  await page.fill(FILTER, 'goal');
  await page.waitForTimeout(150);
  const goal = await readList(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const cleared = await readList(page);
  check(
    'platformer filter',
    platforms.matchCount === 14 &&
      platforms.rows[0] === '▾ BluePlatformerPlayer  ·  1 of 1 match' &&
      platforms.rows[2] === '▾ Platform  ·  13 of 13 match' &&
      platforms.rows.length === 16 &&
      goal.matchCount === 1 &&
      goal.rows[0] === '▾ Goal  ·  1 of 1 match' &&
      cleared.query === '' &&
      cleared.rowCount === cleared.groups.length,
    `"PLAT": ${platforms.matchCount} match, ${JSON.stringify([platforms.rows[0], platforms.rows[2]])}; "goal": ${JSON.stringify(goal.rows)}; ` +
      `Esc: ${cleared.rowCount} rows for ${cleared.groups.length} classes`,
  );

  // ---- keys (ED-63): rename in place and undo, delete and undo ----
  await enterEdit(page);
  const start = await readEditor(page);
  await page.fill(FILTER, 'platform1');
  await page.keyboard.press('Enter'); // to the list, at the first match
  await page.keyboard.press('F2');
  await page.keyboard.type('Ledge');
  await page.screenshot({ path: path.join(shots, 'platformer-rename.png') });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const renamed = await readEditor(page);
  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(300);
  const undone = await readEditor(page);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
  const deleted = await readEditor(page);
  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(300);
  const restored = await readEditor(page);
  check(
    'platformer keys',
    renamed.selection === 'Ledge' &&
      renamed.inspector.startsWith('Ledge') &&
      undone.selection === 'Platform1' &&
      deleted.records === start.records - 1 &&
      restored.records === start.records &&
      restored.selection === 'Platform1' &&
      restored.undo.length === 0 &&
      !restored.dirty,
    `F2 "Ledge": ${renamed.selection} (inspector "${renamed.inspector}"); Ctrl+Z: ${undone.selection}; Del: records ` +
      `${start.records} → ${deleted.records}; Ctrl+Z: ${restored.records}, ${restored.selection}, unsaved ${restored.dirty}`,
  );

  // ---- the menu (ED-64): Delete from it and undo; the player's row (the level's Player, placed) ----
  await page.fill(FILTER, 'platform');
  await page.waitForTimeout(150);
  await page.locator('[data-slot=tree] [data-row]', { hasText: /^Platform3\s/ }).click({ button: 'right' });
  await page.waitForTimeout(100);
  const menu = await readMenu(page);
  await page.screenshot({ path: path.join(shots, 'platformer-menu.png') });
  await menuItem(page, 'Delete').click();
  await page.waitForTimeout(300);
  const deletedByMenu = await readEditor(page);
  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(300);
  const back = await readEditor(page);
  await page.keyboard.press('Shift+F10'); // the keyboard's menu: the selection's, under its row
  await page.waitForTimeout(100);
  const byKey = await readMenu(page);
  await page.keyboard.press('Escape');
  await page.fill(FILTER, 'blue');
  await page.waitForTimeout(150);
  await page.locator('[data-slot=tree] [data-row]', { hasText: /^Player\s/ }).first().click({ button: 'right' });
  await page.waitForTimeout(100);
  const player = await readMenu(page);
  await page.keyboard.press('Escape');
  const copy = await copyLabels(page);
  check(
    'platformer menu',
    menu !== null &&
      JSON.stringify(menu.labels) === JSON.stringify(['Frame', 'Rename…', 'Duplicate', ...copy, 'Delete', '—', 'Select all Platform (13)']) &&
      deletedByMenu.records === start.records - 1 &&
      deletedByMenu.undo.join() === 'delete Platform3' &&
      back.records === start.records &&
      back.focus === 'list' &&
      byKey !== null &&
      byKey.caption.startsWith('Platform3') &&
      byKey.active === 0 &&
      player !== null &&
      player.caption.startsWith('Player') &&
      JSON.stringify(player.labels) === JSON.stringify(['Frame', 'Rename…', 'Duplicate', ...copy, 'Delete', '—', 'Select all BluePlatformerPlayer (1)']),
    `Platform3's ${JSON.stringify(menu?.labels)}; Delete: records ${start.records} → ${deletedByMenu.records} ` +
      `(${deletedByMenu.undo}); Ctrl+Z ${back.records} (focus ${back.focus}); Shift+F10: "${byKey?.caption}", item ` +
      `${byKey?.active} active; the player's (placed by the level) "${player?.caption}": ${JSON.stringify(player?.labels)}`,
  );
  await page.close();
}

async function main() {
  const args = parseArgs();
  const shots = path.resolve(typeof args.shots === 'string' ? args.shots : 'D:/tmp/claude/editor-tree');
  fs.mkdirSync(shots, { recursive: true });
  const server = await createStaticBenchmarkServer(repoRoot, 0, {
    before: (req, res, headers) =>
      handleDevRoute(req, res, repoRoot, headers) ||
      serveEditorPage(req, res, { shellDir: SHELL_DIR, headers, gamePage: '/demos/', root: repoRoot }),
  });
  const browser = await chromium.launch({ headless: !args.headed });
  const errors = [];
  try {
    await littleCity(browser, server, shots, errors);
    await platformer(browser, server, shots, errors);
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    await server.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed; screenshots in ${shots}`);
  process.exitCode = failed;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
