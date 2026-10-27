#!/usr/bin/env node
/**
 * The editor page's console in Chromium (VISUAL_EDITOR_PLAN.md ED-18, ED-68): tests/fixtures/editorConsoleScene.js in
 * the bench page (?src=1), in the editor page's iframe, as editorShellSmoke.mjs's 'console' check runs it. Talkers log
 * from logic0 when they spawn and the odd ones throw in their tick; the game page logs what each check needs. Each
 * check prints PASS or FAIL with what it read; the exit code is the number of failures.
 *
 *   hidden   while the Debug tab is in front the game logs, and the console's DOM does not change (a MutationObserver
 *            of the editor page counts every change in it); the Console tab shows the rows at once, before the next
 *            tick or frame
 *   counts   logs, warnings and errors arrive: each toggle's count is the sum of its rows' (a repeated line ×n); the
 *            page's lines are there with their repeats, and the talkers' error with its throws
 *   toggles  Warnings off hides the warning rows and only them; Errors and Logs likewise; the counts stay
 *   search   "SMOKE WARNING" shows the rows that have it in any case; "logic0" the rows of that source; Esc clears
 *   scroll   at the bottom the view follows new rows; scrolled up with the wheel it stays, and "↓ N new rows" shows;
 *            the button takes it to the bottom, and it follows again
 *   cap      2,050 rows: the newest 2,000 are kept, and the console says how many went; the time to draw them all
 *            when the tab opens is printed
 *   stream   at the cap and shown, the game logs 20 lines a tick (the forward's 200 a second) for 2 s: the view follows
 *            them to the last; the average time of a flush is printed (information, not a bound: other runs on the
 *            machine move it)
 *   clear    Clear empties the list and sets every count to 0; the next line is a row again
 *   no page errors
 *
 * Screenshots go to D:\tmp\claude\editor-console\ (--shots <dir> for another place), never into the repository.
 *
 *   node tests/bench/editorConsoleSmoke.mjs [--headed] [--shots <dir>]
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
const GAME = '/tests/bench/integratedWorkerBenchmark.html?src=1';
/** Time for a line to reach the console and be drawn: the debug UI ticks every 100 ms. */
const SETTLE_MS = 400;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

/**
 * The console, read in one go (a tick between two reads could add a row or a throw): every row (its level, the row's
 * class letter; its cells; its count; whether it is on screen), the toggles (count, on), the search, the "new rows"
 * button and the dropped note when shown, and the list's scroll.
 */
const readConsole = (page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-console-rows] > div')].map((row) => {
      const [source, text, count] = [...row.children].map((cell) => cell.textContent);
      const letter = /weed-console-([ewlid])(\s|$)/.exec(row.className)?.[1] ?? '?';
      return { letter, source, text, count, n: count ? Number(count.slice(1)) : 1, shown: row.checkVisibility() };
    });
    const toggles = [...document.querySelectorAll('.weed-console-toggle')].map((t) => ({
      count: t.querySelector('.weed-console-n').textContent,
      on: t.getAttribute('aria-pressed') === 'true',
      title: t.title,
    }));
    const button = document.querySelector('.weed-console-new');
    const note = document.querySelector('.weed-console-note');
    const scroller = document.querySelector('.weed-console-scroll');
    return {
      rows,
      toggles,
      search: document.querySelector('.weed-console-search').value,
      newRows: button.checkVisibility() ? button.textContent : null,
      note: note.checkVisibility() ? note.textContent : null,
      scrollTop: scroller.scrollTop,
      atEnd: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4,
      scrollable: scroller.scrollHeight > scroller.clientHeight,
    };
  });
const readRows = async (page) => (await readConsole(page)).rows;
const readBar = readConsole;

/** Sum of the rows' counts per group: errors (e), warnings (w), logs (l, i, d). */
function sums(rows) {
  const out = [0, 0, 0];
  for (const row of rows) out[row.letter === 'e' ? 0 : row.letter === 'w' ? 1 : 2] += row.n;
  return out;
}

async function main() {
  const args = parseArgs();
  const shots = path.resolve(typeof args.shots === 'string' ? args.shots : 'D:/tmp/claude/editor-console');
  fs.mkdirSync(shots, { recursive: true });
  const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`) });

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
    await page.goto(`http://127.0.0.1:${server.port}/src/core/debug/editor/shell/?game=${encodeURIComponent(GAME)}`);
    await page.waitForFunction(() => document.getElementById('game').contentDocument?.body?.dataset.benchmarkReady === 'true', undefined, {
      timeout: 30000,
    });
    // The game's frame, not the editor page (whose own URL names the game page in its query).
    const frame = page.frames().find((f) => f.parentFrame() !== null);
    await frame.evaluate(async () => {
      const { default: WEED } = await import('/src/index.js');
      if (typeof WEED.ensureEmbeddedSources === 'function') await WEED.ensureEmbeddedSources();
      const game = new WEED.GameEngine({ autoResize: true, debug: true, injectStyles: false });
      globalThis.game = game;
      await game.loadScene('/tests/fixtures/editorConsoleScene.js', { export: 'EditorConsoleScene' });
      return true;
    });
    await page.waitForFunction(() => document.querySelector('[data-slot=console] .weed-console') !== null, undefined, { timeout: 10000 });
    await page.waitForTimeout(800);
    // The game page logs (the console forward sends each call on), from inside its own frame.
    const log = (lines) =>
      frame.evaluate((calls) => {
        for (const [level, text] of calls) console[level](text);
        return true;
      }, lines);

    // ---- hidden: the Debug tab is in front ----
    await page.evaluate(() => {
      window.__consoleChanges = 0;
      new MutationObserver((records) => {
        window.__consoleChanges += records.length;
      }).observe(document.querySelector('[data-slot=console] .weed-console'), {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      return true;
    });
    await frame.evaluate(async () => {
      const { Talker } = await import('/tests/fixtures/editorConsoleScene.js');
      Talker.spawn({ x: 400, y: 400 });
      Talker.spawn({ x: 450, y: 400 });
      return true;
    });
    await log([
      ['log', 'smoke log A'],
      ['log', 'smoke log A'],
      ['log', 'smoke log A'],
      ['info', 'smoke info B'],
      ['debug', 'smoke debug C'],
      ['warn', 'smoke warning'],
      ['warn', 'smoke warning'],
      ['warn', 'smoke warning 2'],
      ['error', 'smoke error'],
    ]);
    await page.waitForTimeout(1500); // the talkers' error reports come once a second
    const hidden = await page.evaluate(() => ({
      changes: window.__consoleChanges,
      rows: document.querySelectorAll('[data-console-rows] > div').length,
      pending: document.getElementById('game').contentWindow.game.debugUI.hosted.console.log.size,
    }));
    // The tab opens; the rows are read after the microtasks the click queued, before any tick or frame.
    const opened = await page.evaluate(async () => {
      const frames = { n: 0 };
      const count = () => frames.n++;
      requestAnimationFrame(count);
      const t0 = performance.now();
      document.querySelector('[data-tab=console]').click();
      await Promise.resolve();
      await Promise.resolve();
      return {
        rows: document.querySelectorAll('[data-console-rows] > div').length,
        ms: performance.now() - t0,
        frames: frames.n,
      };
    });
    check(
      'hidden',
      hidden.changes === 0 && hidden.rows === 0 && hidden.pending >= 10 && opened.rows === hidden.pending && opened.frames === 0,
      `while hidden: ${hidden.changes} DOM changes in the console, ${hidden.rows} rows drawn of ${hidden.pending} kept; ` +
        `the tab opened: ${opened.rows} rows drawn in ${opened.ms.toFixed(1)} ms, before any frame (${opened.frames})`,
    );
    await page.waitForTimeout(SETTLE_MS);
    await shot(page, '1-console');

    // ---- counts ----
    const bar = await readConsole(page);
    const rows = bar.rows;
    const rowSums = sums(rows);
    const counted = bar.toggles.map((t) => Number(t.count));
    const find = (text) => rows.find((row) => row.text === text) || null;
    const errorRow = rows.find((row) => /^Talker #\d+ · tick threw: talker tick broke$/.test(row.text)) || null;
    check(
      'counts',
      counted.join() === rowSums.join() &&
        find('smoke log A')?.count === '×3' &&
        find('smoke warning')?.count === '×2' &&
        find('smoke warning 2')?.letter === 'w' &&
        find('smoke info B')?.letter === 'i' &&
        find('smoke debug C')?.letter === 'd' &&
        find('smoke error')?.letter === 'e' &&
        errorRow !== null &&
        errorRow.n > 1 &&
        rows.filter((row) => /^talker #\d+ spawned$/.test(row.text) && row.source === 'logic0').length >= 4,
      `toggles ${counted.join(' / ')} (errors / warnings / logs), rows sum to ${rowSums.join(' / ')}; ` +
        `"smoke log A" ${find('smoke log A')?.count}, "smoke warning" ${find('smoke warning')?.count}; ` +
        `error row ${JSON.stringify(errorRow && [errorRow.source, errorRow.text, errorRow.count])}`,
    );

    // ---- toggles: off and read in one task (no tick between: the talkers' throws keep counting), on by a click ----
    const turnOff = (i, letters) =>
      page.evaluate(
        ([index, hides]) => {
          const counts = () => [...document.querySelectorAll('.weed-console-n')].map((n) => n.textContent).join();
          const before = counts();
          const toggle = document.querySelectorAll('.weed-console-toggle')[index];
          toggle.click();
          const all = [...document.querySelectorAll('[data-console-rows] > div')];
          const letterOf = (row) => /weed-console-([ewlid])(\s|$)/.exec(row.className)?.[1];
          return {
            ok: all.every((row) => row.checkVisibility() === !hides.includes(letterOf(row))) && toggle.getAttribute('aria-pressed') === 'false' && counts() === before,
            hidden: all.filter((row) => !row.checkVisibility()).length,
            ofGroup: all.filter((row) => hides.includes(letterOf(row))).length,
          };
        },
        [i, letters],
      );
    const turnOn = (i) => page.locator('.weed-console-toggle').nth(i).click();
    const warnOff = await turnOff(1, ['w']);
    await shot(page, '2-warnings-off');
    await turnOn(1);
    const errorOff = await turnOff(0, ['e']);
    await turnOn(0);
    const logOff = await turnOff(2, ['l', 'i', 'd']);
    await turnOn(2);
    const back = await readConsole(page);
    check(
      'toggles',
      warnOff.ok &&
        errorOff.ok &&
        logOff.ok &&
        warnOff.hidden === warnOff.ofGroup &&
        warnOff.hidden > 0 &&
        back.rows.every((row) => row.shown) &&
        back.toggles.every((t) => t.on),
      `Warnings off hid ${warnOff.hidden} of ${warnOff.ofGroup}, Errors off ${errorOff.hidden} of ${errorOff.ofGroup}, ` +
        `Logs off ${logOff.hidden} of ${logOff.ofGroup}; counts kept; on again by a click: ${back.rows.filter((row) => row.shown).length} ` +
        `of ${back.rows.length} shown`,
    );

    // ---- search ----
    const search = page.locator('.weed-console-search');
    await search.fill('SMOKE WARNING');
    const byText = (await readRows(page)).filter((row) => row.shown).map((row) => row.text);
    await shot(page, '3-search');
    await search.fill('logic0');
    const bySource = (await readRows(page)).filter((row) => row.shown);
    await search.press('Escape');
    const cleared = await readRows(page);
    const searchBar = await readBar(page);
    check(
      'search',
      byText.join() === 'smoke warning,smoke warning 2' &&
        bySource.length > 0 &&
        bySource.every((row) => row.source.includes('logic0') || row.text.toLowerCase().includes('logic0')) &&
        searchBar.search === '' &&
        cleared.every((row) => row.shown),
      `"SMOKE WARNING": ${JSON.stringify(byText)}; "logic0": ${bySource.length} rows (sources ${[...new Set(bySource.map((r) => r.source))].join(', ')}); ` +
        `Esc: "${searchBar.search}", ${cleared.filter((row) => row.shown).length} of ${cleared.length} shown`,
    );

    // ---- scroll ----
    await log(Array.from({ length: 60 }, (_, i) => ['log', `fill ${i}`]));
    await page.waitForTimeout(SETTLE_MS);
    const filled = await readBar(page);
    const box = await page.locator('.weed-console-scroll').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(250);
    const up = await readBar(page);
    await log(Array.from({ length: 5 }, (_, i) => ['log', `while reading ${i}`]));
    await page.waitForTimeout(SETTLE_MS);
    const reading = await readBar(page);
    await shot(page, '4-new-rows');
    await page.locator('.weed-console-new').click();
    await page.waitForTimeout(150);
    const down = await readBar(page);
    await log([['warn', 'after going down']]);
    await page.waitForTimeout(SETTLE_MS);
    const following = await readBar(page);
    check(
      'scroll',
      filled.scrollable &&
        filled.atEnd &&
        !up.atEnd &&
        Math.abs(reading.scrollTop - up.scrollTop) < 1 &&
        reading.newRows === '↓ 5 new rows' &&
        down.atEnd &&
        down.newRows === null &&
        following.atEnd &&
        following.newRows === null,
      `after 60 lines at the end ${filled.atEnd}; wheel up: at ${up.scrollTop}, 5 more lines: at ${reading.scrollTop} with ` +
        `"${reading.newRows}"; the button: at the end ${down.atEnd}; one more line: at the end ${following.atEnd}`,
    );

    // ---- cap: 2,050 rows, through the panel (the console forward passes 200 calls a second) ----
    await page.click('[data-tab=debug]');
    await frame.evaluate(() => {
      const panel = globalThis.game.debugUI.hosted.console;
      panel.clear();
      for (let i = 0; i < 2050; i++) panel.add('page', i % 7 === 0 ? 'warn' : 'log', `cap row ${i}`);
      return true;
    });
    await page.waitForTimeout(300);
    const capOpened = await page.evaluate(async () => {
      const t0 = performance.now();
      document.querySelector('[data-tab=console]').click();
      await Promise.resolve();
      await Promise.resolve();
      return performance.now() - t0;
    });
    await page.waitForTimeout(SETTLE_MS);
    const capBar = await readConsole(page);
    const capRows = capBar.rows;
    await shot(page, '5-cap');
    // The talkers keep throwing: their error's report after the Clear is a row too, newer than every cap row, so
    // the rows that went are the oldest cap rows.
    const capKept = capRows.filter((row) => row.text.startsWith('cap row '));
    const firstKept = 2050 - capKept.length;
    check(
      'cap',
      capRows.length === 2000 &&
        capKept.every((row, i) => row.text === `cap row ${firstKept + i}`) &&
        capKept.at(-1)?.text === 'cap row 2049' &&
        capBar.note === `${firstKept} older rows dropped: the console keeps the newest 2,000.` &&
        capBar.toggles.map((t) => Number(t.count)).join() === sums(capRows).join() &&
        capBar.atEnd,
      `${capRows.length} rows: cap rows ${firstKept} to 2049 and ${capRows.length - capKept.length} newer; note "${capBar.note}"; ` +
        `drawn in ${capOpened.toFixed(1)} ms when the tab opened (rows and their layout)`,
    );

    // ---- stream: at the cap and shown, 20 lines a tick (the forward's 200 a second) for 2 s; each flush timed ----
    const streamed = await frame.evaluate(
      () =>
        new Promise((resolve) => {
          const panel = globalThis.game.debugUI.hosted.console;
          const flush = panel._flush;
          const t = { ms: 0, flushes: 0 };
          panel._flush = function timed() {
            const t0 = performance.now();
            flush.call(this);
            t.ms += performance.now() - t0;
            t.flushes++;
          };
          let n = 0;
          const id = setInterval(() => {
            for (let i = 0; i < 20; i++) console.log(`stream ${n++}`);
            if (n < 400) return;
            clearInterval(id);
            setTimeout(() => {
              panel._flush = flush;
              resolve(t);
            }, 400);
          }, 100);
        }),
    );
    const streamRows = await readConsole(page);
    const lastStream = streamRows.rows.filter((row) => row.text.startsWith('stream ')).at(-1)?.text;
    check(
      'stream',
      streamRows.rows.length === 2000 && lastStream === 'stream 399' && streamRows.atEnd && streamed.flushes > 0,
      `${streamRows.rows.length} rows, the last streamed "${lastStream}", at the end ${streamRows.atEnd}; ` +
        `${streamed.flushes} flushes, ${(streamed.ms / Math.max(1, streamed.flushes)).toFixed(2)} ms each on average (rows, their layout, the scroll)`,
    );

    // ---- clear ----
    await page.locator('.weed-console-clear').click();
    const emptied = await page.evaluate(() => ({
      rows: document.querySelectorAll('[data-console-rows] > div').length,
      counts: [...document.querySelectorAll('.weed-console-n')].map((n) => n.textContent),
      note: document.querySelector('.weed-console-note').checkVisibility(),
    }));
    await shot(page, '6-cleared');
    await log([['log', 'after clear']]);
    await page.waitForTimeout(SETTLE_MS);
    const again = await readRows(page);
    check(
      'clear',
      emptied.rows === 0 && emptied.counts.join() === '0,0,0' && !emptied.note && again.some((row) => row.text === 'after clear'),
      `${emptied.rows} rows, counts ${emptied.counts.join(' / ')}, note shown ${emptied.note}; then ${again.length} row(s): ` +
        `${again.map((row) => row.text).join(' | ')}`,
    );
    await page.close();

    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    console.log(`screenshots in ${shots}`);
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
