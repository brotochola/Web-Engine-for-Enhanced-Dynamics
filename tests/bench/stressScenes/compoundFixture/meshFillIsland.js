import WEED from '/src/index.js';
import { makeIslandPolys } from './makeIslandPolys.js';

const { GameObject, RigidBody, Collider, MeshRenderer } = WEED;

/** MESH fill island. Static or spinning; packer reads fixtures or primary shape. */
export class MeshFillIsland extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [RigidBody, Collider, MeshRenderer];

  onSpawned({
    x = 0,
    y = 0,
    triangles = 8,
    vertsPerPoly = 3,
    cell = 12,
    tint = 0x88aa66,
    spin = 0,
    usePrimaryBox = false,
    width = 48,
    height = 32,
  } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = 0;
    // Static body: MF4 moving scene must change Transform pose, not Box2D.
    // Dynamic 6500-compound piles collapse BODY_COUNT (baseline saw 715).
    this.rigidBody.static = 1;
    this.rigidBody.fixedRotation = 1;
    this.collider.visualRange = 0;
    this.meshRenderer.tint = tint;
    this.setLayer('terrain');
    if (usePrimaryBox) {
      this.collider.shapeType = WEED.ShapeType.Box;
      this.collider.width = width;
      this.collider.height = height;
    } else {
      const polys = makeIslandPolys(triangles, cell, vertsPerPoly);
      if (!this.collider.replacePolygons(polys)) this.despawn();
    }
    this._spin = spin;
  }

  tick() {
    if (this._spin) this.rotation += this._spin;
  }
}
