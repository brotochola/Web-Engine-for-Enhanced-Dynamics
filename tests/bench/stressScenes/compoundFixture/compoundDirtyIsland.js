import WEED from '/src/index.js';
import { makeIslandPolys } from './makeIslandPolys.js';

const { GameObject, RigidBody, Collider } = WEED;

/**
 * Replaces the same vertex count every tick so GEOMETRY dirty stays on.
 * Load key is BODY_COUNT; triangle count must stay constant.
 */
export class CompoundDirtyIsland extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [RigidBody, Collider];

  onSpawned({
    x = 0,
    y = 0,
    triangles = 8,
    cell = 12,
    phase = 0,
    useFlat = false,
  } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = 0;
    this.rigidBody.static = 1;
    this._triangles = triangles | 0;
    this._cell = cell;
    this._phase = phase | 0;
    this._useFlat = !!useFlat;
    this._polysA = makeIslandPolys(this._triangles, cell);
    this._polysB = makeIslandPolys(this._triangles, cell + 0.35);
    this._packFlat(this._polysA, '_flatA');
    this._packFlat(this._polysB, '_flatB');
    this._apply(this._polysA, this._flatA);
  }

  _packFlat(polys, key) {
    const counts = new Uint8Array(polys.length);
    let n = 0;
    for (let i = 0; i < polys.length; i++) {
      counts[i] = polys[i].length;
      n += polys[i].length * 2;
    }
    const xy = new Float32Array(n);
    let o = 0;
    for (let i = 0; i < polys.length; i++) {
      const p = polys[i];
      for (let v = 0; v < p.length; v++) {
        xy[o++] = p[v].x;
        xy[o++] = p[v].y;
      }
    }
    this[key] = { xy, counts, polygonCount: polys.length };
  }

  _apply(polys, flat) {
    if (this._useFlat && this.collider.replacePolygonsFlat) {
      this.collider.replacePolygonsFlat(flat.xy, flat.counts, flat.polygonCount);
      return;
    }
    this.collider.replacePolygons(polys);
  }

  tick() {
    this._phase = this._phase ^ 1;
    if (this._phase) this._apply(this._polysB, this._flatB);
    else this._apply(this._polysA, this._flatA);
  }
}
