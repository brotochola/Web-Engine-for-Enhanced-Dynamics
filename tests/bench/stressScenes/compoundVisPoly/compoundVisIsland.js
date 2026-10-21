import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, LightOccluder } = WEED;

const WORLD_W = 2400;
const WORLD_H = 2400;

/** CCW ring with a hole. Shared corners so interior edges cancel. */
export function makeRingPolys(segments, outerR, innerR) {
  const n = segments | 0;
  const ox = new Float64Array(n);
  const oy = new Float64Array(n);
  const ix = new Float64Array(n);
  const iy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    ox[i] = c * outerR;
    oy[i] = s * outerR;
    ix[i] = c * innerR;
    iy[i] = s * innerR;
  }
  const polys = [];
  for (let i = 0; i < n; i++) {
    const j = i + 1 < n ? i + 1 : 0;
    polys.push([
      { x: ix[i], y: iy[i] },
      { x: ox[i], y: oy[i] },
      { x: ox[j], y: oy[j] },
    ]);
    polys.push([
      { x: ix[i], y: iy[i] },
      { x: ox[j], y: oy[j] },
      { x: ix[j], y: iy[j] },
    ]);
  }
  return polys;
}

export class CompoundVisIsland extends GameObject {
  static components = [RigidBody, Collider, LightOccluder];

  onSpawned({
    x = 0,
    y = 0,
    rotation = 0,
    vx = 0,
    vy = 0,
    spin = 0,
    remeshEvery = 0,
    segments = 18,
  } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = rotation;
    this.rigidBody.static = 0;
    this.rigidBody.linearDamping = 0;
    this.rigidBody.angularDamping = 0;
    this.collider.visualRange = 96;
    this.collider.friction = 0.2;
    const polys = makeRingPolys(segments, 80, 32);
    if (!this.collider.replacePolygons(polys)) {
      this.despawn();
      return;
    }
    this._polys = polys;
    this._remeshEvery = remeshEvery | 0;
    this._remeshTick = 0;
    this.lightOccluder.active = 1;
    this.lightOccluder.block = 1;
    this.setVelocity(vx, vy);
    this.angularVelocity = spin;
    this.setAwake(true);
  }

  tick() {
    const i = this.index;
    let vx = RigidBody.vx[i];
    let vy = RigidBody.vy[i];
    if ((this.x < 160 && vx < 0) || (this.x > WORLD_W - 160 && vx > 0)) vx = -vx;
    if ((this.y < 160 && vy < 0) || (this.y > WORLD_H - 160 && vy > 0)) vy = -vy;
    RigidBody.vx[i] = vx;
    RigidBody.vy[i] = vy;
    // Same polygons: only the fixture revision moves (see the scene's remeshEvery).
    if (this._remeshEvery > 0 && ++this._remeshTick >= this._remeshEvery) {
      this._remeshTick = 0;
      this.collider.replacePolygons(this._polys);
    }
  }
}
