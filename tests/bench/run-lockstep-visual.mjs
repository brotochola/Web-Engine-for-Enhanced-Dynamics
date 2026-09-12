/**
 * Manual headed lockstep visual suite.
 *
 * Same-commit two-run (default): each catalog scene,  N × 16.67ms injected steps,
 * screenshot + pose/LF hash. Fail on black / hash miss / pixel drift.
 * Pass deletes PNGs. Fail keeps them under tests/results/.
 *
 * Hyp:
 *   pnpm test:visual --save
 *   # edit
 *   pnpm test:visual --against
 *
 * Flags: --headless  --bundle  --scene balls,water  --steps 90
 *
 * Not wired into pnpm test / test:all.
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import {
  analyzePng,
  captureCanvasPng,
  diffPngs,
  verdictFromDiff,
} from '../helpers/visualPngCompare.mjs';
import { resolveLockstepScenes } from './lockstepVisualScenes.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const resultsDir = path.join(repoRoot, 'tests', 'results');
const scratchDir = path.join(resultsDir, 'visual-scratch');
const runDir = path.join(resultsDir, 'visual-run');
const VIEWPORT = { width: 1280, height: 720 };

function parseArgs(argv) {
  const parsed = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i++;
    }
  }
  return parsed;
}

async function launchBrowser(headed) {
  const args = [
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ];
  try {
    return await chromium.launch({ headless: !headed, channel: 'chrome', args });
  } catch {
    return await chromium.launch({ headless: !headed, args });
  }
}

function sceneUrl(port, spec, { bundle, stepsOverride }) {
  const q = new URLSearchParams({
    scene: spec.id,
    module: spec.module,
    export: spec.exportName,
    steps: String(stepsOverride || spec.steps),
    dt: String(spec.dtMs),
    minActive: String(spec.minActive),
    minLiquidFun: String(spec.minLiquidFun),
    minParticles: String(spec.minParticles),
    zoom: String(spec.zoom),
    auto: '0',
  });
  if (Number.isFinite(spec.centerX) && Number.isFinite(spec.centerY)) {
    q.set('centerX', String(spec.centerX));
    q.set('centerY', String(spec.centerY));
  }
  if (bundle) q.set('bundle', '1');
  return `http://127.0.0.1:${port}/tests/bench/lockstep-visual.html?${q}`;
}

async function runScene(browser, url) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => Boolean(window.__weedLockstep?.ready), undefined, {
      timeout: 120000,
    });
    const snap = await page.evaluate(() => window.__weedLockstep.run());
    const png = await captureCanvasPng(page);
    const analysis = await analyzePng(page, png);
    return { snap, png, analysis };
  } catch (err) {
    const lockstep = await page.evaluate(() => window.__weedLockstep || null).catch(() => null);
    console.error('lockstep visual failed:', err.message);
    console.error('  __weedLockstep:', lockstep);
    if (errors.length) {
      console.error('  page errors:');
      for (const e of errors.slice(0, 16)) console.error('   ', e);
    }
    throw err;
  } finally {
    await page.close();
  }
}

function hashesMatch(a, b) {
  return (
    a.transforms.hash === b.transforms.hash &&
    a.transforms.count === b.transforms.count &&
    a.liquidFun.hash === b.liquidFun.hash &&
    a.liquidFun.count === b.liquidFun.count
  );
}

function isPixelOk(verdict, { acceptNear, failOnNear }) {
  if (verdict === 'exact') return true;
  if (verdict === 'near' && acceptNear && !failOnNear) return true;
  return false;
}

function gateFail(spec, { black, hashMatch, pixelOkFlag }) {
  if (black) return true;
  if (spec.match === 'not-black') return false;
  return !hashMatch || !pixelOkFlag;
}

function roundStepMs(stepMs) {
  const out = {};
  for (const [k, v] of Object.entries(stepMs || {})) {
    out[k] = Math.round((Number(v) || 0) * 100) / 100;
  }
  return out;
}

async function rmDirIfExists(dir) {
  await fsPromises.rm(dir, { recursive: true, force: true });
}

const args = parseArgs(process.argv.slice(2));
const headed = !args.headless;
const save = Boolean(args.save);
const against = Boolean(args.against);
const bundle = Boolean(args.bundle);
const sceneIds = typeof args.scene === 'string'
  ? args.scene.split(',').map((s) => s.trim()).filter(Boolean)
  : [];
const stepsOverride = args.steps ? Math.max(1, Number(args.steps)) : 0;
const failOnNear = args['fail-on-near'] === true;
const acceptNear = args.near === true;

if (save && against) {
  console.error('use --save or --against, not both');
  process.exit(1);
}

const scenes = resolveLockstepScenes(sceneIds);
await fsPromises.mkdir(resultsDir, { recursive: true });

const server = await createStaticBenchmarkServer(repoRoot);
let browser;
let exitCode = 0;
const report = {
  headed,
  bundle,
  save,
  against,
  scenes: [],
};

try {
  browser = await launchBrowser(headed);
  console.log(`lockstep visual ${headed ? 'headed' : 'headless'} src=${bundle ? 'dist' : 'src'}`);
  await fsPromises.mkdir(runDir, { recursive: true });
  if (save) await fsPromises.mkdir(scratchDir, { recursive: true });

  const diffPage = await browser.newPage();

  for (const spec of scenes) {
    const url = sceneUrl(server.port, spec, { bundle, stepsOverride });
    console.log(`scene ${spec.id} ${spec.exportName} steps=${stepsOverride || spec.steps}`);

    if (save) {
      const a = await runScene(browser, url);
      const pngPath = path.join(scratchDir, `${spec.id}.png`);
      const jsonPath = path.join(scratchDir, `${spec.id}.json`);
      await fsPromises.writeFile(pngPath, a.png);
      await fsPromises.writeFile(
        jsonPath,
        JSON.stringify({ snap: a.snap, analysis: a.analysis, stepMs: roundStepMs(a.snap.stepMs) }, null, 2),
      );
      const black = a.analysis.nonBlack === 0;
      const row = {
        id: spec.id,
        mode: 'save',
        hash: a.snap.transforms,
        liquidFun: a.snap.liquidFun,
        stepMs: roundStepMs(a.snap.stepMs),
        analysis: a.analysis,
        black,
        png: pngPath,
      };
      report.scenes.push(row);
      console.log(
        `  saved ${spec.id} hash=${a.snap.transforms.hash} lf=${a.snap.liquidFun.hash} nonBlack=${a.analysis.nonBlack} particleStepMs=${row.stepMs.particle}`,
      );
      if (black) {
        console.error(`FAIL ${spec.id}: canvas black`);
        exitCode = 1;
      }
      continue;
    }

    if (against) {
      const basePng = path.join(scratchDir, `${spec.id}.png`);
      const baseJson = path.join(scratchDir, `${spec.id}.json`);
      if (!fs.existsSync(basePng) || !fs.existsSync(baseJson)) {
        console.error(`FAIL ${spec.id}: no --save baseline at ${basePng}`);
        exitCode = 1;
        report.scenes.push({ id: spec.id, mode: 'against', error: 'missing-baseline' });
        continue;
      }
      const baseline = JSON.parse(await fsPromises.readFile(baseJson, 'utf8'));
      const b = await runScene(browser, url);
      const nowPng = path.join(runDir, `${spec.id}-against.png`);
      await fsPromises.writeFile(nowPng, b.png);
      const diff = await diffPngs(diffPage, await fsPromises.readFile(basePng), b.png);
      const black = b.analysis.nonBlack === 0 || baseline.analysis?.nonBlack === 0;
      const hashMatch = hashesMatch(baseline.snap, b.snap);
      const verdict = verdictFromDiff({
        black,
        differing: diff.differing,
        pixels: diff.pixels,
        maxDelta: diff.maxDelta,
      });
      const pixelOkFlag = isPixelOk(verdict, { acceptNear, failOnNear });
      const row = {
        id: spec.id,
        mode: 'against',
        match: spec.match || 'exact',
        hashMatch,
        verdict,
        diff,
        baseline: {
          hash: baseline.snap.transforms,
          liquidFun: baseline.snap.liquidFun,
          stepMs: roundStepMs(baseline.snap.stepMs),
        },
        now: {
          hash: b.snap.transforms,
          liquidFun: b.snap.liquidFun,
          stepMs: roundStepMs(b.snap.stepMs),
          analysis: b.analysis,
        },
      };
      report.scenes.push(row);
      console.log(
        `  ${spec.id} [${spec.match || 'exact'}] CPU ${hashMatch ? 'MATCH' : 'MISMATCH'} pixels ${verdict} ` +
          `differing=${diff.differing}/${diff.pixels} ` +
          `particleStepMs ${row.baseline.stepMs.particle} -> ${row.now.stepMs.particle}`,
      );
      if (gateFail(spec, { black, hashMatch, pixelOkFlag })) {
        console.error(`FAIL ${spec.id}`);
        exitCode = 1;
      }
      continue;
    }

    if (spec.match === 'not-black') {
      const a = await runScene(browser, url);
      const pathA = path.join(runDir, `${spec.id}.png`);
      await fsPromises.writeFile(pathA, a.png);
      const black = a.analysis.nonBlack === 0;
      const row = {
        id: spec.id,
        mode: 'not-black',
        match: 'not-black',
        hash: a.snap.transforms,
        liquidFun: a.snap.liquidFun,
        stepMs: roundStepMs(a.snap.stepMs),
        analysis: a.analysis,
      };
      report.scenes.push(row);
      console.log(
        `  ${spec.id} [not-black] hash=${a.snap.transforms.hash} lf=${a.snap.liquidFun.hash} ` +
          `nonBlack=${a.analysis.nonBlack} particleStepMs=${row.stepMs.particle}`,
      );
      if (black) {
        console.error(`FAIL ${spec.id}: canvas black`);
        exitCode = 1;
      }
      continue;
    }

    const a = await runScene(browser, url);
    const b = await runScene(browser, url);
    const pathA = path.join(runDir, `${spec.id}-a.png`);
    const pathB = path.join(runDir, `${spec.id}-b.png`);
    await fsPromises.writeFile(pathA, a.png);
    await fsPromises.writeFile(pathB, b.png);
    const diff = await diffPngs(diffPage, a.png, b.png);
    const black = a.analysis.nonBlack === 0 || b.analysis.nonBlack === 0;
    const hashMatch = hashesMatch(a.snap, b.snap);
    const verdict = verdictFromDiff({
      black,
      differing: diff.differing,
      pixels: diff.pixels,
      maxDelta: diff.maxDelta,
    });
    const pixelOkFlag = isPixelOk(verdict, { acceptNear, failOnNear });
    const row = {
      id: spec.id,
      mode: 'two-run',
      match: spec.match || 'exact',
      hashMatch,
      verdict,
      diff,
      runA: {
        hash: a.snap.transforms,
        liquidFun: a.snap.liquidFun,
        stepMs: roundStepMs(a.snap.stepMs),
        analysis: a.analysis,
      },
      runB: {
        hash: b.snap.transforms,
        liquidFun: b.snap.liquidFun,
        stepMs: roundStepMs(b.snap.stepMs),
        analysis: b.analysis,
      },
    };
    report.scenes.push(row);
    console.log(
      `  ${spec.id} CPU ${hashMatch ? 'MATCH' : 'MISMATCH'} pixels ${verdict} ` +
        `differing=${diff.differing}/${diff.pixels} ` +
        `nonBlack=${a.analysis.nonBlack}/${b.analysis.nonBlack} ` +
        `particleStepMs=${row.runA.stepMs.particle}`,
    );
    if (gateFail(spec, { black, hashMatch, pixelOkFlag })) {
      console.error(`FAIL ${spec.id}`);
      exitCode = 1;
    }
  }

  await diffPage.close();
} finally {
  if (browser) await browser.close();
  await server.close();
}

const reportPath = path.join(resultsDir, 'lockstep-visual-report.json');
await fsPromises.writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(`wrote ${reportPath}`);

if (exitCode === 0 && !save) {
  await rmDirIfExists(runDir);
  await fsPromises.rm(reportPath, { force: true });
  if (against) await rmDirIfExists(scratchDir);
  console.log('PASS: deleted run PNGs' + (against ? ' and scratch baseline' : ''));
} else if (exitCode !== 0) {
  console.error('FAIL: PNGs kept for inspection under tests/results/');
}

process.exit(exitCode);
