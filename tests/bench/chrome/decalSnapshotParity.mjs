// N-314: Decal.packSnapshot and applySnapshot in the browser: a decal buffer with tiles of random strokes packed (each
// tile deflated), the buffer cleared, the pack applied back. Every tile must come back exactly, in its own place, and
// the empty tiles must stay empty; the times of the pack and the apply are reported.
//   MSYS_NO_PATHCONV=1 node tests/bench/chromeKernel.mjs --module /tests/bench/chrome/decalSnapshotParity.mjs \
//     [--args '{"tilesX":12,"tilesY":10,"filled":0.6,"tilePixelSize":256}']
import { Decal } from '/src/core/decal.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function run(args = {}) {
  const tilesX = args.tilesX ?? 12;
  const tilesY = args.tilesY ?? 10;
  const size = args.tilePixelSize ?? 256;
  const filled = args.filled ?? 0.6;
  const total = tilesX * tilesY;
  const bytesPerTile = size * size * 4;
  const sab = new SharedArrayBuffer(total * bytesPerTile);
  const rgba = new Uint8ClampedArray(sab);
  const r = mulberry32(0x314);
  const used = [];
  for (let i = 0; i < total; i++) {
    if (r() >= filled) continue;
    used.push(i);
    const base = i * bytesPerTile;
    for (let s = 0; s < 40; s++) {
      const cx = (r() * size) | 0;
      const cy = (r() * size) | 0;
      const rad = 2 + ((r() * 12) | 0);
      const red = (r() * 255) | 0;
      const alpha = 40 + ((r() * 215) | 0);
      for (let y = Math.max(0, cy - rad); y < Math.min(size, cy + rad); y++) {
        for (let x = Math.max(0, cx - rad); x < Math.min(size, cx + rad); x++) {
          const o = base + (y * size + x) * 4;
          rgba[o] = red;
          rgba[o + 1] = 20;
          rgba[o + 2] = 10;
          rgba[o + 3] = alpha;
        }
      }
    }
  }
  const original = new Uint8ClampedArray(rgba);
  const scene = {
    config: { particle: { decals: true, decalsTilePixelSize: size, decalsTileSize: 256 } },
    buffers: { decalsTilesRGBA: sab, decalsTilesDirty: new SharedArrayBuffer(total) },
    decalsTilesX: tilesX,
    decalsTilesY: tilesY,
    decalsTotalTiles: total,
  };

  const t0 = performance.now();
  const pack = await Decal.packSnapshot(scene);
  const packMs = performance.now() - t0;
  rgba.fill(0);
  const t1 = performance.now();
  const applied = await Decal.applySnapshot(scene, pack);
  const applyMs = performance.now() - t1;

  let wrongTiles = 0;
  let strayTiles = 0;
  const usedSet = new Set(used);
  for (let i = 0; i < total; i++) {
    const base = i * bytesPerTile;
    const got = rgba.subarray(base, base + bytesPerTile);
    if (!usedSet.has(i)) {
      if (got.some((v) => v !== 0)) strayTiles++;
      continue;
    }
    const want = original.subarray(base, base + bytesPerTile);
    for (let k = 0; k < bytesPerTile; k++) {
      if (got[k] !== want[k]) {
        wrongTiles++;
        break;
      }
    }
  }
  const dirty = new Uint8Array(scene.buffers.decalsTilesDirty);
  const dirtyCount = dirty.reduce((n, v) => n + (v ? 1 : 0), 0);
  return {
    tiles: total,
    used: used.length,
    packed: pack ? pack.tiles.length : 0,
    packedInOrder: pack ? pack.tiles.every((t, k) => t.i === used[k] && t.fmt === 'deflate') : false,
    packedKB: pack ? Math.round(pack.tiles.reduce((n, t) => n + t.bytes.byteLength, 0) / 1024) : 0,
    restored: applied.restored,
    dirty: dirtyCount,
    wrongTiles,
    strayTiles,
    packMs: Math.round(packMs),
    applyMs: Math.round(applyMs),
  };
}
