#!/usr/bin/env node
/**
 * Kernel (E-76 W9e): a pose batch's upload (renderer.interpolation), the batch's own JS packers
 * (InstancedSpriteBatch._packPoseOnly, _packPoseAndStatics) against gpuPack.wasm's pack_pose, on bunnyMarkScene's
 * shape: 250 000 sprites in world space, pixel snap on (snapZoom 1), the previous pose from the other queue, no
 * index list (ySort off), every row packed.
 *
 *   js    the batch's JS packer into its own arrays
 *   wasm  packPoseRowsWasm into rows of the render-queue memory, then copied into the batch's own arrays as the
 *         wired upload does (E-123: the upload reads a private copy)
 *
 * Cases (--case): pose (the statics are current: the pose stream alone, the usual frame) and both (the statics too).
 * One variant per process, through runKernelVariants.mjs, which rejects a variant whose checksum differs: the words
 * the batch's arrays hold after one call. --check prints the checksum only.
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/poseInterpPackMicrobench.mjs --variants js,wasm --rounds 5
 *   node tests/bench/poseInterpPackMicrobench.mjs --variant wasm [--case pose|both] [--n 250000] [--check] [--output path]
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  BATCH_SPACE,
  InstancedSpriteBatch,
  POSE_DYN_FLOATS,
  POSE_STATIC_FLOATS,
} from '../../src/render/instancedSpriteBatch.js';
import { bindGpuPack, packPoseRowsWasm } from '../../src/render/gpuPackClient.js';
import { isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { machineState, warmWasm } from './wasmKernelHelpers.mjs';

// GlProgram.from probes shader precision on a canvas; Node has none, and a context of null is enough.
globalThis.document ??= { createElement: () => ({ getContext: () => null }) };

const shaderDir = path.resolve(import.meta.dirname, '../../src/shaders');
const read = (f) => fs.readFileSync(path.join(shaderDir, f), 'utf8');

/** A queue, its previous x and y, the kernel and a pose batch on one memory, bunnyMark's way. */
export async function setupPoseKernel({ n = 250000, seed = 0xb0ee5 } = {}) {
  const floats = 22 * n + 2 * n + (POSE_DYN_FLOATS + POSE_STATIC_FLOATS) * n + 2 * n;
  const pages = Math.ceil((floats * 4 + (1 << 20)) / 65536) + 16;
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  const buf = memory.buffer;
  let top = 64;
  const alloc = (Ctor, len) => {
    top = (top + 15) & ~15;
    const v = new Ctor(buf, top, len);
    top += len * Ctor.BYTES_PER_ELEMENT;
    return v;
  };
  const rng = mulberry32(seed);
  const f32 = () => alloc(Float32Array, n);
  const q = {
    count: n, x: f32(), y: f32(), scaleX: f32(), scaleY: f32(), rotC: f32(), rotS: f32(), alpha: f32(),
    tint: alloc(Uint32Array, n), textureId: alloc(Uint16Array, n), anchorX: f32(), anchorY: f32(),
    repeatX: alloc(Uint16Array, n), repeatY: alloc(Uint16Array, n), tileMode: alloc(Uint8Array, n),
    tileMulX: f32(), tileMulY: f32(), tileOffsetU: alloc(Uint16Array, n), tileOffsetV: alloc(Uint16Array, n),
    shadowH: f32(), shadowOffX: f32(), shadowOffY: f32(), type: alloc(Uint8Array, n),
  };
  const prevX = f32();
  const prevY = f32();
  for (let i = 0; i < n; i++) {
    q.x[i] = rng() * 1920;
    q.y[i] = rng() * 1080;
    prevX[i] = q.x[i] - (rng() - 0.5) * 10;
    prevY[i] = q.y[i] - (rng() - 0.5) * 10;
    q.scaleX[i] = 1;
    q.scaleY[i] = 1;
    q.rotC[i] = 1;
    q.rotS[i] = 0;
    q.alpha[i] = 1;
    q.tint[i] = 0xffffff;
    q.anchorX[i] = 0.5;
    q.anchorY[i] = 1;
  }
  const pose = alloc(Float32Array, n * POSE_DYN_FLOATS);
  const stat = alloc(Float32Array, n * POSE_STATIC_FLOATS);
  const tableByte = (top = (top + 15) & ~15);
  top += 4 * 18 * 4;
  const indexByte = (top = (top + 15) & ~15);
  top += 16;
  const particlesByte = (top = (top + 15) & ~15);
  top += 160;
  const pack = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: 4, particlesByte, inverseByte: 0 });
  const shaders = {
    spriteVertPose: read('instancedSpritePose.vert.glsl'),
    spriteVert: read('instancedSprite.vert.glsl'),
    spriteFrag: read('instancedSprite.frag.glsl'),
    spriteFragAdd: read('instancedSpriteAdditive.frag.glsl'),
    spriteFragBlend: read('instancedSpriteBlend.frag.glsl'),
  };
  const batch = new InstancedSpriteBatch({ capacity: n, label: 'w9e-bench', poseInterp: true, useWebGpu: false, shaders });
  const opts = {
    space: BATCH_SPACE.WORLD, includeType: -1, excludeType0: -1, excludeType1: -1,
    prevX, prevY, pixelSnap: true, snapCameraX: 0, snapCameraY: 0, snapZoom: 1,
  };
  /** One upload's pack: `rows` rows (all by default), both streams or the pose alone. */
  const runWith = (wasm, statics) => (rows = n) => {
    q.count = rows;
    const ctx = batch._beginUpload(q, opts);
    let out;
    if (wasm) {
      out = packPoseRowsWasm(pack, q, ctx, pose, statics ? stat : null, n);
      batch.data.set(pose.subarray(0, out * POSE_DYN_FLOATS));
      if (statics) batch.staticData.set(stat.subarray(0, out * POSE_STATIC_FLOATS));
    } else {
      out = statics ? batch._packPoseAndStatics(q, ctx) : batch._packPoseOnly(q, ctx);
    }
    q.count = n;
    return out;
  };
  const hash = (statics) => {
    let h = 2166136261;
    const mix = (a, len) => {
      const w = new Uint32Array(a.buffer, a.byteOffset, len);
      for (let k = 0; k < len; k++) h = Math.imul(h ^ w[k], 16777619) >>> 0;
    };
    mix(batch.data, n * POSE_DYN_FLOATS);
    if (statics) mix(batch.staticData, n * POSE_STATIC_FLOATS);
    return h >>> 0;
  };
  return { n, batch, pack, runWith, hash };
}

async function main() {
  const args = parseArgs();
  // The shipped path by default (W9e wires it); js is the batch's JS packer.
  const variant = String(args.variant || 'wasm');
  const caseName = String(args.case || 'pose');
  if (!['js', 'wasm'].includes(variant)) throw new Error(`unknown variant ${variant}`);
  if (!['pose', 'both'].includes(caseName)) throw new Error(`unknown case ${caseName}`);
  const s = await setupPoseKernel({ n: Number(args.n ?? 250000) });
  const statics = caseName === 'both';
  const run = s.runWith(variant === 'wasm', statics);
  s.batch.data.fill(0);
  s.batch.staticData.fill(0);
  const rows = run();
  const checksum = s.hash(statics);
  if (args.check) {
    console.log(`checksum ${checksum} variant ${variant} case ${caseName} rows ${rows}`);
    return;
  }
  // Normal compiles, not OSR: short calls over the first rows.
  let tier = null;
  if (variant === 'js') warmNormalCompile(() => run(64));
  else tier = await warmWasm(s.pack.pose, () => run(64));
  const cases = {
    pack: timeIt(`pose pack ${variant} ${caseName} (${s.n} sprites)`, () => run(), { iterations: 20, warmup: 5 }),
  };
  const report = {
    feature: 'pose-interp-pack-wasm',
    variant,
    case: caseName,
    functions: ['InstancedSpriteBatch._packPoseOnly / _packPoseAndStatics', 'gpuPack.pack_pose'],
    n: s.n,
    rows,
    checksum,
    wasmTier: tier,
    machine: machineState(),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum}${tier ? ` tier ${tier}` : ''} ${caseName} ${cases.pack.opsPerSec.toFixed(1)} ops/s`);
}

if (isCli(import.meta.url)) await main();
