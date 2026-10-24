#!/usr/bin/env node
/**
 * Kernel (E-76 W2a): one light's visibility sweep in WASM (wasm/test/visibilitySweep.c, a test module) against
 * the shipped buildVisibilityPolygon (src/render/visibility/angularSweep.js), on visPolyStressScene's frame.
 *
 *   js      buildVisibilityPolygon, as pre-render calls it per light (its own plain typed arrays, outputs in
 *           a Float32Array of maxPolygonVertices)
 *   f64     sweep_light_f64: the JS's arithmetic in double, fdlibm atan2/asin
 *   pseudo  sweep_light_pseudo: events ordered by pseudoAngle of their direction, no atan2/asin per occluder
 *   pre     sweep_light_pre: pseudo with the ray tests' per-light terms worked out once per light
 *   simd    sweep_light_simd: pre with a box's ray test as two f64x2 halves
 *   f32     sweep_light_f32: pre with the edge terms and the polygon ray test in float32 (f32x4 per box)
 *
 * visPolyStressScene: 360 lights (intensity 400, so radius 200) and 700 boxes (32-80 a side, unrotated) in a
 * 4000 × 3000 world, from the scene's own seed and spawn order (tests/helpers/visibilitySweepKernel.mjs
 * visPolyFrame). Each light gets the boxes pre-render keeps for it (centre within radius + half diagonal), in
 * spawn order, packed as pre-render packs them (writeOrientedBoxVerts): 11.9 a light, 22.4 events, 33 JS
 * vertices; maxPolygonVertices is the scene's 5000. The neighbour cap of the spatial query (maxNeighbors 256
 * at visualRange 900) and its cell order are not modelled. The WASM side reads the same occluders from its
 * memory: one table per light (the inputs differ, the scratch and the outputs are shared). One op is the
 * frame: every light's sweep, one call each.
 *
 * Checksum: the JS frame's polygons quantised to 1/16 world unit (count and coordinates, FNV-1a). A WASM
 * variant reports that checksum only when its polygons pass the tolerance gate against the JS ones
 * (comparePolygons, the gate of tests/node/visibilitySweepWasm.test.js; flips at most 1 % of the lights, each
 * within 1e-4 of the area), and its own polygons' hash otherwise, so runKernelVariants.mjs rejects it.
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/visibilitySweepWasmMicrobench.mjs --variants js,f64,pseudo,pre,simd,f32 --rounds 4
 *   node tests/bench/visibilitySweepWasmMicrobench.mjs --variant pre [--shape box|circle] [--check] [--output path]
 *   node tests/bench/chromeKernel.mjs --module /tests/bench/visibilitySweepWasmMicrobench.mjs --args '{"variants":["js","f64","pseudo","pre","simd","f32"]}'
 *
 * Browser-safe at the top level: run() is what chromeKernel.mjs calls in Chrome (every variant in one page,
 * alternating rounds); the CLI below imports the Node helpers only when it runs in Node. The polar path
 * (compound solids) is not timed here: the JS bins are module state that only a raster per light fills, so it
 * has no input both sides can share untimed. The test covers it.
 */
import {
  FLIP_AREA_TOLERANCE,
  MAX_FLIP_SHARE,
  RELATIVE_GATE,
  SWEEP_VARIANTS,
  comparePolygons,
  createSweepKernel,
  hashPolygon,
  sweepJs,
  visPolyFrame,
} from '../helpers/visibilitySweepKernel.mjs';

/**
 * Everything one side of the bench needs: the frame, the kernel with one input set per light, the JS frame's
 * polygons and checksum, and `frame(variant)`, which runs the frame on that side.
 */
export async function setupSweepBench({ seed = 0x51f01, shape = 'box', maxVerts = 5000 } = {}) {
  const frame = visPolyFrame({ seed, shape });
  const k = await createSweepKernel({
    sets: frame.map((s) => ({ occluders: Math.max(1, s.occCount), poolVerts: Math.max(4, s.poolVerts) })),
    maxVerts,
  });
  frame.forEach((s, i) => k.load(i, s));
  const jsX = new Float32Array(maxVerts);
  const jsY = new Float32Array(maxVerts);
  const ref = frame.map((s) => {
    const n = sweepJs(s, jsX, jsY, maxVerts);
    return { n, x: jsX.slice(0, n), y: jsY.slice(0, n) };
  });
  let refChecksum = 2166136261;
  for (const p of ref) refChecksum = hashPolygon(refChecksum, p.x, p.y, p.n);

  const lights = frame.length;
  const sets = k.sets;
  const runners = {
    js() {
      let total = 0;
      for (let i = 0; i < lights; i++) total += sweepJs(frame[i], jsX, jsY, maxVerts);
      return total;
    },
  };
  for (const [v, fn] of Object.entries(k.variants)) {
    runners[v] = () => {
      let total = 0;
      for (let i = 0; i < lights; i++) {
        const s = frame[i];
        total += fn(sets[i].tableByte, s.lx, s.ly, s.radius, s.occCount, 0);
      }
      return total;
    };
  }
  /** One light on a side (the short call for warm-up). */
  const light = (variant, i) => {
    const s = frame[i];
    if (variant === 'js') return sweepJs(s, jsX, jsY, maxVerts);
    return k.variants[variant](sets[i].tableByte, s.lx, s.ly, s.radius, s.occCount, 0);
  };

  /**
   * The variant's polygons against the JS ones: the checksum it reports (the JS frame's when every polygon
   * passes the gate, flips included when they keep the area, its own otherwise), and the worst errors.
   */
  const check = (variant) => {
    if (variant === 'js') return { checksum: refChecksum, flips: 0, failed: 0, err: 0, maxAbs: 0, maxRayRel: 0, worstAreaRel: 0 };
    const relative = RELATIVE_GATE.has(variant);
    let own = 2166136261;
    let flips = 0;
    let failed = 0;
    let err = 0;
    let maxAbs = 0;
    let maxRayRel = 0;
    let worstAreaRel = 0;
    for (let i = 0; i < lights; i++) {
      const n = light(variant, i);
      const s = frame[i];
      const c = comparePolygons(ref[i].x, ref[i].y, ref[i].n, k.outX, k.outY, n, { lx: s.lx, ly: s.ly, relative });
      own = hashPolygon(own, k.outX, k.outY, n);
      if (!c.ok) {
        flips++;
        if (c.areaRel > worstAreaRel) worstAreaRel = c.areaRel;
        if (!(c.areaRel <= FLIP_AREA_TOLERANCE)) failed++;
      } else {
        if (c.err > err) err = c.err;
        if (c.maxAbs > maxAbs) maxAbs = c.maxAbs;
        if (c.maxRayRel > maxRayRel) maxRayRel = c.maxRayRel;
      }
    }
    const pass = failed === 0 && flips <= MAX_FLIP_SHARE * lights;
    return { checksum: pass ? refChecksum : own, pass, flips, failed, err, maxAbs, maxRayRel, worstAreaRel };
  };

  const occluders = frame.reduce((a, s) => a + s.occCount, 0);
  const vertices = ref.reduce((a, p) => a + p.n, 0);
  return { frame, kernel: k, ref, refChecksum, runners, light, check, lights, occluders, vertices, maxVerts };
}

const VARIANT_NAMES = ['js', ...Object.keys(SWEEP_VARIANTS)];

/** chromeKernel.mjs entry: every variant in one page, alternating rounds; ops are frames. */
export async function run({ variants = VARIANT_NAMES, rounds = 9, minMs = 30, warmCalls = 3000, seed = 0x51f01, shape = 'box' } = {}) {
  for (const v of variants) if (!VARIANT_NAMES.includes(v)) throw new Error(`unknown variant ${v}`);
  const b = await setupSweepBench({ seed, shape });
  const checks = Object.fromEntries(variants.map((v) => [v, b.check(v)]));
  for (const v of variants) {
    // Short calls first (one light each), so the timed code is a normal compile.
    for (let i = 0; i < warmCalls; i++) b.light(v, i % b.lights);
  }
  let sink = 0;
  const counts = {};
  for (const v of variants) {
    let n = 1;
    for (;;) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) sink += b.runners[v]();
      if (performance.now() - t0 >= minMs) break;
      n *= 2;
    }
    counts[v] = n;
  }
  const samples = Object.fromEntries(variants.map((v) => [v, []]));
  for (let r = 0; r < rounds; r++) {
    const order = r % 2 === 0 ? variants : [...variants].reverse();
    for (const v of order) {
      const t0 = performance.now();
      for (let i = 0; i < counts[v]; i++) sink += b.runners[v]();
      samples[v].push((counts[v] * 1000) / (performance.now() - t0));
    }
  }
  const median = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return s[s.length >> 1];
  };
  const base = median(samples[variants[0]]);
  const cases = {};
  for (const v of variants) {
    const ops = median(samples[v]);
    cases[v] = {
      framesPerSec: Number(ops.toFixed(2)),
      usPerLight: Number((1e6 / ops / b.lights).toFixed(3)),
      deltaPct: Number((((ops - base) / base) * 100).toFixed(1)),
      samples: samples[v].map((x) => Number(x.toFixed(2))),
      ...checks[v],
    };
  }
  return {
    lights: b.lights,
    occluders: b.occluders,
    vertices: b.vertices,
    shape,
    seed,
    refChecksum: b.refChecksum,
    sink: Number.isFinite(sink) ? 'finite' : String(sink),
    cases,
  };
}

async function main() {
  const { isCli, parseArgs, timeIt, warmNormalCompile, writeReport } = await import('./microbenchHelpers.mjs');
  if (!isCli(import.meta.url)) return;
  const { machineState, TIMING_MARKER, warmWasm } = await import('./wasmKernelHelpers.mjs');
  const args = parseArgs();
  let variant = String(args.variant || 'js');
  if (variant === 'base') variant = 'js';
  if (!VARIANT_NAMES.includes(variant)) throw new Error(`unknown variant ${variant} (${VARIANT_NAMES.join(', ')})`);
  const seed = Number(args.seed ?? 0x51f01);
  const shape = String(args.shape || 'box');
  if (!['box', 'circle'].includes(shape)) throw new Error(`unknown shape ${shape}`);
  const b = await setupSweepBench({ seed, shape });
  const gate = b.check(variant);
  if (args.check) {
    console.log(`checksum ${gate.checksum} (${variant}: ${b.lights} lights, ${b.occluders} occluders, ${b.vertices} JS vertices, ` +
      `flips ${gate.flips}, worst move ${gate.maxAbs.toExponential(2)} world units = ${gate.maxRayRel.toExponential(2)} of its ray, ` +
      `${(gate.err * 100).toFixed(1)} % of its allowance)`);
    return;
  }
  let tier = null;
  if (variant === 'js') {
    let i = 0;
    warmNormalCompile(() => b.light('js', (i = i + 1 === b.lights ? 0 : i + 1)), 3000);
  } else {
    let i = 0;
    tier = await warmWasm(b.kernel.variants[variant], () => b.light(variant, (i = i + 1 === b.lights ? 0 : i + 1)), { calls: 3000 });
  }
  const runFrame = b.runners[variant];
  console.log(TIMING_MARKER);
  const cases = {
    frame: timeIt(`sweep frame ${variant} (${b.lights} lights, ${shape})`, () => { runFrame(); }, { iterations: 20, warmup: 20 }),
  };
  const report = {
    feature: 'visibility-sweep-wasm',
    variant,
    functions: ['angularSweep.buildVisibilityPolygon', `visibilitySweep.${SWEEP_VARIANTS[variant] ?? 'js'}`],
    n: b.lights,
    seed,
    shape,
    occluders: b.occluders,
    vertices: b.vertices,
    checksum: gate.checksum,
    gate,
    usPerLight: 1e6 / cases.frame.opsPerSec / b.lights,
    wasmTier: tier,
    machine: machineState(),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${gate.checksum}${tier ? ` tier ${tier}` : ''} frame ${cases.frame.opsPerSec.toFixed(1)} per s (${report.usPerLight.toFixed(2)} µs per light)`);
}

if (typeof process !== 'undefined' && process.versions?.node) await main();
