#!/usr/bin/env node
/**
 * E-187: does Pixi draw a scene's entity batch as keyed frames? Opens the scene (source tree, headed Chrome on the real
 * GPU) and reads Pixi's worker: whether the entity batch is keyed, the last keyed frame it took (-1: drawn split), its
 * pauses (KEYED_LOSS_FRAMES) and which program the mesh draws with, a few times over the run. A check, not a timing.
 *
 *   node tests/bench/keyedFramesProbe.mjs --scene /tests/bench/stressScenes/dxCaptureScene.js \
 *     --scene-export DxCaptureScene --query backend=webgpu [--query k=v ...] [--wait-ms 4000]
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticBenchmarkServer } from '../helpers/createStaticBenchmarkServer.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const argv = process.argv.slice(2);
const opts = { query: [], waitMs: 4000 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--scene') opts.scene = argv[++i];
  else if (a === '--scene-export') opts.sceneExport = argv[++i];
  else if (a === '--query') opts.query.push(argv[++i]);
  else if (a === '--wait-ms') opts.waitMs = Number(argv[++i]);
}
if (!opts.scene || !opts.sceneExport) throw new Error('usage: --scene <path> --scene-export <Class> [--query k=v]');

const server = await createStaticBenchmarkServer(repoRoot);
const browser = await chromium.launch({ headless: false, args: ['--mute-audio'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  const params = new URLSearchParams('src=1');
  for (const pair of opts.query) {
    const [k, v = ''] = pair.split('=');
    params.set(k, v);
  }
  await page.goto(`http://127.0.0.1:${server.port}/tests/bench/integratedWorkerBenchmark.html?${params}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__WEED_BENCHMARK__), undefined, { timeout: 30000 });
  await page.evaluate(({ scene, sceneExport, waitMs }) => window.__WEED_BENCHMARK__.prepare({
    warmupMs: waitMs, durationMs: 1000, sampleIntervalMs: 100, sceneModule: scene, sceneExport, canvasWidth: 1280, canvasHeight: 720,
  }), { scene: opts.scene, sceneExport: opts.sceneExport, waitMs: opts.waitMs });
  const samples = [];
  for (let k = 0; k < 4; k++) {
    await page.waitForTimeout(opts.waitMs / 4);
    for (const w of page.workers()) {
      // A worker blocked in Atomics.wait for good (the physics pthread pool's) never answers: a timeout a worker.
      const ask = w.evaluate(() => {
        const px = self.pixiRenderer;
        const b = px && px.entitiesBatch;
        if (!b) return null;
        return {
          backend: px._useWebGpu ? 'webgpu' : 'webgl',
          keyed: b.keyed,
          keyFrame: b._keyFrame,
          keyPause: b._keyPause,
          drawsKeyed: b.mesh ? b.mesh.shader === b._indexedShader : null,
          instances: b.geometry ? b.geometry.instanceCount : null,
          scatterGpu: px._staticsScatterGpu !== null && px._staticsScatterGpu !== undefined,
          statics: (() => {
            // WebGL: the statics texture read back (a framebuffer over it), each drawn instance's key's scale words: a
            // row the scatter never filled reads zeros, and its sprite draws at scale 0.
            const r = px.pixiApp && px.pixiApp.renderer;
            const gl = r && r.gl;
            if (!gl || !b._staticsSource || !b.keyed) return null;
            const tex = r.texture.getGlSource(b._staticsSource).texture;
            const w = 3072;
            const h = Math.max(1, b._staticsHeight | 0);
            const fb = gl.createFramebuffer();
            const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
            const out = new Uint32Array(w * Math.min(h, 4) * 4);
            gl.readPixels(0, 0, w, Math.min(h, 4), gl.RGBA_INTEGER, gl.UNSIGNED_INT, out);
            gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
            gl.deleteFramebuffer(fb);
            const n = b.geometry ? b.geometry.instanceCount : 0;
            let zero = 0;
            let rowsSeen = 0;
            for (let k = 0; k < n; k++) {
              const key = Math.round(b._slotData[k * 2]);
              if (key >= 1024 * 4) continue;
              rowsSeen++;
              if (out[key * 12] === 0 && out[key * 12 + 1] === 0) zero++;
            }
            return { drawn: n, read: rowsSeen, zeroScale: zero, keyRequest: b._keyRequest };
          })(),
        };
      }).catch(() => null);
      const s = await Promise.race([ask, new Promise((resolve) => setTimeout(() => resolve(null), 500))]);
      if (s) samples.push(s);
    }
  }
  console.log(JSON.stringify({ scene: opts.sceneExport, query: opts.query, samples, errors }, null, 1));
} finally {
  await browser.close();
  await server.close();
}
