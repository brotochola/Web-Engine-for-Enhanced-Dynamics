import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, Box2d } = WEED;

export class QueryAabbChurnProbe extends GameObject {
  static components = [RigidBody, Collider];

  onSpawned({ x = 0, y = 0, queries = 1 } = {}) {
    this.x = x;
    this.y = y;
    this._queries = queries | 0 || 1;
    this.rigidBody.static = true;
    this.collider.radius = 1;
    this.rigidBody.syncMassFromCollider();
    this._out = new Int32Array(256);
    this._hits = 0;
  }

  tick() {
    try {
      const t = this.scene?.mainFrameNumber || 0;
      // The box breathes with the frame; each further query a tick (?queries) is a little larger, so none repeats.
      for (let q = 0; q < this._queries; q++) {
        const half = 180 + ((t + q) % 40) + q;
        this._hits = Box2d.queryAABB(
          this.x - half,
          this.y - half,
          this.x + half,
          this.y + half,
          this._out
        );
      }
    } catch (err) {
      if (!String(err && err.message).includes('not bound')) {
        console.error('[QueryAabbChurnProbe]', err);
      }
    }
  }
}
