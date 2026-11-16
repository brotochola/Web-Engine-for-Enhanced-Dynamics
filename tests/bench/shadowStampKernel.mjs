/**
 * The shadow stamp kernel's setup (E-76 W23, E-114), browser-safe so Chrome can run it (chromeKernel.mjs):
 * - setupStamp: the Predator fixture as the stamp sees it, the 48 lights nearest the caster centroid,
 *   maxShadowsPerLight 512, maxShadowsPerEntity 3, casters packed as GPU_CASTER_FLOATS rows;
 * - setupLampStamp: lampShadowStressScene's lamps and walkers (128 and 6000 by default), maxShadowsPerLight 15: each lamp
 *   keeps 15 of hundreds of candidates;
 * - createStampKernel: every array of that spec moved into one shared WebAssembly.Memory with the kernel's table,
 *   and the product wrapper around stamp_light_range;
 * - run: chromeKernel.mjs's entry, the shipped kernel against stampLightRange in alternating rounds.
 * shadowStampMicrobench.mjs and shadowStampWasmMicrobench.mjs time the same setup in Node.
 *
 * E-195: `variants` picks the sides (`wasm`, `js`, and the float32 test module's `wasm-f32` and `wasm-f32x4`,
 * tests/fixtures/wasm/shadowStampF32.wasm), and `keyed` packs the casters as E-191 step 2's keyed rows (7 floats, the
 * stamp's 11, the light after the seventh), which pre-render stamps in Predator; the JS reads full rows only.
 *
 *   node tests/bench/chromeKernel.mjs --module /tests/bench/shadowStampKernel.mjs [--args '{"rounds":7}']
 *   node tests/bench/chromeKernel.mjs --module /tests/bench/shadowStampKernel.mjs \
 *     --args '{"variants":"wasm,wasm-f32x4","keyed":true}'
 * `other` is stamp_light_range from another engine.wasm (`otherWasm`: its path as the server serves it), so two builds
 * of the stamp alternate in one page on the same frame; `setup` "lamp" stamps setupLampStamp's frame instead of the
 * fixture (`lamps`, `walkers`, `maxPerLight`, `maxPerEntity` as setupLampStamp takes them):
 *     --args '{"variants":"wasm,other","otherWasm":"/tests/results/stamp-variants/b.wasm","setup":"lamp","maxPerEntity":3}'
 */
import {
  GPU_CASTER_FLOATS,
  GPU_CASTER_LIGHT_FLOAT,
  GPU_KEYED_CASTER_FLOATS,
  GPU_KEYED_STAMP_FLOATS,
} from '../../src/render/gpuQueueLayout.js';
import { stampLightRange } from '../reference/shadowStamp.mjs';
import { STAMP_SLOTS, writeStampLights } from '../../src/render/shadowStampClient.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import { layoutRegions, NULL_GUARD_BYTES, STAMP_LIGHT_DOUBLES } from '../../src/util/wasmMemoryMap.js';
import { mulberry32 } from './benchMath.js';
import { parsePredatorFixture } from './predatorFixtureParse.mjs';

const SLOT = Object.fromEntries(STAMP_SLOTS.map((name, k) => [name, k]));

export function setupStamp(fx, opts = {}) {
  const { x, y, active, shadowActive, shadowH, lightActive, visualRange } = fx.arrays;
  const n = fx.meta.n;
  // E-195: keyed rows are x, y, the key, a zero and the shadow terms; a full row's x and y lead it too.
  const keyed = opts.keyed === true;
  const sf = keyed ? GPU_KEYED_CASTER_FLOATS : GPU_CASTER_FLOATS;
  const stampFloats = keyed ? GPU_KEYED_STAMP_FLOATS : sf;
  const casters = [];
  for (let i = 0; i < n; i++) if (active[i] && shadowActive[i] && shadowH[i] > 0) casters.push(i);
  const sunN = casters.length;
  const sun = new Float32Array(sunN * sf);
  let cx = 0;
  let cy = 0;
  for (let c = 0; c < sunN; c++) {
    const i = casters[c];
    sun[c * sf] = x[i];
    sun[c * sf + 1] = y[i];
    if (keyed) {
      sun[c * sf + 2] = i;
      sun[c * sf + 4] = shadowH[i];
    } else {
      sun[c * sf + 2] = 1;
      sun[c * sf + 3] = 1;
    }
    cx += x[i];
    cy += y[i];
  }
  cx /= sunN || 1;
  cy /= sunN || 1;
  const lightsAll = [];
  for (let i = 0; i < n; i++) {
    if (!active[i] || !lightActive[i]) continue;
    const range = visualRange[i] > 0 ? visualRange[i] : 400;
    lightsAll.push({ id: i, x: x[i], y: y[i], intensity: 1, rangeSq: range * range, maxShadows: 0, d: (x[i] - cx) ** 2 + (y[i] - cy) ** 2 });
  }
  lightsAll.sort((a, b) => a.d - b.d || a.id - b.id);
  const lights = lightsAll.slice(0, opts.maxLights ?? fx.meta.lighting?.maxShadowCastingLights ?? 48);
  const maxPL = opts.maxPerLight ?? fx.meta.lighting?.maxShadowsPerLight ?? 512;
  const maxPE = opts.maxPerEntity ?? fx.meta.lighting?.maxShadowsPerEntity ?? 3;
  const stampCap = 30000;
  const spec = {
    sun,
    sunN,
    sunFloats: sf,
    lights,
    lightBegin: 0,
    lightEnd: lights.length,
    lightStride: 1,
    maxPerLight: maxPL,
    maxPerEntity: maxPE,
    used: new Uint8Array(sunN),
    tmpIdx: new Uint32Array(sunN),
    dist: new Float32Array(sunN),
    order: new Uint32Array(sunN),
    keepIdx: new Uint32Array(sunN),
    gridCounts: new Int32Array(128 * 128),
    gridStarts: new Int32Array(128 * 128 + 1),
    gridItems: new Uint32Array(sunN),
    stamp: new Float32Array(stampCap * stampFloats),
    stampFloats,
    lightFloat: keyed ? GPU_KEYED_CASTER_FLOATS : GPU_CASTER_LIGHT_FLOAT,
    stampCap,
    stampBase: 0,
    stampLightIdx: new Uint16Array(stampCap),
    lightVec: new Float32Array(4),
  };
  // Per-light candidate sets (every caster within range), for the takeClosest case.
  const candidates = lights.map((L) => {
    const ids = [];
    const d = [];
    for (let c = 0; c < sunN; c++) {
      const dx = sun[c * sf] - L.x;
      const dy = sun[c * sf + 1] - L.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= L.rangeSq) {
        ids.push(c);
        d.push(d2);
      }
    }
    return { idx: Uint32Array.from(ids), dist: Float32Array.from(d) };
  });
  return { spec, sunN, lights, candidates, maxPL };
}

/**
 * lampShadowStressScene's frame as the stamp sees it, the shape setupStamp returns: its lamps on a jittered grid over
 * 2400 x 1400 px (radius 300 to 380 px, their shadows' range; point lights at full shade) and its walkers where they
 * stand after their first step, from the scene's own seed and draws. maxShadowsPerLight 15 and maxShadowsPerEntity 0 by
 * default (the scene's: lighting's defaults, and no adaptive budget under lampShadows 'map'), so each lamp keeps 15
 * of the ~570 walkers in its range: the selection with m >> lim.
 * @param {{ lamps?: number, walkers?: number, maxPerLight?: number, maxPerEntity?: number, stampCap?: number }} [opts]
 */
export function setupLampStamp(opts = {}) {
  const W = 2400;
  const H = 1400;
  const nLamps = Math.max(1, opts.lamps ?? 128);
  const nWalkers = Math.max(1, opts.walkers ?? 6000);
  const rng = mulberry32(0x1a3b);
  const cols = Math.ceil(Math.sqrt(nLamps * (W / H)));
  const rows = Math.ceil(nLamps / cols);
  const lights = [];
  for (let i = 0; i < nLamps; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = ((c + 0.5) / cols) * W + (rng() - 0.5) * 60;
    const y = ((r + 0.5) / rows) * H + (rng() - 0.5) * 60;
    const radius = 300 + rng() * 80;
    rng(); // the sway's phase
    lights.push({ id: i, x, y, intensity: (radius * radius) / 100, rangeSq: radius * radius, maxShadows: 0 });
  }
  const sf = GPU_CASTER_FLOATS;
  const sun = new Float32Array(nWalkers * sf);
  for (let c = 0; c < nWalkers; c++) {
    const cx = rng() * W;
    const cy = rng() * H;
    const loop = 20 + rng() * 60;
    rng(); // speed
    const phase = rng() * 6.283;
    rng(); // scale
    sun[c * sf] = cx + Math.cos(phase) * loop;
    sun[c * sf + 1] = cy + Math.sin(phase) * loop * 0.6;
    sun[c * sf + 2] = 1;
    sun[c * sf + 3] = 1;
  }
  const maxPL = opts.maxPerLight ?? 15;
  const maxPE = opts.maxPerEntity ?? 0;
  const stampCap = opts.stampCap ?? 100000;
  const spec = {
    sun,
    sunN: nWalkers,
    sunFloats: sf,
    lights,
    lightBegin: 0,
    lightEnd: lights.length,
    lightStride: 1,
    maxPerLight: maxPL,
    maxPerEntity: maxPE,
    used: new Uint8Array(nWalkers),
    tmpIdx: new Uint32Array(nWalkers),
    dist: new Float32Array(nWalkers),
    order: new Uint32Array(nWalkers),
    keepIdx: new Uint32Array(nWalkers),
    gridCounts: new Int32Array(128 * 128),
    gridStarts: new Int32Array(128 * 128 + 1),
    gridItems: new Uint32Array(nWalkers),
    stamp: new Float32Array(stampCap * sf),
    stampFloats: sf,
    lightFloat: GPU_CASTER_LIGHT_FLOAT,
    stampCap,
    stampBase: 0,
    stampLightIdx: new Uint16Array(stampCap),
    lightVec: new Float32Array(4),
  };
  const candidates = lights.map((L) => {
    const ids = [];
    const d = [];
    for (let c = 0; c < nWalkers; c++) {
      const dx = sun[c * sf] - L.x;
      const dy = sun[c * sf + 1] - L.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= L.rangeSq) {
        ids.push(c);
        d.push(d2);
      }
    }
    return { idx: Uint32Array.from(ids), dist: Float32Array.from(d) };
  });
  return { spec, sunN: nWalkers, lights, candidates, maxPL };
}

/** The fixture's spec with every array moved into one shared memory, and the shipped kernel (`kernelUrl`) on it. */
export async function createStampKernel(fx, opts, kernelUrl) {
  return createStampKernelFor(setupStamp(fx, opts), kernelUrl);
}

/** createStampKernel for a setup already made (setupStamp's or setupLampStamp's). */
export async function createStampKernelFor(s, kernelUrl) {
  const spec = s.spec;
  const maxPE = spec.maxPerEntity | 0;
  const arrays = ['sun', 'used', 'tmpIdx', 'dist', 'order', 'keepIdx', 'gridCounts', 'gridStarts', 'gridItems', 'stamp', 'stampLightIdx'];
  const regions = [{ name: 'guard', owner: 'nobody', bytes: NULL_GUARD_BYTES }];
  for (const a of arrays) regions.push({ name: a, owner: 'pre-render', bytes: spec[a].byteLength });
  regions.push(
    { name: 'lightVec', owner: 'pre-render', bytes: 16 },
    { name: 'lights', owner: 'pre-render', bytes: spec.lights.length * STAMP_LIGHT_DOUBLES * 8 },
    // 8 bytes a slot: room for a record of the distance and the light side by side (E-358), a float array before it.
    { name: 'nearDist', owner: 'pre-render', bytes: Math.max(1, s.sunN * maxPE) * 8 },
    { name: 'nearSlot', owner: 'pre-render', bytes: Math.max(1, s.sunN * maxPE) * 4 },
    { name: 'nearCount', owner: 'pre-render', bytes: Math.max(1, s.sunN) },
    { name: 'packedX', owner: 'pre-render', bytes: Math.max(1, s.sunN) * 4 },
    { name: 'packedY', owner: 'pre-render', bytes: Math.max(1, s.sunN) * 4 },
    { name: 'cellOf', owner: 'pre-render', bytes: Math.max(1, s.sunN) * 4 },
    { name: 'dist64', owner: 'pre-render', bytes: Math.max(1, s.sunN) * 8 },
    { name: 'table', owner: 'pre-render', bytes: STAMP_SLOTS.length * 4 },
  );
  const layout = layoutRegions(regions);
  const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages, shared: true });
  const buffer = memory.buffer;
  const R = layout.regions;
  for (const a of arrays) {
    const view = new spec[a].constructor(buffer, R[a].byte, spec[a].length);
    view.set(spec[a]);
    spec[a] = view;
  }
  spec.lightVec = new Float32Array(buffer, R.lightVec.byte, 4);
  const lights = new Float64Array(buffer, R.lights.byte, spec.lights.length * STAMP_LIGHT_DOUBLES);
  const t = new Uint32Array(buffer, R.table.byte, STAMP_SLOTS.length);
  const put = (slot, v) => { t[SLOT[slot]] = v; };
  put('sun', spec.sun.byteOffset);
  put('sunN', spec.sunN);
  put('sunFloats', spec.sunFloats);
  put('lights', R.lights.byte);
  put('lightBegin', spec.lightBegin);
  put('lightEnd', spec.lightEnd);
  put('lightStride', spec.lightStride);
  put('maxPL', spec.maxPerLight);
  put('maxPE', maxPE);
  put('tmpIdx', spec.tmpIdx.byteOffset);
  put('dist', spec.dist.byteOffset);
  put('order', spec.order.byteOffset);
  put('keep', spec.keepIdx.byteOffset);
  put('tmpCap', spec.tmpIdx.length);
  put('gridCounts', spec.gridCounts.byteOffset);
  put('gridStarts', spec.gridStarts.byteOffset);
  put('gridItems', spec.gridItems.byteOffset);
  put('gridCountsCap', spec.gridCounts.length);
  put('gridItemsCap', spec.gridItems.length);
  put('stamp', spec.stamp.byteOffset);
  put('stampFloats', spec.stampFloats);
  put('stampCap', spec.stampCap);
  put('stampBase', spec.stampBase);
  put('stampLightIdx', spec.stampLightIdx.byteOffset);
  put('lightFloat', spec.lightFloat);
  put('nearDist', R.nearDist.byte);
  put('nearSlot', R.nearSlot.byte);
  put('nearCount', R.nearCount.byte);
  put('packedX', R.packedX.byte);
  put('packedY', R.packedY.byte);
  put('cellOf', R.cellOf.byte);
  put('dist64', R.dist64.byte);

  const { stamp_light_range: stampRange } = await loadWasmKernel('shadowStamp', kernelUrl, memory, ['stamp_light_range']);
  /** The product wrapper: the light objects into the table (the product's writer), then one call of `fn` (a variant's export). */
  const stampWith = (fn) => {
    writeStampLights(lights, spec.lights, spec.lightEnd | 0);
    return fn(R.table.byte);
  };
  return { ...s, spec, memory, stampWasm: () => stampWith(stampRange), stampWith, stampRange };
}

/** FNV-1a over the stamp rows written (as float32 bit patterns) and their light indices, and the cursor. */
export function stampChecksum(spec, written) {
  const words = new Uint32Array(spec.stamp.buffer, spec.stamp.byteOffset, written * spec.stampFloats);
  let h = Math.imul(2166136261 ^ written, 16777619) >>> 0;
  for (let i = 0; i < words.length; i++) h = Math.imul(h ^ words[i], 16777619) >>> 0;
  for (let i = 0; i < written; i++) h = Math.imul(h ^ spec.stampLightIdx[i], 16777619) >>> 0;
  return h >>> 0;
}

function medianOf(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Ops a second over `iterations` calls. */
function timeOps(op, iterations) {
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) op();
  return (iterations * 1000) / (performance.now() - t0);
}

/** chromeKernel.mjs entry: the shipped kernel and the JS on the fixture, alternating rounds of at least minMs. */
export async function run(args = {}) {
  const rounds = Number(args.rounds ?? 7);
  const minMs = Number(args.minMs ?? 200);
  const opts = args.maxPerEntity !== undefined ? { maxPerEntity: Number(args.maxPerEntity) } : {};
  if (args.keyed === true) opts.keyed = true;
  const kernelUrl = new URL('../../src/wasm/engine.wasm', import.meta.url);
  let k;
  if (args.setup === 'lamp') {
    if (opts.keyed) throw new Error('the lamp frame stamps full rows only');
    const lampOpts = { ...opts };
    for (const key of ['lamps', 'walkers', 'maxPerLight']) if (args[key] !== undefined) lampOpts[key] = Number(args[key]);
    k = await createStampKernelFor(setupLampStamp(lampOpts), kernelUrl);
  } else {
    const bytes = new Uint8Array(await (await fetch(new URL('../fixtures/predator-frame.bin', import.meta.url))).arrayBuffer());
    k = await createStampKernel(parsePredatorFixture(bytes), opts, kernelUrl);
  }
  const f32Url = new URL('../fixtures/wasm/shadowStampF32.wasm', import.meta.url);
  const variants = String(args.variants ?? 'wasm,js').split(',');
  const sides = {};
  for (const v of variants) {
    if (v === 'wasm') sides.wasm = k.stampWasm;
    else if (v === 'js') {
      if (opts.keyed) throw new Error('the JS stamps full rows only');
      sides.js = () => stampLightRange(k.spec);
    } else if (v === 'other') {
      if (typeof args.otherWasm !== 'string') throw new Error('the other side needs otherWasm (a served engine.wasm)');
      const m = await loadWasmKernel('shadowStamp', new URL(args.otherWasm, location.href), k.memory, ['stamp_light_range']);
      sides.other = () => k.stampWith(m.stamp_light_range);
    } else if (v === 'wasm-f32' || v === 'wasm-f32x4') {
      const fn = v === 'wasm-f32' ? 'stamp_light_range_f32' : 'stamp_light_range_f32x4';
      const m = await loadWasmKernel('shadowStampF32', f32Url, k.memory, [fn]);
      sides[v] = () => k.stampWith(m[fn]);
    } else throw new Error(`unknown variant ${v}`);
  }
  const checksums = {};
  const written = {};
  for (const [name, op] of Object.entries(sides)) {
    written[name] = op();
    checksums[name] = stampChecksum(k.spec, written[name]);
    for (let i = 0; i < 300; i++) op();
  }
  const iterations = {};
  for (const [name, op] of Object.entries(sides)) {
    let n = 1;
    for (;;) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) op();
      if (performance.now() - t0 >= minMs) break;
      n *= 2;
    }
    iterations[name] = n;
  }
  const names = Object.keys(sides);
  const samples = Object.fromEntries(names.map((n) => [n, []]));
  for (let r = 0; r < rounds; r++) {
    for (const name of r % 2 === 0 ? names : [...names].reverse()) samples[name].push(timeOps(sides[name], iterations[name]));
  }
  return {
    feature: 'shadow-stamp-chrome',
    setup: args.setup === 'lamp' ? 'lamp' : 'predator-fixture',
    otherWasm: typeof args.otherWasm === 'string' ? args.otherWasm : null,
    casters: k.sunN,
    lights: k.lights.length,
    maxPerEntity: k.spec.maxPerEntity,
    keyed: opts.keyed === true,
    written,
    checksums,
    // A float32 side may keep another caster where two distances tie within float rounding (shadowStampF32.test.js
    // holds that tolerance in Node): a differing checksum here is reported, not refused.
    checksumsOk: Object.values(checksums).every((c) => c === checksums[variants[0]]),
    rounds,
    cases: Object.fromEntries(names.map((n) => [n, { opsPerSec: medianOf(samples[n]), samples: samples[n] }])),
  };
}
