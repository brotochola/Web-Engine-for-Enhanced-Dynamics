/**
 * Kernel H1a: pack dirty decal tiles into instance stride vs dummy sprite records.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mulberry32, timeIt, writeReport } from './microbenchHelpers.mjs';
import {
  INSTANCED_SPRITE_FLOATS,
  packDecalBlit,
  packDecalSpriteRecords,
  checksumDecalBlit,
} from '../../src/render/decalBlitPack.js';

const TILES_X = 64;
const TILES_Y = 64;
const TILE_SIZE = 64;
const DIRTY_N = 2048;
const CAP = TILES_X * TILES_Y;

const here = path.dirname(fileURLToPath(import.meta.url));
const reportDir = path.resolve(here, '../results/pixi-peel/h1a-decal-blit');

function makeViews(rng) {
  const dirty = new Uint8Array(CAP);
  let n = 0;
  while (n < DIRTY_N) {
    const i = (rng() * CAP) | 0;
    if (dirty[i]) continue;
    dirty[i] = 1;
    n++;
  }
  const inst = new Float32Array(CAP * INSTANCED_SPRITE_FLOATS);
  return {
    tilesX: TILES_X,
    tilesY: TILES_Y,
    tileSize: TILE_SIZE,
    dirty,
    cap: CAP,
    inst,
    sprites: new Float32Array(CAP * 3),
    outU32: new Uint32Array(inst.buffer),
  };
}

const rng = mulberry32(0xdecb11);
const views = makeViews(rng);
const nInst = packDecalBlit(views.inst, views);
const nSpr = packDecalSpriteRecords(views.sprites, views);
if (nInst !== DIRTY_N || nSpr !== DIRTY_N) {
  throw new Error(`decal blit pack count ${nInst}/${nSpr} expected ${DIRTY_N}`);
}
const checksum = checksumDecalBlit(views.inst, views.sprites, nInst);
if (checksum < 0) {
  throw new Error('decal blit pack checksum failed; times do not count');
}

const sprites = timeIt('sprite records', (iterations) => {
  for (let i = 0; i < iterations; i++) packDecalSpriteRecords(views.sprites, views);
}, { iterations: 80, warmup: 8, reps: 5 });

const batch = timeIt('packDecalBlit', (iterations) => {
  for (let i = 0; i < iterations; i++) packDecalBlit(views.inst, views);
}, { iterations: 80, warmup: 8, reps: 5 });

const payload = {
  name: 'decal-blit-pack',
  tilesX: TILES_X,
  tilesY: TILES_Y,
  dirty: DIRTY_N,
  checksum,
  checksumOk: true,
  spriteRecords: sprites,
  packDecalBlit: batch,
};

writeReport(path.join(reportDir, 'kernel.json'), payload);
console.log(
  `decal-blit sprite ${Math.round(sprites.opsPerSec).toLocaleString()} ops/s  ` +
    `pack ${Math.round(batch.opsPerSec).toLocaleString()} ops/s  checksum ${checksum}`,
);
