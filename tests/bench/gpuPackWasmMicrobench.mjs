#!/usr/bin/env node
/**
 * Kernel (E-76 W9): the instanced-row pack, packInstancedRows (JS) against packInstancedRowsWasm
 * (src/render/gpuPackClient.js, wasm/gpuPack.c), on gpuQueuePackMicrobench's 16k-row Predator
 * queue in cell order, its columns, indices and output on one shared WebAssembly.Memory as the
 * render-queue memory places them. Both variants read the same views.
 *   - sprites: 15-float rows through the painter order (pre-render's _writePackedSprites).
 *   - casters: 22-float rows with shadowCast (pre-render's _packGpuSun).
 * The queue is hot in this core's cache, which is what pre-render sees when it packs the rows it
 * has just emitted; Pixi reads rows written on another core (X5), so this kernel speaks for
 * pre-render's pack only.
 *
 *   node tests/bench/gpuPackWasmMicrobench.mjs --variant base|wasm [--output path]
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/gpuPackWasmMicrobench.mjs --variants base,wasm
 */
import {
  GPU_CASTER_FLOATS,
  GPU_SPACE_WORLD,
  GPU_SPRITE_FLOATS,
  makePackContext,
  packInstancedRows,
} from '../../src/render/gpuQueueLayout.js';
import { bindGpuPack, GPU_PACK_COLUMNS, packInstancedRowsWasm } from '../../src/render/gpuPackClient.js';
import { buildQueue } from './gpuQueuePackMicrobench.mjs';
import { checksumFloats, isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { loadPredatorFixture } from './predatorFixture.mjs';

/** The fixture queue copied onto a shared memory, with the client's scratch. */
async function memoryQueue(rows) {
  const fx = loadPredatorFixture();
  if (!fx) throw new Error('missing tests/fixtures/predator-frame.bin (run capturePredatorFixture.mjs)');
  const { q: src, painter } = buildQueue(fx, rows, 'cells');
  const n = src.count;
  const memory = new WebAssembly.Memory({ initial: 256, maximum: 8192, shared: true });
  const buf = memory.buffer;
  let top = 64;
  const place = (arr) => {
    top = (top + 15) & ~15;
    const v = new arr.constructor(buf, top, arr.length);
    v.set(arr);
    top += arr.byteLength;
    return v;
  };
  const q = { count: n };
  for (const name of [...GPU_PACK_COLUMNS, 'type', 'repeatX', 'repeatY']) q[name] = place(src[name]);
  const order = place(painter);
  const casterIdx = new Uint32Array(n);
  let casters = 0;
  for (let r = 0; r < n; r++) if (q.shadowH[r] > 0) casterIdx[casters++] = r;
  const casterOrder = place(casterIdx);
  const dst = place(new Float32Array(n * GPU_CASTER_FLOATS));
  const tableByte = (top = (top + 15) & ~15);
  top += 4 * GPU_PACK_COLUMNS.length * 4;
  const indexByte = (top = (top + 15) & ~15);
  top += n * 4;
  const particlesByte = top;
  const b = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: n, particlesByte });
  return { q, b, n, order, casterOrder, casters, dst };
}

const VARIANTS = {
  base: (k, q, ctx, dst, fp, cap, shadow) => packInstancedRows(q, ctx, dst, new Uint32Array(dst.buffer, dst.byteOffset, dst.length), fp, cap, shadow),
  wasm: (k, q, ctx, dst, fp, cap, shadow) => packInstancedRowsWasm(k.b, q, ctx, dst, fp, cap, shadow),
};

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  const pack = VARIANTS[variant];
  if (!pack) throw new Error(`unknown variant ${variant}`);
  const k = await memoryQueue(Number(args.rows ?? 16000));
  const { q, n, dst } = k;
  const ctxOut = {};
  const spriteOpts = { indices: k.order, indexCount: n, space: GPU_SPACE_WORLD, zoom: 0.4, cameraX: 0, cameraY: 0, type: q.type };
  const casterOpts = { indices: k.casterOrder, indexCount: k.casters, space: GPU_SPACE_WORLD, type: q.type };
  const sprites = (count = n) => pack(k, q, makePackContext(q, { ...spriteOpts, indexCount: count }, n, ctxOut), dst, GPU_SPRITE_FLOATS, n, false);
  const casters = (count = k.casters) => pack(k, q, makePackContext(q, { ...casterOpts, indexCount: count }, n, ctxOut), dst, GPU_CASTER_FLOATS, n, true);
  const cases = {};
  const sOut = sprites();
  if (sOut < 0) throw new Error(`${variant}: the sprite pack declined`);
  const spriteChecksum = checksumFloats(dst, sOut * GPU_SPRITE_FLOATS);
  warmNormalCompile(() => sprites(64));
  cases.sprites = timeIt(`pack ${variant} sprites (${sOut} rows)`, () => sprites(), { iterations: 100, warmup: 20 });
  const cOut = casters();
  if (cOut < 0) throw new Error(`${variant}: the caster pack declined`);
  const casterChecksum = checksumFloats(dst, cOut * GPU_CASTER_FLOATS);
  warmNormalCompile(() => casters(64));
  cases.casters = timeIt(`pack ${variant} casters (${cOut} rows)`, () => casters(), { iterations: 100, warmup: 20 });
  const report = {
    feature: 'gpu-pack-wasm',
    variant,
    functions: ['packInstancedRows', 'packInstancedRowsWasm'],
    rows: n,
    checksum: `${spriteChecksum}:${casterChecksum}`,
    note: 'Columns, indices and output on one shared memory; hot in this core, as for pre-render.',
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${report.checksum} sprites ${cases.sprites.opsPerSec.toFixed(1)} ops/s casters ${cases.casters.opsPerSec.toFixed(1)} ops/s`);
}

if (isCli(import.meta.url)) await main();
