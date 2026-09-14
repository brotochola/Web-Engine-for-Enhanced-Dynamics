// L1: SpriteRenderer boolean flags — 7 Uint8 columns vs 1 Uint8 bitpack.
// Kernels copy pre_render cull (read active+visible, write isItOnScreen) and
// queue emit (read inherit/isAnimated/loop). SAB-strided matches ARRAY_SCHEMA
// SoA (flags are not contiguous). Packed RMW vs column store on cull write.
//
// Gate (packed.ms / strided.ms): ship only if cull AND queue <= 0.90; kill if
// cull >= 1.0. Dirty-write > 1.15 vs columns also kills.
//
// KILL (2026-09-04, N=8000, 2000 ticks, Node): cull packed/strided=0.625
// (win) but queue packed/strided=0.981 (noise) and dirty packed/columns=1.276
// (RMW |= loses to Uint8 store). L3 Predator headed (same warmup/duration,
// comparable ~21k VISIBLE): packed preRender STEP_MS in noise vs 7 columns
// (base-2 8.85; pack 9.32 / 8.46). Keep 7 SoA columns. Do not bitpack engine.
//
// Usage:
//   node tests/bench/sr-flags-microbench.mjs
//   pnpm bench:micro:sr-flags
//   node tests/bench/sr-flags-microbench.mjs --entities 8000 --ticks 2000 --output tests/results/sr-flags-micro.json

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { mulberry32, parseArgs, timeIt, writeReport } from './microbench-helpers.mjs';

const F_ACTIVE = 1 << 0;
const F_ANIMATED = 1 << 1;
const F_LOOP = 1 << 2;
const F_INHERIT = 1 << 3;
const F_VISIBLE = 1 << 4;
const F_ONSCREEN = 1 << 5;
const F_DIRTY = 1 << 6;

/** SpriteRenderer ARRAY_SCHEMA order + bpe (same align as Component.initializeArrays). */
const SR_SCHEMA_BPE = [
  ['active', 1],
  ['isAnimated', 1],
  ['spritesheetId', 1],
  ['animationState', 1],
  ['animationFrame', 2],
  ['animationSpeed', 4],
  ['loop', 1],
  ['tint', 4],
  ['baseTint', 4],
  ['alpha', 4],
  ['scaleX', 4],
  ['scaleY', 4],
  ['boundsHalfW', 4],
  ['boundsHalfH', 4],
  ['anchorX', 4],
  ['anchorY', 4],
  ['inheritTransformRotation', 1],
  ['spriteRotC', 4],
  ['spriteRotS', 4],
  ['repeatX', 2],
  ['repeatY', 2],
  ['tileMode', 1],
  ['tileOffsetU', 2],
  ['tileOffsetV', 2],
  ['layerId', 1],
  ['renderVisible', 1],
  ['isItOnScreen', 1],
  ['renderDirty', 1],
  ['screenX', 4],
  ['screenY', 4],
];

const FLAG_NAMES = [
  'active',
  'isAnimated',
  'loop',
  'inheritTransformRotation',
  'renderVisible',
  'isItOnScreen',
  'renderDirty',
];

function layoutSpriteRenderer(n) {
  let offset = 0;
  const offsets = {};
  for (let i = 0; i < SR_SCHEMA_BPE.length; i++) {
    const name = SR_SCHEMA_BPE[i][0];
    const bpe = SR_SCHEMA_BPE[i][1];
    const rem = offset % bpe;
    if (rem !== 0) offset += bpe - rem;
    offsets[name] = offset;
    offset += n * bpe;
  }
  return { byteLength: offset, offsets };
}

function packRow(active, anim, loop, inherit, visible, onScreen, dirty) {
  return (
    (active ? F_ACTIVE : 0) |
    (anim ? F_ANIMATED : 0) |
    (loop ? F_LOOP : 0) |
    (inherit ? F_INHERIT : 0) |
    (visible ? F_VISIBLE : 0) |
    (onScreen ? F_ONSCREEN : 0) |
    (dirty ? F_DIRTY : 0)
  );
}

function cullColumns(active, visible, onScreen, inView, n) {
  let sink = 0;
  for (let i = 0; i < n; i++) {
    if (!active[i]) {
      if (onScreen[i] !== 0) onScreen[i] = 0;
      continue;
    }
    if (!inView[i]) {
      onScreen[i] = 0;
      continue;
    }
    onScreen[i] = 1;
    if (visible[i]) sink++;
  }
  return sink;
}

function cullPacked(flags, inView, n) {
  let sink = 0;
  for (let i = 0; i < n; i++) {
    let f = flags[i];
    if (!(f & F_ACTIVE)) {
      flags[i] = f & ~F_ONSCREEN;
      continue;
    }
    if (!inView[i]) {
      flags[i] = f & ~F_ONSCREEN;
      continue;
    }
    f |= F_ONSCREEN;
    flags[i] = f;
    if (f & F_VISIBLE) sink++;
  }
  return sink;
}

function queueColumns(inherit, anim, loop, n) {
  let sink = 0;
  for (let i = 0; i < n; i++) {
    if (inherit[i]) sink += 1;
    else sink += 2;
    if (anim[i] && loop[i]) sink++;
  }
  return sink;
}

function queuePacked(flags, n) {
  let sink = 0;
  for (let i = 0; i < n; i++) {
    const f = flags[i];
    if (f & F_INHERIT) sink += 1;
    else sink += 2;
    if ((f & F_ANIMATED) && (f & F_LOOP)) sink++;
  }
  return sink;
}

function dirtyColumns(dirty, n) {
  for (let i = 0; i < n; i++) dirty[i] = 1;
}

function dirtyPacked(flags, n) {
  for (let i = 0; i < n; i++) flags[i] |= F_DIRTY;
}

function decideGate(ratios) {
  const cullStrided = ratios.cullPackedVsStrided;
  const queueStrided = ratios.queuePackedVsStrided;
  const cullCols = ratios.cullPackedVsColumns;
  const dirtyCols = ratios.dirtyPackedVsColumns;
  if (!(cullStrided < 1) || !(cullCols < 1)) {
    return {
      verdict: 'kill',
      reason: 'cull packed slower or tied vs strided/columns (visibility is the fat loop)',
    };
  }
  if (dirtyCols > 1.15) {
    return {
      verdict: 'kill',
      reason: 'dirty-write packed/columns > 1.15',
    };
  }
  if (cullStrided <= 0.9 && queueStrided <= 0.9) {
    return {
      verdict: 'ship',
      reason: 'cull and queue packed/strided <= 0.90',
    };
  }
  return {
    verdict: 'noise',
    reason: 'win under 10% or queue missed 0.90 — keep SoA columns',
  };
}

/**
 * @param {Record<string, unknown>} [cliArgs]
 */
export function runSrFlagsMicrobench(cliArgs = parseArgs()) {
  const ENTITIES = Number(cliArgs.entities ?? 8000);
  const TICKS = Number(cliArgs.ticks ?? 2000);
  const SEED = Number(cliArgs.seed ?? 0x51c0de);
  const outputPath =
    cliArgs.output != null
      ? String(cliArgs.output)
      : 'tests/results/sr-flags-micro.json';

  const rng = mulberry32(SEED);
  const n = ENTITIES;

  const colActive = new Uint8Array(n);
  const colAnim = new Uint8Array(n);
  const colLoop = new Uint8Array(n);
  const colInherit = new Uint8Array(n);
  const colVisible = new Uint8Array(n);
  const colOnScreen = new Uint8Array(n);
  const colDirty = new Uint8Array(n);
  const inView = new Uint8Array(n);
  const packed = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const active = rng() < 0.95 ? 1 : 0;
    const anim = rng() < 0.2 ? 1 : 0;
    const loop = rng() < 0.9 ? 1 : 0;
    const inherit = rng() < 0.9 ? 1 : 0;
    const visible = rng() < 0.95 ? 1 : 0;
    const onScreen = 0;
    const dirty = rng() < 0.05 ? 1 : 0;
    colActive[i] = active;
    colAnim[i] = anim;
    colLoop[i] = loop;
    colInherit[i] = inherit;
    colVisible[i] = visible;
    colOnScreen[i] = onScreen;
    colDirty[i] = dirty;
    packed[i] = packRow(active, anim, loop, inherit, visible, onScreen, dirty);
    inView[i] = rng() < 0.88 ? 1 : 0;
  }

  const layout = layoutSpriteRenderer(n);
  const sab = new ArrayBuffer(layout.byteLength);
  const sabActive = new Uint8Array(sab, layout.offsets.active, n);
  const sabAnim = new Uint8Array(sab, layout.offsets.isAnimated, n);
  const sabLoop = new Uint8Array(sab, layout.offsets.loop, n);
  const sabInherit = new Uint8Array(sab, layout.offsets.inheritTransformRotation, n);
  const sabVisible = new Uint8Array(sab, layout.offsets.renderVisible, n);
  const sabOnScreen = new Uint8Array(sab, layout.offsets.isItOnScreen, n);
  const sabDirty = new Uint8Array(sab, layout.offsets.renderDirty, n);
  sabActive.set(colActive);
  sabAnim.set(colAnim);
  sabLoop.set(colLoop);
  sabInherit.set(colInherit);
  sabVisible.set(colVisible);
  sabOnScreen.set(colOnScreen);
  sabDirty.set(colDirty);

  const packedCheck = packed.slice();
  const colOn = colOnScreen.slice();
  const sabOn = sabOnScreen.slice();
  const sinkCol = cullColumns(colActive, colVisible, colOn, inView, n);
  const sinkSab = cullColumns(sabActive, sabVisible, sabOn, inView, n);
  const sinkPk = cullPacked(packedCheck, inView, n);
  if (sinkCol !== sinkSab || sinkCol !== sinkPk) {
    throw new Error(`cull sink mismatch columns=${sinkCol} sab=${sinkSab} packed=${sinkPk}`);
  }
  for (let i = 0; i < n; i++) {
    const expect = colOn[i] ? 1 : 0;
    if (((packedCheck[i] & F_ONSCREEN) !== 0) !== (expect !== 0)) {
      throw new Error(`cull onScreen bit mismatch at ${i}`);
    }
    if (sabOn[i] !== expect) throw new Error(`cull sab onScreen mismatch at ${i}`);
  }
  const qCol = queueColumns(colInherit, colAnim, colLoop, n);
  const qPk = queuePacked(packed, n);
  if (qCol !== qPk) {
    throw new Error(`queue sink mismatch columns=${qCol} packed=${qPk}`);
  }
  for (let i = 0; i < n; i++) {
    const p = packed[i];
    if ((p & F_ACTIVE ? 1 : 0) !== colActive[i]) throw new Error('pack active');
    if ((p & F_ANIMATED ? 1 : 0) !== colAnim[i]) throw new Error('pack anim');
    if ((p & F_LOOP ? 1 : 0) !== colLoop[i]) throw new Error('pack loop');
    if ((p & F_INHERIT ? 1 : 0) !== colInherit[i]) throw new Error('pack inherit');
    if ((p & F_VISIBLE ? 1 : 0) !== colVisible[i]) throw new Error('pack visible');
    if ((p & F_DIRTY ? 1 : 0) !== colDirty[i]) throw new Error('pack dirty');
  }
  console.log(
    `Correctness OK (${n} entities, cull sink=${sinkCol}, queue sink=${qCol}, sabBytes=${layout.byteLength})`
  );

  const iterations = n * TICKS;
  const timeOpts = { iterations };

  const cullColumnsT = timeIt(
    'cull columns (7 Uint8)',
    (iter) => {
      const ticks = Math.max(1, (iter / n) | 0);
      const on = colOnScreen.slice();
      let sink = 0;
      for (let t = 0; t < ticks; t++) {
        sink += cullColumns(colActive, colVisible, on, inView, n);
      }
      if (sink === -1) console.log(sink);
    },
    timeOpts
  );

  const cullStridedT = timeIt(
    'cull sab-strided (schema SoA)',
    (iter) => {
      const ticks = Math.max(1, (iter / n) | 0);
      const on = new Uint8Array(sab, layout.offsets.isItOnScreen, n);
      on.set(colOnScreen);
      let sink = 0;
      for (let t = 0; t < ticks; t++) {
        sink += cullColumns(sabActive, sabVisible, on, inView, n);
      }
      if (sink === -1) console.log(sink);
    },
    timeOpts
  );

  const cullPackedT = timeIt(
    'cull packed Uint8',
    (iter) => {
      const ticks = Math.max(1, (iter / n) | 0);
      const f = packed.slice();
      let sink = 0;
      for (let t = 0; t < ticks; t++) {
        sink += cullPacked(f, inView, n);
      }
      if (sink === -1) console.log(sink);
    },
    timeOpts
  );

  const queueColumnsT = timeIt(
    'queue columns (inherit/anim/loop)',
    (iter) => {
      const ticks = Math.max(1, (iter / n) | 0);
      let sink = 0;
      for (let t = 0; t < ticks; t++) {
        sink += queueColumns(colInherit, colAnim, colLoop, n);
      }
      if (sink === -1) console.log(sink);
    },
    timeOpts
  );

  const queueStridedT = timeIt(
    'queue sab-strided',
    (iter) => {
      const ticks = Math.max(1, (iter / n) | 0);
      let sink = 0;
      for (let t = 0; t < ticks; t++) {
        sink += queueColumns(sabInherit, sabAnim, sabLoop, n);
      }
      if (sink === -1) console.log(sink);
    },
    timeOpts
  );

  const queuePackedT = timeIt(
    'queue packed Uint8',
    (iter) => {
      const ticks = Math.max(1, (iter / n) | 0);
      let sink = 0;
      for (let t = 0; t < ticks; t++) {
        sink += queuePacked(packed, n);
      }
      if (sink === -1) console.log(sink);
    },
    timeOpts
  );

  const dirtyColumnsT = timeIt(
    'dirty columns store',
    (iter) => {
      const ticks = Math.max(1, (iter / n) | 0);
      const d = colDirty.slice();
      for (let t = 0; t < ticks; t++) dirtyColumns(d, n);
      if (d[0] === 2) console.log(d[0]);
    },
    timeOpts
  );

  const dirtyPackedT = timeIt(
    'dirty packed |=',
    (iter) => {
      const ticks = Math.max(1, (iter / n) | 0);
      const f = packed.slice();
      for (let t = 0; t < ticks; t++) dirtyPacked(f, n);
      if (f[0] === 0xff) console.log(f[0]);
    },
    timeOpts
  );

  const ratios = {
    cullPackedVsColumns: cullPackedT.ms / cullColumnsT.ms,
    cullPackedVsStrided: cullPackedT.ms / cullStridedT.ms,
    queuePackedVsColumns: queuePackedT.ms / queueColumnsT.ms,
    queuePackedVsStrided: queuePackedT.ms / queueStridedT.ms,
    dirtyPackedVsColumns: dirtyPackedT.ms / dirtyColumnsT.ms,
  };
  const gate = decideGate(ratios);

  const report = {
    name: 'sr-flags',
    hyp: 'SR-FLAGS',
    seed: SEED,
    entities: n,
    ticks: TICKS,
    flagBits: {
      F_ACTIVE,
      F_ANIMATED,
      F_LOOP,
      F_INHERIT,
      F_VISIBLE,
      F_ONSCREEN,
      F_DIRTY,
    },
    flagNames: FLAG_NAMES,
    sabByteLength: layout.byteLength,
    correctness: { ok: true, cullSink: sinkCol, queueSink: qCol },
    timings: {
      cull: { columns: cullColumnsT, strided: cullStridedT, packed: cullPackedT },
      queue: { columns: queueColumnsT, strided: queueStridedT, packed: queuePackedT },
      dirty: { columns: dirtyColumnsT, packed: dirtyPackedT },
    },
    ratios,
    gate,
  };

  console.log(
    `Ratios packed/baseline (<1 = faster):\n` +
      `  cull   vs columns=${ratios.cullPackedVsColumns.toFixed(3)} vs strided=${ratios.cullPackedVsStrided.toFixed(3)}\n` +
      `  queue  vs columns=${ratios.queuePackedVsColumns.toFixed(3)} vs strided=${ratios.queuePackedVsStrided.toFixed(3)}\n` +
      `  dirty  vs columns=${ratios.dirtyPackedVsColumns.toFixed(3)}\n` +
      `Gate: ${gate.verdict} — ${gate.reason}`
  );

  if (outputPath) writeReport(outputPath, report);
  return report;
}

const isDirect =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirect) {
  runSrFlagsMicrobench();
}
