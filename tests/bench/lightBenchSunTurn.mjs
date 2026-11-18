#!/usr/bin/env node
/**
 * The light bench's cars' shadows while the sun turns: the silhouette they cast (the sun's card) against the shadow of
 * their height map, the sun's Direction stepped in place (one page a side, no reload between steps). It tells whether
 * the card's shadow is where the solid's is, and whether it stays there as the sun turns or turns with it and jumps
 * back at each new frame (N-297).
 *
 *   node tests/bench/lightBenchSunTurn.mjs --out <dir> [--vs <rev>] [--hour 15] [--from 0 --to 60 --step 2.5]
 *     [--only pickup_blanco,hatch_rojo] [--car-facing 195] [--query k=v ...] [--settle-ms 350] [--fine-map]
 *
 * Sides: `card` (this tree, ?carSun=sprite), `map` (this tree, ?carSun=heightmap: the reference) and, with --vs, `base`
 * (that revision's src/ in a worktree, ?carSun=sprite; the scene is this tree's). Per step it prints the px (a channel
 * over 6 of 255 apart) where `card` and `base` differ from `map`, and the px each side changed since the step before:
 * a shadow that jumps shows as a step whose change is several times its neighbours'. Every capture is saved as
 * <out>/<side>/<turn>.png. From Git Bash set MSYS_NO_PATHCONV=1 and give --out as D:/...
 *
 * --fine-map: the height map's solid is built of columns COLUMN_CELL_PX (8) px a side, each drawn a little wider than
 * its cell, so its shadow is some 5 px larger all round than the object's: next to it a card that is right reads as
 * short. With this the reference comes from a copy of this tree (an overlay worktree) whose columns are 2 px.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { captureCanvasPng } from '../helpers/visualPngCompare.mjs';
import { ensureOverlayWorktree, ensureRevWorktree } from './revWorktree.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const VIEWPORT = { width: 1280, height: 720 };
const SCENE = '/demos/lightBenchScene/lightBenchScene.js';
const SCENE_EXPORT = 'LightBenchScene';
/** A channel this far apart (of 255) is a different pixel: under it lie the soft edges' and the dither's steps. */
const APART = 6;

function parseCli(argv) {
  const opts = { hour: 15, from: 0, to: 60, step: 2.5, only: 'pickup_blanco,hatch_rojo', carFacing: 195, query: [], settleMs: 350, waitMs: 3000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--out') opts.out = next();
    else if (arg === '--vs') opts.vs = next();
    else if (arg === '--hour') opts.hour = Number(next());
    else if (arg === '--from') opts.from = Number(next());
    else if (arg === '--to') opts.to = Number(next());
    else if (arg === '--step') opts.step = Number(next());
    else if (arg === '--only') opts.only = next();
    else if (arg === '--car-facing') opts.carFacing = Number(next());
    else if (arg === '--query') opts.query.push(next());
    else if (arg === '--settle-ms') opts.settleMs = Number(next());
    else if (arg === '--fine-map') opts.fineMap = true;
    else throw new Error(`lightBenchSunTurn: unknown argument ${arg}`);
  }
  if (!opts.out) throw new Error('lightBenchSunTurn: --out <dir> is required');
  if (!(opts.step > 0) || !(opts.to >= opts.from)) throw new Error('lightBenchSunTurn: --from, --to and --step make no steps');
  return opts;
}

/** One side: the bench loaded once, the sun turned to each step, a capture a step (PNG buffers, in the steps' order). */
async function captureSide(browser, root, opts, carSun, turns, dir) {
  const server = await createStaticBenchmarkServer(root);
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  try {
    const params = new URLSearchParams('src=1');
    params.set('only', opts.only);
    params.set('carFacing', String(opts.carFacing));
    params.set('hour', String(opts.hour));
    params.set('lamps', '0');
    params.set('sunTurn', String(turns[0]));
    params.set('carSun', carSun);
    for (const pair of opts.query) {
      const [key, value = ''] = pair.split('=');
      params.set(key, value);
    }
    await page.goto(`http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?${params}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
    await page.evaluate(
      ({ scene, sceneExport, waitMs, size }) =>
        window.__WEED_BENCHMARK__.prepare({
          warmupMs: waitMs, durationMs: 1000, sampleIntervalMs: 100, sceneModule: scene, sceneExport,
          canvasWidth: size.width, canvasHeight: size.height,
        }),
      { scene: SCENE, sceneExport: SCENE_EXPORT, waitMs: opts.waitMs, size: VIEWPORT },
    );
    await page.waitForTimeout(opts.waitMs);
    fs.mkdirSync(dir, { recursive: true });
    const pngs = [];
    for (const turn of turns) {
      await page.evaluate((v) => {
        window.scene._sunTurn = v;
        window.scene._applySun();
      }, turn);
      await page.waitForTimeout(opts.settleMs);
      const png = await captureCanvasPng(page);
      fs.writeFileSync(path.join(dir, `${String(turn).replace('-', 'm')}.png`), png);
      pngs.push(png);
    }
    if (errors.length > 0) throw new Error(`lightBenchSunTurn: the page reported errors:\n${errors.join('\n')}`);
    return pngs;
  } finally {
    await page.close();
    await server.close();
  }
}

/** The px where two captures are more than APART apart, counted in a page (the browser decodes the PNGs). */
async function apartCount(page, a, b) {
  return page.evaluate(
    async ({ a64, b64, apart }) => {
      async function load(b64s) {
        const bin = Uint8Array.from(atob(b64s), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bin], { type: 'image/png' }));
        const canvas = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      }
      const A = await load(a64);
      const B = await load(b64);
      if (A.length !== B.length) return -1;
      let n = 0;
      for (let i = 0; i < A.length; i += 4) {
        if (Math.abs(A[i] - B[i]) > apart || Math.abs(A[i + 1] - B[i + 1]) > apart || Math.abs(A[i + 2] - B[i + 2]) > apart) n++;
      }
      return n;
    },
    { a64: a.toString('base64'), b64: b.toString('base64'), apart: APART },
  );
}

const mean = (v) => v.reduce((s, x) => s + x, 0) / Math.max(1, v.length);

/** A copy of this tree whose height map's columns are 2 px a side (--fine-map): its root. */
function fineMapRoot(out) {
  const rel = 'src/render/sunShadowMap.js';
  const source = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  const coarse = 'export const COLUMN_CELL_PX = 8;';
  if (source.split(coarse).length !== 2) throw new Error(`lightBenchSunTurn: ${rel} has no "${coarse}"`);
  fs.mkdirSync(out, { recursive: true });
  const patched = path.join(out, 'sunShadowMap.fine.js');
  fs.writeFileSync(patched, source.split(coarse).join('export const COLUMN_CELL_PX = 2;'));
  return ensureOverlayWorktree('fine-map', { [rel]: patched }).root;
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  const turns = [];
  for (let t = opts.from; t <= opts.to + 1e-9; t += opts.step) turns.push(Math.round(t * 1000) / 1000);
  const baseRoot = opts.vs ? ensureRevWorktree(opts.vs, { srcOnly: true }).root : null;
  const mapRoot = opts.fineMap ? fineMapRoot(opts.out) : repoRoot;
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--mute-audio'],
  });
  try {
    const shots = {
      map: await captureSide(browser, mapRoot, opts, 'heightmap', turns, path.join(opts.out, 'map')),
      card: await captureSide(browser, repoRoot, opts, 'sprite', turns, path.join(opts.out, 'card')),
    };
    if (baseRoot) shots.base = await captureSide(browser, baseRoot, opts, 'sprite', turns, path.join(opts.out, 'base'));
    const page = await browser.newPage();
    const sides = Object.keys(shots);
    const rows = [];
    for (let k = 0; k < turns.length; k++) {
      const row = { turn: turns[k] };
      for (const side of sides) {
        if (side !== 'map') row[`${side}VsMap`] = await apartCount(page, shots[side][k], shots.map[k]);
        row[`${side}Moved`] = k > 0 ? await apartCount(page, shots[side][k], shots[side][k - 1]) : 0;
      }
      rows.push(row);
    }
    await page.close();
    const cols = Object.keys(rows[0]);
    console.log(cols.map((c) => c.padStart(10)).join(''));
    for (const r of rows) console.log(cols.map((c) => String(r[c]).padStart(10)).join(''));
    console.log('');
    for (const side of sides) {
      const moved = rows.slice(1).map((r) => r[`${side}Moved`]);
      const sorted = moved.slice().sort((a, b) => a - b);
      const median = sorted[sorted.length >> 1] ?? 0;
      let line = `${side}: a step moves ${mean(moved).toFixed(0)} px (median ${median}, most ${Math.max(0, ...moved)})`;
      if (side !== 'map') {
        const vs = rows.map((r) => r[`${side}VsMap`]);
        line += `; apart from the height map's: mean ${mean(vs).toFixed(0)} px, most ${Math.max(...vs)}`;
      }
      console.log(line);
    }
    fs.writeFileSync(path.join(opts.out, 'steps.json'), `${JSON.stringify({ opts, rows }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
