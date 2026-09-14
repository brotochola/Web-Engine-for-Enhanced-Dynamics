// MamushkaComponent — nest level + material/hp (no quadtree).

import { Component } from '/src/core/component.js';

/** Dirt (shallow). */
export const MATERIAL_DIRT = 0;
/** Stone (deep). */
export const MATERIAL_STONE = 1;

export const MATERIAL_TINT = Object.freeze({
  [MATERIAL_DIRT]: 0x72411a,
  [MATERIAL_STONE]: 0x9a9aa0,
});

/** Hits to kill at level 0; higher levels get (level+1)× this. */
export const MATERIAL_HARDNESS = Object.freeze({
  [MATERIAL_DIRT]: 1,
  [MATERIAL_STONE]: 3,
});

export function maxHpFor(level, material) {
  const h = MATERIAL_HARDNESS[material] ?? 1;
  return Math.max(1, (level + 1) * h);
}

export class MamushkaComponent extends Component {
  static ARRAY_SCHEMA = {
    level: Uint8Array,
    material: Uint8Array,
    hp: Uint8Array,
    size: Float32Array,
  };
}
