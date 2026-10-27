#!/usr/bin/env node
/**
 * The editor's Assets dock in Chromium (VISUAL_EDITOR_PLAN.md ED-65), in the editor page on the dev server's short
 * route (/editor?scene=…). Each check prints PASS or FAIL with what it read; the exit code is the number of failures.
 * Nothing is saved: the checks only read the dock and the document in memory.
 *
 *   littlecity pictures      every class row has a 32 px picture with pixels drawn; the houses, trees, people and cars
 *                            show what a live one of them shows (its sprite from the atlas)
 *   platformergame pictures  the platforms and the goal are their tinted bars (live), the player (an Adobe Animate
 *                            character, no sprite) its initials
 *   predator filter          its 16 classes get a filter field; "drop" leaves the four Drop classes, Esc clears it
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
  await page.close();
}

async function platformer(browser, origin, errors) {
  const page = await openEditor(browser, origin, 'platformergame', errors);
  await gameReady(page);
  await page.waitForTimeout(1500);
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
