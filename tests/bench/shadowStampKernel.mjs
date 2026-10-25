/**
 * The shadow stamp kernel's setup (E-76 W23, E-114), browser-safe so Chrome can run it (chromeKernel.mjs):
 * - setupStamp: the Predator fixture as the stamp sees it, the 48 lights nearest the caster centroid,
 *   maxShadowsPerLight 512, maxShadowsPerEntity 3, casters packed as GPU_CASTER_FLOATS rows;
 * - createStampKernel: every array of that spec moved into one shared WebAssembly.Memory with the kernel's table,
 *   and the product wrapper around stamp_light_range;
 * - run: chromeKernel.mjs's entry, the shipped kernel against stampLightRange in alternating rounds.
 * shadowStampMicrobench.mjs and shadowStampWasmMicrobench.mjs time the same setup in Node.
 *
 *   node tests/bench/chromeKernel.mjs --module /tests/bench/shadowStampKernel.mjs [--args '{"rounds":7}']
 */
import { GPU_CASTER_FLOATS, GPU_CASTER_LIGHT_FLOAT } from '../../src/render/gpuQueueLayout.js';
import { stampLightRange } from '../reference/shadowStamp.mjs';
import { STAMP_SLOTS } from '../../src/render/shadowStampClient.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import { layoutRegions, NULL_GUARD_BYTES } from '../../src/util/wasmMemoryMap.js';
import { parsePredatorFixture } from './predatorFixtureParse.mjs';

const LIGHT_DOUBLES = 5;
const SLOT = Object.fromEntries(STAMP_SLOTS.map((name, k) => [name, k]));

export function setupStamp(fx, opts = {}) {
  const { x, y, active, shadowActive, shadowH, lightActive, visualRange } = fx.arrays;
  const n = fx.meta.n;
  const sf = GPU_CASTER_FLOATS;
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
    sun[c * sf + 2] = 1;
    sun[c * sf + 3] = 1;
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
    stamp: new Float32Array(stampCap * sf),
    stampFloats: sf,
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

/** The fixture's spec with every array moved into one shared memory, and the shipped kernel (`kernelUrl`) on it. */
export async function createStampKernel(fx, opts, kernelUrl) {
  const s = setupStamp(fx, opts);
  const spec = s.spec;
  const maxPE = spec.maxPerEntity | 0;
  const arrays = ['sun', 'used', 'tmpIdx', 'dist', 'order', 'keepIdx', 'gridCounts', 'gridStarts', 'gridItems', 'stamp', 'stampLightIdx'];
  const regions = [{ name: 'guard', owner: 'nobody', bytes: NULL_GUARD_BYTES }];
  for (const a of arrays) regions.push({ name: a, owner: 'pre-render', bytes: spec[a].byteLength });
  regions.push(
    { name: 'lightVec', owner: 'pre-render', bytes: 16 },
    { name: 'lights', owner: 'pre-render', bytes: spec.lights.length * LIGHT_DOUBLES * 8 },
    { name: 'nearDist', owner: 'pre-render', bytes: Math.max(1, s.sunN * maxPE) * 4 },
    { name: 'nearSlot', owner: 'pre-render', bytes: Math.max(1, s.sunN * maxPE) * 4 },
    { name: 'nearCount', owner: 'pre-render', bytes: Math.max(1, s.sunN) },
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
  const lights = new Float64Array(buffer, R.lights.byte, spec.lights.length * LIGHT_DOUBLES);
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
  put('lightFloat', GPU_CASTER_LIGHT_FLOAT);
  put('nearDist', R.nearDist.byte);
  put('nearSlot', R.nearSlot.byte);
  put('nearCount', R.nearCount.byte);

  const { stamp_light_range: stampRange } = await loadWasmKernel('shadowStamp', kernelUrl, memory, ['stamp_light_range']);
  /** The product wrapper: the light objects into the table, then one call of `fn` (a variant's export). */
  const stampWith = (fn) => {
    const L = spec.lights;
    const n = spec.lightEnd | 0;
    for (let i = 0, at = 0; i < n; i++, at += LIGHT_DOUBLES) {
      const light = L[i];
      if (!light) {
        lights[at + 3] = NaN;
        continue;
      }
      lights[at] = light.x;
      lights[at + 1] = light.y;
      lights[at + 2] = light.intensity;
      lights[at + 3] = light.rangeSq;
      lights[at + 4] = light.maxShadows;
    }
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
  const bytes = new Uint8Array(await (await fetch(new URL('../fixtures/predator-frame.bin', import.meta.url))).arrayBuffer());
  const k = await createStampKernel(parsePredatorFixture(bytes), opts, new URL('../../src/render/shadowStamp.wasm', import.meta.url));
  const sides = { wasm: k.stampWasm, js: () => stampLightRange(k.spec) };
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
    casters: k.sunN,
    lights: k.lights.length,
    maxPerEntity: k.spec.maxPerEntity,
    written,
    checksums,
    checksumsOk: checksums.wasm === checksums.js,
    rounds,
    cases: Object.fromEntries(names.map((n) => [n, { opsPerSec: medianOf(samples[n]), samples: samples[n] }])),
  };
}
