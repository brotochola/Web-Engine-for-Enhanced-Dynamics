import WEED from '/src/index.js';
import { makeIslandPolys } from './makeIslandPolys.js';

const { GameObject, RigidBody, Collider } = WEED;

/** Dynamic compound body. Spatial walks getColliderBounds over every fixture. */
export class CompoundSpatialIsland extends GameObject {
  static components = [RigidBody, Collider];

  onSpawned({
    x = 0,
    y = 0,
    rotation = 0,
    triangles = 8,
    visualRange = 180,
    cell = 12,
  } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = rotation;
    this.rigidBody.static = 0;
    this.rigidBody.linearDamping = 0.4;
    this.rigidBody.angularDamping = 0.8;
    this.collider.visualRange = visualRange;
    this.collider.friction = 0.2;
    const polys = makeIslandPolys(triangles, cell);
    if (!this.collider.replacePolygons(polys)) this.despawn();
  }

  tick() {}
}
