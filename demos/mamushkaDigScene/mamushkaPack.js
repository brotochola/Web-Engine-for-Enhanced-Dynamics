// Noise occupancy → order-1 quadtree pack (destructuble_terrain_2d procgen.js).

import { Noise2D } from '../../src/core/noise2D.js';

const MATERIAL_DIRT = 0;
const MATERIAL_STONE = 1;

function smoothOccupancy(solid, cols, rows, passes = 2) {
  let cur = solid;
  for (let p = 0; p < passes; p++) {
    const next = new Uint8Array(cols * rows);
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const x = gx + dx;
            const y = gy + dy;
            if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
            n += cur[y * cols + x];
          }
        }
        next[gy * cols + gx] = n >= 5 ? 1 : 0;
      }
    }
    cur = next;
  }
  return cur;
}

function assignMaterialsByDepth(solid, cols, rows, stoneDepthFrac) {
  const materials = new Uint8Array(cols * rows);
  const frac = Math.max(0, Math.min(1, stoneDepthFrac));
  for (let gy = 0; gy < rows; gy++) {
    const depth = rows > 1 ? gy / (rows - 1) : 1;
    const mat = depth >= frac ? MATERIAL_STONE : MATERIAL_DIRT;
    for (let gx = 0; gx < cols; gx++) {
      const i = gy * cols + gx;
      if (solid[i]) materials[i] = mat;
    }
  }
  return materials;
}

/**
 * @param {object} opts
 * @param {number} opts.cols
 * @param {number} opts.rows
 * @param {number} [opts.seed]
 * @param {number} [opts.scale] noise frequency in order-1 cell units
 * @param {number} [opts.threshold]
 * @param {number} [opts.yBias]
 * @param {number} [opts.stoneDepthFrac]
 * @returns {{ solid: Uint8Array, materials: Uint8Array, cols: number, rows: number }}
 */
export function buildOccupancy({
  cols,
  rows,
  seed = 9193191,
  scale = 0.06,
  threshold = 0.15,
  yBias = 0.5,
  stoneDepthFrac = 0.45,
  octaves = 2,
}) {
  const noise = new Noise2D(seed);
  const raw = new Uint8Array(cols * rows);
  for (let gy = 0; gy < rows; gy++) {
    const depth = rows > 1 ? gy / (rows - 1) : 1;
    for (let gx = 0; gx < cols; gx++) {
      const n = noise.fbm((gx + 0.5) * scale, (gy + 0.5) * scale, octaves, 1, 1, 2, 0.5);
      if (n + yBias * depth > threshold) raw[gy * cols + gx] = 1;
    }
  }
  const solid = smoothOccupancy(raw, cols, rows, 2);
  const materials = assignMaterialsByDepth(solid, cols, rows, stoneDepthFrac);
  return { solid, materials, cols, rows };
}

function regionState(solid, materials, cols, rows, gx, gy, side) {
  let anySolid = false;
  let anyHollow = false;
  let matCode = 0;
  for (let y = gy; y < gy + side; y++) {
    if (y < 0 || y >= rows) {
      anyHollow = true;
      continue;
    }
    for (let x = gx; x < gx + side; x++) {
      if (x < 0 || x >= cols || !solid[y * cols + x]) {
        anyHollow = true;
        if (anySolid) return 'mixed';
      } else {
        const m = materials[y * cols + x];
        if (!anySolid) {
          matCode = m;
          anySolid = true;
          if (anyHollow) return 'mixed';
        } else if (m !== matCode) {
          return 'mixed';
        }
      }
    }
  }
  if (!anySolid) return 'hollow';
  if (!anyHollow) return 'solid';
  return 'mixed';
}

function packSquare(out, solid, materials, cols, rows, gx, gy, sideCells, maxPackOrder) {
  if (sideCells < 1) return;
  const state = regionState(solid, materials, cols, rows, gx, gy, sideCells);
  if (state === 'hollow') return;

  const order = 1 + Math.log2(sideCells);
  if (state === 'solid' && order === (order | 0) && order <= maxPackOrder) {
    out.push({
      gx,
      gy,
      sideCells,
      level: order,
      material: materials[gy * cols + gx],
    });
    return;
  }

  if (sideCells === 1) {
    if (state === 'solid') {
      out.push({
        gx,
        gy,
        sideCells: 1,
        level: 1,
        material: materials[gy * cols + gx],
      });
    }
    return;
  }

  const half = sideCells >> 1;
  packSquare(out, solid, materials, cols, rows, gx, gy, half, maxPackOrder);
  packSquare(out, solid, materials, cols, rows, gx + half, gy, half, maxPackOrder);
  packSquare(out, solid, materials, cols, rows, gx, gy + half, half, maxPackOrder);
  packSquare(out, solid, materials, cols, rows, gx + half, gy + half, half, maxPackOrder);
}

function packRect(out, solid, materials, cols, rows, gx, gy, w, h, maxPackOrder) {
  if (w <= 0 || h <= 0) return;
  const maxSide = 2 ** Math.max(0, maxPackOrder - 1);
  let side = 1;
  const maxFit = Math.min(w, h, maxSide);
  while (side * 2 <= maxFit) side *= 2;
  packSquare(out, solid, materials, cols, rows, gx, gy, side, maxPackOrder);
  packRect(out, solid, materials, cols, rows, gx + side, gy, w - side, side, maxPackOrder);
  packRect(out, solid, materials, cols, rows, gx, gy + side, w, h - side, maxPackOrder);
}

/**
 * Quadtree pack on order-1 cells. Finest intact level is 1 (side = 2 * leaf).
 * @returns {{ gx: number, gy: number, sideCells: number, level: number, material: number }[]}
 */
export function packMamushkaRoots(solid, materials, cols, rows, maxPackOrder = 6) {
  const out = [];
  packRect(out, solid, materials, cols, rows, 0, 0, cols, rows, maxPackOrder);
  return out;
}

/** ponytail: fails if pack overlaps, covers hollow, or misses solid. */
export function assertPackCoversSolid(solid, materials, cols, rows, roots) {
  const cover = new Uint8Array(cols * rows);
  for (let i = 0; i < roots.length; i++) {
    const r = roots[i];
    const side = r.sideCells;
    const wantLevel = 1 + Math.log2(side);
    if (r.level !== wantLevel) {
      throw new Error(`level ${r.level} != 1+log2(${side})`);
    }
    for (let dy = 0; dy < side; dy++) {
      for (let dx = 0; dx < side; dx++) {
        const x = r.gx + dx;
        const y = r.gy + dy;
        const idx = y * cols + x;
        if (cover[idx]) throw new Error(`double cover at ${x},${y}`);
        cover[idx] = 1;
        if (!solid[idx]) throw new Error(`pack over hollow at ${x},${y}`);
        if (materials[idx] !== r.material) {
          throw new Error(`material mismatch at ${x},${y}`);
        }
      }
    }
  }
  for (let i = 0; i < solid.length; i++) {
    if (solid[i] && !cover[i]) throw new Error(`missed solid cell ${i}`);
  }
}
