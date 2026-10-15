/** Grid occupancy + joint planning for the Bad Piggies demo. Pure, no engine imports. */

export const CELL = 80;
export const WHEEL_RADIUS = 100;
export const LAYER_BOX = 1;
export const LAYER_WHEEL = 2;
export const LAYER_ROCKET = 3;
export const MASK_BOX = (1 << 0) | (1 << 1);
export const MASK_WHEEL = 1 << 0;
export const MASK_ROCKET = 1 << 0;
export const PALETTE_BOX = 'box';
export const PALETTE_WHEEL = 'wheel';
export const PALETTE_ROCKET = 'rocket';
export const ROCKET_LEN = 80;
export const ROCKET_H = 24;
export const ROCKET_THRUST = 60000;
export const DEFAULT_ROCKET_ANGLE = -Math.PI / 2;

const ORTHO = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export function cellKey(gx, gy) {
  return gx + ',' + gy;
}

export function parseCellKey(key) {
  const comma = key.indexOf(',');
  return { gx: Number(key.slice(0, comma)), gy: Number(key.slice(comma + 1)) };
}

export function worldToCell(x, y, originX, originY, cell = CELL) {
  return {
    gx: Math.round((x - originX) / cell),
    gy: Math.round((y - originY) / cell),
  };
}

export function cellToWorld(gx, gy, originX, originY, cell = CELL) {
  return {
    x: originX + gx * cell,
    y: originY + gy * cell,
  };
}

export function snapWorld(x, y, originX, originY, cell = CELL) {
  const { gx, gy } = worldToCell(x, y, originX, originY, cell);
  return { gx, gy, ...cellToWorld(gx, gy, originX, originY, cell) };
}

function occupancyGet(occupancy, key) {
  return occupancy instanceof Map ? occupancy.get(key) : occupancy[key];
}

export function canPlaceBox(occupancy, gx, gy) {
  return !occupancyGet(occupancy, cellKey(gx, gy));
}

export function canPlaceWheel(occupancy, gx, gy) {
  const cell = occupancyGet(occupancy, cellKey(gx, gy));
  return !!(cell && cell.boxIndex >= 0 && !(cell.wheelIndex >= 0));
}

export function canPlaceRocket(occupancy, gx, gy) {
  const cell = occupancyGet(occupancy, cellKey(gx, gy));
  return !!(cell && cell.boxIndex >= 0 && !(cell.rocketIndex >= 0));
}

/**
 * @param {Map<string,{boxIndex:number,wheelIndex:number}>|Record<string,{boxIndex:number,wheelIndex:number}>} occupancy
 * @param {number} originX
 * @param {number} originY
 * @param {number} [cell]
 * @returns {{ welds: object[], revolutes: object[] }}
 */
export function planJoints(occupancy, originX, originY, cell = CELL) {
  const welds = [];
  const revolutes = [];
  const entries = occupancy instanceof Map ? occupancy.entries() : Object.entries(occupancy);

  for (const [key, rec] of entries) {
    if (!rec || rec.boxIndex < 0) continue;
    const { gx, gy } = parseCellKey(key);
    const pos = cellToWorld(gx, gy, originX, originY, cell);

    if (rec.wheelIndex >= 0) {
      revolutes.push({
        entityA: rec.boxIndex,
        entityB: rec.wheelIndex,
        worldAnchorX: pos.x,
        worldAnchorY: pos.y,
      });
    }

    if (rec.rocketIndex >= 0) {
      welds.push({
        entityA: rec.boxIndex,
        entityB: rec.rocketIndex,
        worldAnchorX: pos.x,
        worldAnchorY: pos.y,
      });
    }

    for (let i = 0; i < ORTHO.length; i++) {
      const ngx = gx + ORTHO[i][0];
      const ngy = gy + ORTHO[i][1];
      const neighbor = occupancyGet(occupancy, cellKey(ngx, ngy));
      if (!neighbor || neighbor.boxIndex < 0) continue;
      if (rec.boxIndex >= neighbor.boxIndex) continue;
      const npos = cellToWorld(ngx, ngy, originX, originY, cell);
      welds.push({
        entityA: rec.boxIndex,
        entityB: neighbor.boxIndex,
        worldAnchorX: (pos.x + npos.x) * 0.5,
        worldAnchorY: (pos.y + npos.y) * 0.5,
      });
    }
  }

  return { welds, revolutes };
}

/**
 * Convert a height polyline (world Y of the surface) into rotated static boxes.
 * Boxes extend in +Y (down) so the top edge follows the polyline.
 * @param {Float32Array|number[]} heights
 * @param {number} x0
 * @param {number} dx
 * @param {number} thickness
 * @param {number} [overlap=1.05]
 */
export function heightsToSegments(heights, x0, dx, thickness, overlap = 1.05) {
  const segs = [];
  const n = heights.length;
  const half = thickness * 0.5;
  for (let i = 0; i < n - 1; i++) {
    const xA = x0 + i * dx;
    const xB = x0 + (i + 1) * dx;
    const yA = heights[i];
    const yB = heights[i + 1];
    const sx = xB - xA;
    const sy = yB - yA;
    const len = Math.sqrt(sx * sx + sy * sy);
    if (!(len > 0)) continue;
    const angle = Math.atan2(sy, sx);
    segs.push({
      x: (xA + xB) * 0.5 - Math.sin(angle) * half,
      y: (yA + yB) * 0.5 + Math.cos(angle) * half,
      width: len * overlap,
      height: thickness,
      rotation: angle,
    });
  }
  return segs;
}
