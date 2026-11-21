#!/usr/bin/env node
/**
 * The Layers panel's props on a still scene, as the panel sets them (DBG-1 to DBG-3): each step sets one layer's prop
 * through its facade on the page's main thread (`Layer.get(name).visible = false`, `.alpha = 0.5`, ...), captures the
 * canvas, puts the old value back and captures again. Per step it prints how much of the picture the change moved and
 * whether the picture came back:
 *   - changed:  pixels that differ from the picture before the step (a hidden layer that still draws reads 0);
 *   - restored: pixels that still differ after the old value is back (a still scene reads 0).
 *
 *   node tests/bench/layerPropsProbe.mjs --scene /tests/bench/stressScenes/dxCaptureScene.js --scene-export DxCaptureScene \
 *     --query shadowMaps=1 --set castedShadows.visible=false --set entities.alpha=0.5 [--vs <rev>] [--save <dir>]
 *
 * --set <layer>.<prop>=<value> (repeatable): visible (true/false), alpha (a number), blendMode or containerBlendMode
 * (a name). --vs <rev>: the scene and src/ from that revision (a src-only worktree, revWorktree.mjs) instead of this
 * tree. --wait-ms (default 3000) before the first capture, --step-ms (default 800) after each change. Headed Chrome
 * (a real GPU); --headless for a check without one. --save <dir>: each capture as a PNG. Exit 1 on a page error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';
import { captureCanvasPng, diffPngs } from '../helpers/visualPngCompare.mjs';
import { ensureRevWorktree } from './revWorktree.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const VIEWPORT = { width: 1280, height: 720 };

function parseCli(argv) {
  const opts = { query: [], sets: [], waitMs: 3000, stepMs: 800, headless: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--scene') opts.scene = next();
    else if (arg === '--scene-export') opts.sceneExport = next();
    else if (arg === '--query') opts.query.push(next());
    else if (arg === '--set') opts.sets.push(parseSet(next()));
    else if (arg === '--vs') opts.vs = next();
    else if (arg === '--wait-ms') opts.waitMs = Number(next());
    else if (arg === '--step-ms') opts.stepMs = Number(next());
    else if (arg === '--headless') opts.headless = true;
    else if (arg === '--save') opts.save = next();
    else throw new Error(`layerPropsProbe: unknown argument ${arg}`);
  }
  if (!opts.scene || !opts.sceneExport) throw new Error('layerPropsProbe: --scene and --scene-export are required');
  if (opts.sets.length === 0) throw new Error('layerPropsProbe: at least one --set <layer>.<prop>=<value>');
  return opts;
}

function parseSet(text) {
  const m = /^([^.=]+)\.(visible|alpha|blendMode|containerBlendMode)=(.*)$/.exec(text || '');
  if (!m) throw new Error(`layerPropsProbe: --set wants <layer>.<visible|alpha|blendMode|containerBlendMode>=<value>, got ${text}`);
  const [, layer, prop, raw] = m;
  const value = prop === 'visible' ? raw === 'true' : prop === 'alpha' ? Number(raw) : raw;
  return { layer, prop, value, label: text };
}

/** Sets a layer's prop through its facade on the page; returns the value it had. */
function setLayerProp(page, { layer, prop, value }) {
  return page.evaluate(async ({ layer, prop, value }) => {
    const { Layer } = await import('/src/index.js');
    const l = Layer.get(layer);
    if (!l) throw new Error(`no layer "${layer}" (layers: ${Layer.getAll().map((x) => x.name).join(', ')})`);
    const old = l[prop];
    l[prop] = value;
    return old;
  }, { layer, prop, value });
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  const root = opts.vs ? ensureRevWorktree(opts.vs, { srcOnly: true, tag: 'props' }).root : repoRoot;
  const browser = await chromium.launch({
    headless: opts.headless,
    channel: 'chrome',
    args: ['--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--enable-unsafe-webgpu'],
  });
  const server = await createStaticBenchmarkServer(root);
  const errors = [];
  let failed = false;
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    const params = new URLSearchParams('src=1');
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
      { scene: opts.scene, sceneExport: opts.sceneExport, waitMs: opts.waitMs, size: VIEWPORT },
    );
    await page.waitForTimeout(opts.waitMs);
    const diffPage = await browser.newPage();
    const save = (name, png) => {
      if (!opts.save) return;
      fs.mkdirSync(opts.save, { recursive: true });
      fs.writeFileSync(path.join(opts.save, `${name}.png`), png);
    };
    const pixels = VIEWPORT.width * VIEWPORT.height;
    const pct = (d) => `${((100 * d.differing) / pixels).toFixed(2)} % (max ${d.maxDelta})`;
    console.log(`layerPropsProbe ${opts.sceneExport} [${opts.query.join(' ')}]${opts.vs ? ` at ${opts.vs}` : ''}`);
    for (let k = 0; k < opts.sets.length; k++) {
      const step = opts.sets[k];
      const before = await captureCanvasPng(page);
      const old = await setLayerProp(page, step);
      await page.waitForTimeout(opts.stepMs);
      const during = await captureCanvasPng(page);
      await setLayerProp(page, { ...step, value: old });
      await page.waitForTimeout(opts.stepMs);
      const after = await captureCanvasPng(page);
      const changed = await diffPngs(diffPage, before, during);
      const restored = await diffPngs(diffPage, before, after);
      const tag = `${String(k + 1).padStart(2, '0')}-${step.layer}-${step.prop}-${String(step.value)}`;
      save(`${tag}-before`, before);
      save(`${tag}-during`, during);
      save(`${tag}-after`, after);
      console.log(`  ${step.label.padEnd(36)} changed ${pct(changed).padEnd(22)} restored: still differs ${pct(restored)}`);
    }
    await diffPage.close();
    await page.close();
  } finally {
    await server.close();
    await browser.close();
  }
  if (errors.length) {
    failed = true;
    console.log(`page errors: ${errors.slice(0, 5).join(' | ')}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
