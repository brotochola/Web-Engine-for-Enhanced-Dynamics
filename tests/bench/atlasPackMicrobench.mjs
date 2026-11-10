/**
 * Kernel: the bigAtlas packer (SpriteSheetRegistry.MaxRectsPacker, the shipped class) on the rectangles the Buenos Aires
 * demo's load gives it (tests/fixtures/atlasRects.buenosAires.json: 4 386 frames into 8192 × 4096, in createBigAtlas's
 * order). One op = one whole pack. Checksum: FNV-1a over every placed x and y, so a pack that places anything elsewhere
 * reads differently.
 *
 *   node tests/bench/atlasPackMicrobench.mjs [--rects N] [--reps 3] [--output path]
 *
 * Warm-up: short packs (the first 200 rectangles) until the packer's methods are a normal compile, then whole packs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checksumInts, isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/atlasRects.buenosAires.json');

/** The fixture's rectangles, the first `rects` of them. */
export function loadAtlasRects(rects = Infinity) {
  const d = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const n = Math.min(d.sizes.length >> 1, rects);
  return { width: d.width, height: d.height, padding: d.padding, heuristic: d.heuristic, sizes: d.sizes.slice(0, n * 2), count: n };
}

/** Packs `data` with `Packer`; returns placements [x, y, …] (-1 where a rectangle did not fit) and the free list's peak. */
export function packAtlasRects(Packer, data, count = data.count) {
  const packer = new Packer(data.width, data.height, data.padding);
  const placed = new Int32Array(count * 2);
  let peak = 0;
  for (let i = 0; i < count; i++) {
    const r = packer.insert(data.sizes[2 * i], data.sizes[2 * i + 1], data.heuristic);
    placed[2 * i] = r ? r.x : -1;
    placed[2 * i + 1] = r ? r.y : -1;
    if (packer.freeRects.length > peak) peak = packer.freeRects.length;
  }
  return { placed, peak };
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const data = loadAtlasRects(args.rects ?? Infinity);
  const Packer = SpriteSheetRegistry.MaxRectsPacker;
  warmNormalCompile(() => packAtlasRects(Packer, data, Math.min(200, data.count)), 30);
  let last = null;
  const result = timeIt(`atlas pack (${data.count} rects)`, () => {
    last = packAtlasRects(Packer, data);
  }, { reps: args.reps ?? 3, warmup: 1 });
  const checksum = checksumInts(last.placed);
  const misses = last.placed.filter((v) => v < 0).length / 2;
  console.log(`checksum ${checksum}  free rects peak ${last.peak}  not placed ${misses}  ${(result.ms).toFixed(1)} ms a pack`);
  if (args.output) {
    writeReport(args.output, {
      kernel: 'atlasPack',
      rects: data.count,
      msPerPack: result.ms,
      packsPerSec: result.opsPerSec,
      checksum,
      freeRectsPeak: last.peak,
      notPlaced: misses,
      tier: 'TurboFan (normal compile after short packs)',
    });
  }
}
