// L1: InstancedSpriteBatch CPU pack — 25-float AoS (current) vs compact ~13-float
// (shader LUT / packed tint) vs one index compact + three tight packs (triple-scan).
//
// Usage:
//   node tests/bench/instanced-pack-microbench.mjs
//   node tests/bench/instanced-pack-microbench.mjs --count 8000 --frames 2000 --output tests/results/instanced-pack-micro.json

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { mulberry32, parseArgs, timeIt, writeReport } from './microbench-helpers.mjs';

const TEX_LUT_FLOATS = 10;
const PACK25 = 25;
const PACK15 = 15; // xy, scale, anchor, rotCS, depth, tintBits, texId, tileInv, tileOff
const Y_SORT_K = 128;
const GLOW_BIAS = 127;

const TYPE_ENTITY = 0;
const TYPE_PARTICLE = 1;
const TYPE_GLOW = 3;

/**
 * @param {Record<string, unknown>} [cliArgs]
 */
export function runInstancedPackMicrobench(cliArgs = parseArgs()) {
  const COUNT = Number(cliArgs.count ?? 2000);
  const FRAMES = Number(cliArgs.frames ?? 2000);
  const TEX_N = Number(cliArgs.textures ?? 256);
  const SEED = Number(cliArgs.seed ?? 0x51c0de);
  const WORLD_H = Number(cliArgs.worldHeight ?? 10000);
  const outputPath = cliArgs.output ? String(cliArgs.output) : null;

  const rng = mulberry32(SEED);
  const x = new Float32Array(COUNT);
  const y = new Float32Array(COUNT);
  const scaleX = new Float32Array(COUNT);
  const scaleY = new Float32Array(COUNT);
  const rotC = new Float32Array(COUNT);
  const rotS = new Float32Array(COUNT);
  const alpha = new Float32Array(COUNT);
  const tint = new Uint32Array(COUNT);
  const textureId = new Uint16Array(COUNT);
  const anchorX = new Float32Array(COUNT);
  const anchorY = new Float32Array(COUNT);
  const repeatX = new Uint16Array(COUNT);
  const repeatY = new Uint16Array(COUNT);
  const sortKey = new Float32Array(COUNT);
  const type = new Uint8Array(COUNT);

  const lut = new Float32Array(TEX_N * TEX_LUT_FLOATS);
  for (let t = 0; t < TEX_N; t++) {
    const b = t * TEX_LUT_FLOATS;
    lut[b] = 16 + (t % 64);
    lut[b + 1] = 16 + ((t * 3) % 64);
    lut[b + 2] = (t % 16) / 16;
    lut[b + 3] = ((t * 2) % 16) / 16;
    lut[b + 4] = lut[b + 2] + 1 / 16;
    lut[b + 5] = lut[b + 3] + 1 / 16;
    lut[b + 6] = t % 4;
    lut[b + 7] = t % 3;
    lut[b + 8] = lut[b] - lut[b + 6];
    lut[b + 9] = lut[b + 1] - lut[b + 7];
  }

  for (let i = 0; i < COUNT; i++) {
    x[i] = rng() * 4000;
    y[i] = rng() * WORLD_H;
    scaleX[i] = 0.5 + rng();
    scaleY[i] = 0.5 + rng();
    const ang = rng() * 6.28;
    rotC[i] = Math.cos(ang);
    rotS[i] = Math.sin(ang);
    alpha[i] = 0.4 + rng() * 0.6;
    tint[i] = (0x20 + ((rng() * 0xdf) | 0)) * 0x010101;
    textureId[i] = (rng() * TEX_N) | 0;
    anchorX[i] = 0.5;
    anchorY[i] = 0.5;
    repeatX[i] = rng() < 0.05 ? 64 : 0;
    repeatY[i] = repeatX[i];
    sortKey[i] = y[i] * Y_SORT_K;
    const r = rng();
    // Predator-ish mix: mostly entities, some particles, few glows, rest deco/bullet
    if (r < 0.62) type[i] = TYPE_ENTITY;
    else if (r < 0.88) type[i] = TYPE_PARTICLE;
    else if (r < 0.94) type[i] = TYPE_GLOW;
    else type[i] = 2 + ((rng() * 3) | 0); // 2,4,5 — packed with entities
  }

  const q = {
    x,
    y,
    scaleX,
    scaleY,
    rotC,
    rotS,
    alpha,
    tint,
    textureId,
    anchorX,
    anchorY,
    repeatX,
    repeatY,
  };

  const depthDenom = COUNT + 1;
  const sortKeyMax = WORLD_H * Y_SORT_K + GLOW_BIAS + 1;
  const cap = COUNT;

  const out25 = new Float32Array(COUNT * PACK25);
  const out13 = new Float32Array(COUNT * PACK15);
  const idxE = new Uint16Array(COUNT);
  const idxP = new Uint16Array(COUNT);
  const idxG = new Uint16Array(COUNT);

  function compactIndices() {
    let ne = 0;
    let np = 0;
    let ng = 0;
    for (let i = 0; i < COUNT; i++) {
      const t = type[i];
      if (t === TYPE_PARTICLE) idxP[np++] = i;
      else if (t === TYPE_GLOW) idxG[ng++] = i;
      else idxE[ne++] = i;
    }
    return { ne, np, ng };
  }

  function pack25At(data, srcI, out, useSortKey) {
    const texId = q.textureId[srcI];
    const lutBase = texId * TEX_LUT_FLOATS;
    const ow = lut[lutBase];
    const oh = lut[lutBase + 1];
    const u0 = lut[lutBase + 2];
    const v0 = lut[lutBase + 3];
    const u1 = lut[lutBase + 4];
    const v1 = lut[lutBase + 5];
    const trimX = lut[lutBase + 6];
    const trimY = lut[lutBase + 7];
    const trimW = lut[lutBase + 8];
    const trimH = lut[lutBase + 9];
    let depth;
    if (useSortKey) {
      depth = 1.0 - sortKey[srcI] / sortKeyMax;
      depth -= (out + 1) * 1e-7;
    } else {
      depth = 1.0 - (out + 1) / depthDenom;
    }
    const tn = q.tint[srcI] >>> 0;
    const rx = q.repeatX[srcI];
    const ry = q.repeatY[srcI];
    const base = out * PACK25;
    data[base] = q.x[srcI];
    data[base + 1] = q.y[srcI];
    data[base + 2] = q.scaleX[srcI];
    data[base + 3] = q.scaleY[srcI];
    data[base + 4] = ow;
    data[base + 5] = oh;
    data[base + 6] = q.anchorX[srcI];
    data[base + 7] = q.anchorY[srcI];
    data[base + 8] = q.rotC[srcI];
    data[base + 9] = q.rotS[srcI];
    data[base + 10] = depth;
    data[base + 11] = u0;
    data[base + 12] = v0;
    data[base + 13] = u1;
    data[base + 14] = v1;
    data[base + 15] = ((tn >> 16) & 0xff) / 255;
    data[base + 16] = ((tn >> 8) & 0xff) / 255;
    data[base + 17] = (tn & 0xff) / 255;
    data[base + 18] = q.alpha[srcI];
    data[base + 19] = trimX;
    data[base + 20] = trimY;
    data[base + 21] = trimW;
    data[base + 22] = trimH;
    data[base + 23] = rx > 0 ? 1 / rx : 0;
    data[base + 24] = ry > 0 ? 1 / ry : 0;
  }

  function pack13At(data, srcI, out, useSortKey, cpuLut) {
    let depth;
    if (useSortKey) {
      depth = 1.0 - sortKey[srcI] / sortKeyMax;
      depth -= (out + 1) * 1e-7;
    } else {
      depth = 1.0 - (out + 1) / depthDenom;
    }
    const rx = q.repeatX[srcI];
    const ry = q.repeatY[srcI];
    if (cpuLut) {
      const lutBase = q.textureId[srcI] * TEX_LUT_FLOATS;
      void lut[lutBase];
      void lut[lutBase + 9];
    }
    const base = out * PACK15;
    data[base] = q.x[srcI];
    data[base + 1] = q.y[srcI];
    data[base + 2] = q.scaleX[srcI];
    data[base + 3] = q.scaleY[srcI];
    data[base + 4] = q.anchorX[srcI];
    data[base + 5] = q.anchorY[srcI];
    data[base + 6] = q.rotC[srcI];
    data[base + 7] = q.rotS[srcI];
    data[base + 8] = depth;
    data[base + 9] = q.alpha[srcI];
    data[base + 10] = q.textureId[srcI];
    data[base + 11] = rx > 0 ? 1 / rx : 0;
    data[base + 12] = ry > 0 ? 1 / ry : 0;
    data[base + 13] = 0;
    data[base + 14] = 0;
  }

  function scanFilter(includeType, excludeA, excludeB, packFn, data, useSortKey) {
    let out = 0;
    for (let i = 0; i < COUNT; i++) {
      const t = type[i];
      if (includeType !== undefined && t !== includeType) continue;
      if (excludeA !== undefined && (t === excludeA || t === excludeB)) continue;
      if (out >= cap) break;
      packFn(data, i, out, useSortKey);
      out++;
    }
    return out;
  }

  function packFromIndex(data, indices, n, packFn, useSortKey) {
    let out = 0;
    for (let k = 0; k < n; k++) {
      packFn(data, indices[k], out, useSortKey);
      out++;
    }
    return out;
  }

  function tripleScan25(data) {
    const a = scanFilter(undefined, TYPE_PARTICLE, TYPE_GLOW, pack25At, data, true);
    const b = scanFilter(TYPE_PARTICLE, undefined, undefined, pack25At, data, true);
    const c = scanFilter(TYPE_GLOW, undefined, undefined, pack25At, data, false);
    return a + b + c;
  }

  function compactThen25(data) {
    const { ne, np, ng } = compactIndices();
    const a = packFromIndex(data, idxE, ne, pack25At, true);
    const b = packFromIndex(data, idxP, np, pack25At, true);
    const c = packFromIndex(data, idxG, ng, pack25At, false);
    return a + b + c;
  }

  const pack13Shader = (data, srcI, out, useSortKey) =>
    pack13At(data, srcI, out, useSortKey, false);
  const pack13CpuLut = (data, srcI, out, useSortKey) =>
    pack13At(data, srcI, out, useSortKey, true);

  function tripleScan13Shader(data) {
    const a = scanFilter(undefined, TYPE_PARTICLE, TYPE_GLOW, pack13Shader, data, true);
    const b = scanFilter(TYPE_PARTICLE, undefined, undefined, pack13Shader, data, true);
    const c = scanFilter(TYPE_GLOW, undefined, undefined, pack13Shader, data, false);
    return a + b + c;
  }

  function tripleScan13CpuLut(data) {
    const a = scanFilter(undefined, TYPE_PARTICLE, TYPE_GLOW, pack13CpuLut, data, true);
    const b = scanFilter(TYPE_PARTICLE, undefined, undefined, pack13CpuLut, data, true);
    const c = scanFilter(TYPE_GLOW, undefined, undefined, pack13CpuLut, data, false);
    return a + b + c;
  }

  function compactThen13Shader(data) {
    const { ne, np, ng } = compactIndices();
    const a = packFromIndex(data, idxE, ne, pack13Shader, true);
    const b = packFromIndex(data, idxP, np, pack13Shader, true);
    const c = packFromIndex(data, idxG, ng, pack13Shader, false);
    return a + b + c;
  }

  const n25 = tripleScan25(out25);
  const nC = compactThen25(out25);
  const n13 = tripleScan13Shader(out13);
  const n13c = compactThen13Shader(out13);
  if (n25 !== nC || n25 !== n13 || n25 !== n13c) {
    throw new Error(`pack count mismatch 25=${n25} compact25=${nC} 13=${n13} compact13=${n13c}`);
  }

  // Same visible item → same xy in both records (first entity-like pass).
  const { ne } = compactIndices();
  packFromIndex(out25, idxE, ne, pack25At, true);
  packFromIndex(out13, idxE, ne, pack13Shader, true);
  for (let k = 0; k < Math.min(ne, 64); k++) {
    const a = k * PACK25;
    const b = k * PACK15;
    if (out25[a] !== out13[b] || out25[a + 1] !== out13[b + 1]) {
      throw new Error(`xy mismatch at packed ${k}`);
    }
    if (out25[a + 2] !== out13[b + 2] || out25[a + 8] !== out13[b + 6]) {
      throw new Error(`scale/rotC mismatch at packed ${k}`);
    }
  }
  console.log(`Correctness OK (packed ${n25} instances, ${ne} non-particle/glow)`);

  const opts = { iterations: FRAMES };
  const baseline = timeIt(
    `triple-scan pack25 (baseline) N=${COUNT}`,
    (n) => {
      let sink = 0;
      for (let f = 0; f < n; f++) sink += tripleScan25(out25);
      if (sink === -1) console.log(sink);
    },
    opts
  );
  const compact25 = timeIt(
    `compact-index pack25 N=${COUNT}`,
    (n) => {
      let sink = 0;
      for (let f = 0; f < n; f++) sink += compactThen25(out25);
      if (sink === -1) console.log(sink);
    },
    opts
  );
  const shaderLut = timeIt(
    `triple-scan pack13 shader-LUT N=${COUNT}`,
    (n) => {
      let sink = 0;
      for (let f = 0; f < n; f++) sink += tripleScan13Shader(out13);
      if (sink === -1) console.log(sink);
    },
    opts
  );
  const cpuLut = timeIt(
    `triple-scan pack13 CPU-LUT N=${COUNT}`,
    (n) => {
      let sink = 0;
      for (let f = 0; f < n; f++) sink += tripleScan13CpuLut(out13);
      if (sink === -1) console.log(sink);
    },
    opts
  );
  const compact13 = timeIt(
    `compact-index pack13 shader-LUT N=${COUNT}`,
    (n) => {
      let sink = 0;
      for (let f = 0; f < n; f++) sink += compactThen13Shader(out13);
      if (sink === -1) console.log(sink);
    },
    opts
  );

  const report = {
    name: 'instanced-pack',
    hyp: 'INSTANCED-PACK',
    seed: SEED,
    count: COUNT,
    frames: FRAMES,
    textures: TEX_N,
    packed: n25,
    correctness: { ok: true },
    timings: { baseline, compact25, shaderLut, cpuLut, compact13 },
    ratios: {
      compact25: compact25.ms / baseline.ms,
      shaderLut: shaderLut.ms / baseline.ms,
      cpuLut: cpuLut.ms / baseline.ms,
      compact13: compact13.ms / baseline.ms,
    },
  };

  console.log(
    `Ratios opt/baseline (<1 faster): compact25=${report.ratios.compact25.toFixed(3)} shaderLut=${report.ratios.shaderLut.toFixed(3)} cpuLut=${report.ratios.cpuLut.toFixed(3)} compact13=${report.ratios.compact13.toFixed(3)}`
  );
  if (outputPath) writeReport(outputPath, report);
  return report;
}

const isDirect =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirect) {
  const args = parseArgs();
  const counts = args.count != null ? [Number(args.count)] : [2000, 8000];
  const reports = [];
  for (const count of counts) {
    console.log(`\n=== N=${count} ===`);
    reports.push(runInstancedPackMicrobench({ ...args, count, output: undefined }));
  }
  const outputPath = args.output ? String(args.output) : null;
  if (outputPath) {
    writeReport(outputPath, { name: 'instanced-pack', counts, reports });
  }
}
