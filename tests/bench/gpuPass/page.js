/**
 * The GPU pass bench's page (tests/bench/gpuPassBench.html; plan §9.3): builds one frame's passes from the engine's shader
 * sources (passes.js), draws the inputs of the passes it times once, then times each named pass: K executions between
 * two waits for the GPU (WebGL a 1 x 1 read back, WebGPU onSubmittedWorkDone), K grown until one sample takes `targetMs`,
 * `samples` samples, the clock's empty round trip taken out. With `capacity=1` it searches instead how many times a
 * frame the pass can be drawn before the presented frames drop under the display's rate (the fallback when a backend
 * hangs on the waits).
 *
 * Parameters (the page's query; gpuPassBench.mjs passes its --query through):
 *   backend=webgl|webgpu  passes=a,b (passes.js names)  width, height (1920 x 1080)  res (light pass and G-buffer,
 *   0.5)  shadowRes (sun map, 1)  lights (32)  cones (the first lights made cones, 0)  maxLights (MAX_LIGHTS and the light texture's width, 256)
 *   silhouettes (sprites and sun cards, 2000)  renders (sun columns casters, 200)  cards (card rows among the columns'
 *   instances, which cast none: 0)  lamps (48)  casters (a lamp, 64)
 *   tile (a lamp's tile texels, 256)  steps (self-shadow steps, 6)  rays (1)  format (the shadow maps' target: rgba8,
 *   r16f, r32f, rgba16f; rgba8)  mapDepth (the maps' depth buffer: 24, as Pixi's depth-stencil, or 16)  night (1: no sun term)  intBits (WebGPU i32 uniforms: 'exact', as the vendored
 *   Pixi writes them, or 'float', a float's bits: then uLightCount reads huge and the loops run to maxLights)  samples (12)  targetMs (25)  maxK (512)  warmupMs (300)  hangMs (10000)  capacity (0)
 *   floorScaleY, heightScaleY (the light bench's camera: 0.736, 0.752)  lightTile (E-205: the light passes' tiles, px of
 *   their target: 16, src/render/lightTiles.js LIGHT_TILE_PX)
 */

import { createGlBackend } from './glBackend.js';
import { createGpuBackend } from './gpuBackend.js';
import { buildFrame, loadShaders, NEEDS } from './passes.js';
import { buildScenery } from './scenery.js';

const log = (line) => {
  const el = document.getElementById('log');
  if (el) el.textContent += `${line}\n`;
};

export function readParams(search) {
  const q = new URLSearchParams(search);
  const num = (k, d) => {
    const v = q.get(k);
    const n = v === null || v === '' ? NaN : Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const int = (k, d, lo = 0) => Math.max(lo, Math.floor(num(k, d)));
  const format = ['rgba8', 'r16f', 'r32f', 'rgba16f', 'r8'].includes(q.get('format')) ? q.get('format') : 'rgba8';
  return {
    backend: q.get('backend') === 'webgpu' ? 'webgpu' : 'webgl',
    passes: (q.get('passes') || 'light').split(',').map((s) => s.trim()).filter(Boolean),
    width: int('width', 1920, 16),
    height: int('height', 1080, 16),
    res: Math.min(2, Math.max(0.05, num('res', 0.5))),
    shadowRes: Math.min(2, Math.max(0.05, num('shadowRes', 1))),
    lights: int('lights', 32),
    // DX-SPOT: the first `cones` lights are cones (their third row), as pixiWorker packs them: 0.
    cones: int('cones', 0),
    maxLights: int('maxLights', 256, 1),
    silhouettes: int('silhouettes', 2000, 1),
    renders: int('renders', 200, 1),
    cards: int('cards', 0, 0),
    lamps: int('lamps', 48, 1),
    casters: int('casters', 64, 1),
    tile: int('tile', 256, 8),
    steps: int('steps', 6, 1),
    rays: int('rays', 1, 1),
    format,
    night: q.get('night') === '1',
    intBits: q.get('intBits') === 'float' ? 'float' : 'exact',
    samples: int('samples', 12, 3),
    targetMs: Math.max(2, num('targetMs', 25)),
    maxK: int('maxK', 512, 1),
    warmupMs: Math.max(0, num('warmupMs', 300)),
    hangMs: Math.max(1000, num('hangMs', 10000)),
    capacity: q.get('capacity') === '1',
    // The shadow maps' depth buffer: 24 bits (Pixi's depth-stencil, what the engine draws with) or 16.
    mapDepth: q.get('mapDepth') === '16' ? 16 : 24,
    capacityMax: int('capacityMax', 4096, 1),
    floorScaleY: Math.min(1, Math.max(0.05, num('floorScaleY', 0.7364193217154872))),
    heightScaleY: Math.min(2, Math.max(0, num('heightScaleY', 0.7516549042792687))),
    lightTile: int('lightTile', 16, 4),
  };
}

function stats(values) {
  const v = values.slice().sort((a, b) => a - b);
  const at = (q) => {
    const x = (v.length - 1) * q;
    const lo = Math.floor(x);
    const hi = Math.ceil(x);
    return v[lo] + (v[hi] - v[lo]) * (x - lo);
  };
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) * (x - mean), 0) / Math.max(1, v.length - 1));
  const median = at(0.5);
  return { median, p25: at(0.25), p75: at(0.75), min: v[0], max: v[v.length - 1], mean, sd, spread: median > 0 ? (at(0.75) - at(0.25)) / median : 0 };
}

/** ms per execution of a pass: warm-up, K grown to `targetMs` a sample, the empty round trip taken out. */
async function timePass(backend, h, p) {
  const until = performance.now() + p.warmupMs;
  do {
    await backend.timeK(h, 1);
  } while (performance.now() < until);
  let k = 1;
  let ms = await backend.timeK(h, k);
  while (ms < p.targetMs && k < p.maxK) {
    k = Math.min(p.maxK, k * 2);
    ms = await backend.timeK(h, k);
  }
  const empty = [];
  for (let i = 0; i < 7; i++) empty.push(await backend.timeEmpty());
  const overheadMs = stats(empty).median;
  const per = [];
  for (let s = 0; s < p.samples; s++) per.push(Math.max(0, (await backend.timeK(h, k)) - overheadMs) / k);
  return { mode: 'timed', k, overheadMs, ...stats(per), samples: per };
}

/** Presented frames a second with the pass drawn n times each frame, over `ms` after a few frames to settle. */
function fpsAt(backend, h, n, ms) {
  return new Promise((resolve) => {
    let frames = -6;
    let t0 = 0;
    const tick = (now) => {
      backend.frame(h, n);
      frames++;
      if (frames === 0) t0 = now;
      if (frames > 0 && now - t0 >= ms) {
        resolve((frames * 1000) / (now - t0));
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** The capacity search: the most executions a frame that keep the display's frame rate (95 % of it, at most 58). */
async function capacityPass(backend, h, p) {
  const baselineFps = await fpsAt(backend, h, 0, 800);
  const floorFps = Math.min(58, baselineFps * 0.95);
  let lo = 0;
  let hi = 1;
  while (hi <= p.capacityMax && (await fpsAt(backend, h, hi, 600)) >= floorFps) {
    lo = hi;
    hi *= 2;
  }
  while (hi - lo > Math.max(1, Math.floor(lo * 0.05))) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await fpsAt(backend, h, mid, 600)) >= floorFps) lo = mid;
    else hi = mid;
  }
  return {
    mode: 'capacity',
    baselineFps,
    floorFps,
    passesPerFrame: lo,
    // An upper bound on a pass's GPU time: a frame's time over the passes that still fit in it.
    msPerPassBound: lo > 0 ? 1000 / baselineFps / lo : null,
  };
}

/** Share of a target's pixels that are not 0 (RGBA8 targets), so a run shows its inputs were drawn. */
async function coverage(backend, key) {
  try {
    const t = await backend.readTarget(key);
    if (!t) return null;
    let n = 0;
    for (let i = 0; i < t.data.length; i += 4) if (t.data[i] | t.data[i + 1] | t.data[i + 2] | t.data[i + 3]) n++;
    return n / (t.width * t.height);
  } catch {
    return null;
  }
}

/**
 * FNV-1a of a target's bytes after a pass was timed: the same pass must leave the same image whatever ran before it in
 * the case (a self-check: on WebGL a pass timed after another read as that one, 2026-11-15, glBackend.js's waits).
 */
async function imageHash(backend, key) {
  try {
    const t = await backend.readTarget(key);
    if (!t) return null;
    let h = 0x811c9dc5;
    for (let i = 0; i < t.data.length; i++) h = Math.imul(h ^ t.data[i], 0x01000193);
    return (h >>> 0).toString(16).padStart(8, '0');
  } catch {
    return null;
  }
}

async function run() {
  const p = readParams(location.search);
  const canvas = document.getElementById('c');
  const out = { params: p, info: null, passes: {}, inputs: {}, userAgent: navigator.userAgent };
  let backend = null;
  try {
    backend = p.backend === 'webgpu' ? await createGpuBackend(canvas, { hangMs: p.hangMs, intBits: p.intBits }) : createGlBackend(canvas);
    out.info = backend.info;
    log(`${p.backend}: ${JSON.stringify(backend.info)}`);
    const [shaders, scenery] = await Promise.all([loadShaders(), buildScenery(p)]);
    const frame = buildFrame(p, shaders, scenery, backend.kind);
    for (const [key, desc] of Object.entries(frame.textures)) backend.createTexture(key, desc);
    // The timed passes and, first, the passes whose targets they read.
    const order = [];
    for (const name of p.passes) {
      for (const need of NEEDS[name] || []) if (!order.includes(need)) order.push(need);
      if (!order.includes(name)) order.push(name);
    }
    const handles = {};
    for (const name of order) {
      const pass = frame.passes[name];
      if (!pass) {
        out.passes[name] = { error: `no pass ${name}` };
        continue;
      }
      if (pass.error) {
        out.passes[name] = { error: pass.error };
        continue;
      }
      try {
        handles[name] = await backend.createPass(pass.spec);
      } catch (err) {
        out.passes[name] = { error: String(err?.message || err) };
        log(`${name}: ${out.passes[name].error}`);
      }
    }
    for (const name of order) if (handles[name]) backend.draw(handles[name]);
    // The capacity search is the fallback for a backend whose waits hang: it waits for nothing, read backs included.
    if (!p.capacity) {
      await backend.timeEmpty();
      for (const key of ['gbuf', 'gbufFull', 'sunMap', 'lampMap']) {
        if (order.some((n) => handles[n]?.spec.targets.includes(key))) out.inputs[key] = await coverage(backend, key);
      }
    }
    for (const name of p.passes) {
      const h = handles[name];
      if (!h) continue;
      const pass = frame.passes[name];
      try {
        const r = p.capacity ? await capacityPass(backend, h, p) : await timePass(backend, h, p);
        const image = p.capacity ? null : await imageHash(backend, h.spec.targets[0]);
        const missing = (NEEDS[name] || []).filter((n) => !handles[n]);
        out.passes[name] = {
          label: pass.label,
          notes: [pass.notes, missing.length ? `inputs not drawn: ${missing.join(', ')}` : ''].filter(Boolean).join('; '),
          size: [h.width, h.height],
          instances: h.instanceCount,
          unfed: h.unknown,
          image,
          ...r,
        };
        log(`${name}: ${r.mode === 'timed' ? `${r.median.toFixed(3)} ms (K ${r.k})` : `${r.passesPerFrame} a frame`}`);
      } catch (err) {
        out.passes[name] = { error: String(err?.message || err), hang: /^hang:/.test(String(err?.message || err)) };
        log(`${name}: ${out.passes[name].error}`);
        if (out.passes[name].hang) break;
      }
    }
  } catch (err) {
    out.error = String(err?.stack || err?.message || err);
    log(out.error);
  } finally {
    try {
      backend?.destroy();
    } catch {
      // A lost device or context has nothing left to free.
    }
  }
  return out;
}

window.__GPU_PASS_BENCH__ = { run, readParams };
