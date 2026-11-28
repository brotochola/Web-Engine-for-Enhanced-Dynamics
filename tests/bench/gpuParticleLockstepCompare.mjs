#!/usr/bin/env node
/**
 * GPU particle frames in lockstep, one tree against another (E-488): the same injected steps on each side
 * (tests/bench/lockstepVisual.html, manualStep), so the same records, then the canvas compared pixel by pixel. GPU
 * Galaxy moves with the clock, so only a lockstep frame can be compared; gpuParticlesStressScene sorted among the trees
 * (sort=1) and drawn at its layer (sort=0). Each case on WebGL and WebGPU.
 *
 *   node tests/bench/gpuParticleLockstepCompare.mjs --root-a <tree> [--root-b <tree>] [--repeat]
 *     [--case galaxy,stressSort1,stressSort0] [--backend webgl,webgpu] [--steps n] [--out dir] [--headless]
 *
 * --root-a / --root-b: the trees served for side A and side B (default: this one). --repeat captures side A twice
 * first, so a difference between the sides can be read against the run-to-run one. Headed by default (WebGPU needs the
 * GPU). Captures are written to --out (default tests/results/gpu-particle-lockstep) only when the sides differ. Exit
 * 1 when any case differs.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { analyzePng, captureCanvasPng, diffPngs } from '../helpers/visualPngCompare.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const VIEWPORT = { width: 1280, height: 720 };

const CASES = {
  galaxy: {
    module: '/demos/gpuGalaxyScene/gpuGalaxyScene.js',
    exportName: 'GpuGalaxyScene',
    query: {},
    steps: 120,
  },
  stressSort1: {
    module: '/tests/bench/stressScenes/gpuParticlesStressScene.js',
    exportName: 'GpuParticlesStressScene',
    query: { sort: '1' },
    steps: 150,
  },
  stressSort0: {
    module: '/tests/bench/stressScenes/gpuParticlesStressScene.js',
    exportName: 'GpuParticlesStressScene',
    query: { sort: '0' },
    steps: 150,
  },
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

const headless = process.argv.includes('--headless');
const repeat = process.argv.includes('--repeat');
const rootA = path.resolve(arg('root-a', repoRoot));
const rootB = path.resolve(arg('root-b', repoRoot));
const caseIds = arg('case', Object.keys(CASES).join(',')).split(',');
const backends = arg('backend', 'webgl,webgpu').split(',');
const stepsOverride = Number(arg('steps', NaN));
const outDir = path.resolve(arg('out', path.join(repoRoot, 'tests', 'results', 'gpu-particle-lockstep')));

function url(port, spec, backend) {
  const q = new URLSearchParams({
    scene: 'gpuParticles',
    module: spec.module,
    export: spec.exportName,
    steps: String(Number.isFinite(stepsOverride) ? stepsOverride : spec.steps),
    dt: '16.67',
    minActive: '0',
    minLiquidFun: '0',
    minParticles: '0',
    zoom: '1',
    auto: '0',
    backend,
    ...spec.query,
  });
  return `http://127.0.0.1:${port}/tests/bench/lockstepVisual.html?${q}`;
}

async function capture(browser, href) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  try {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => Boolean(window.__weedLockstep?.ready), undefined, { timeout: 120000 });
    await page.evaluate(() => window.__weedLockstep.run());
    const png = await captureCanvasPng(page);
    return { png, errors, page };
  } catch (err) {
    await page.close();
    throw new Error(`${href}: ${err.message}${errors.length ? `\n  ${errors.slice(0, 6).join('\n  ')}` : ''}`);
  }
}

const serverA = await createStaticBenchmarkServer(rootA, 0, {});
const serverB = rootB === rootA ? serverA : await createStaticBenchmarkServer(rootB, 0, {});
const launchArgs = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
let browser;
try {
  browser = await chromium.launch({ headless, channel: 'chrome', args: launchArgs });
} catch {
  browser = await chromium.launch({ headless, args: launchArgs });
}
let differs = false;
const results = [];
try {
  console.log(`A ${rootA}\nB ${rootB}\n${browser.version()}`);
  for (const id of caseIds) {
    const spec = CASES[id];
    if (!spec) throw new Error(`unknown case ${id} (${Object.keys(CASES).join(', ')})`);
    for (const backend of backends) {
      const a = await capture(browser, url(serverA.port, spec, backend));
      const look = await analyzePng(a.page, a.png);
      let again = null;
      if (repeat) {
        const a2 = await capture(browser, url(serverA.port, spec, backend));
        again = await diffPngs(a2.page, a.png, a2.png);
        await a2.page.close();
      }
      const b = await capture(browser, url(serverB.port, spec, backend));
      const diff = await diffPngs(b.page, a.png, b.png);
      await b.page.close();
      await a.page.close();
      const same = diff.sameSize !== false && diff.differing === 0;
      const errors = [...a.errors, ...b.errors];
      results.push({ id, backend, nonBlack: look.nonBlack, differing: diff.differing, maxDelta: diff.maxDelta, repeat: again?.differing ?? null, errors: errors.length });
      console.log(
        `${id} ${backend}: ${diff.differing} of ${diff.pixels} pixels differ (max delta ${diff.maxDelta}); ` +
          `${look.nonBlack} lit on A` + (again ? `; A against A ${again.differing}` : '') +
          (errors.length ? `; page errors: ${errors.slice(0, 3).join(' | ')}` : '') + ` -> ${same ? 'same' : 'DIFFER'}`,
      );
      if (!same || look.nonBlack === 0) {
        differs = true;
        await fs.mkdir(outDir, { recursive: true });
        await fs.writeFile(path.join(outDir, `${id}-${backend}-A.png`), a.png);
        await fs.writeFile(path.join(outDir, `${id}-${backend}-B.png`), b.png);
      }
    }
  }
} finally {
  await browser.close();
  await serverA.close();
  if (serverB !== serverA) await serverB.close();
}
if (differs) console.log(`captures in ${outDir}`);
process.exit(differs ? 1 : 0);
