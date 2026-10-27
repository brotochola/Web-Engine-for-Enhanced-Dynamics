#!/usr/bin/env node
/**
 * The editor page's scene list in Chromium (VISUAL_EDITOR_PLAN.md ED-62): littleCity (1,243 placed trees, 65 houses,
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
 *   platformer
 *     filter    "PLAT" (case aside) keeps two classes whole, the player's (BluePlatformerPlayer) and the 13 platforms;
 *               "goal" the goal; Esc clears it
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
