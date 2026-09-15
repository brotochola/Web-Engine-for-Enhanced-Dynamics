import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider } = WEED;

export class QueryAabbChurnProbe extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [RigidBody, Collider];

  onSpawned({ x = 0, y = 0 } = {}) {
    this.x = x;
    this.y = y;
    this.rigidBody.static = true;
    this.collider.radius = 1;
    this.rigidBody.syncMassFromCollider();
    this._out = new Int32Array(256);
    this._hits = 0;
  }

  tick() {
    try {
      const t = this.scene?.mainFrameNumber || 0;
      const half = 180 + (t % 40);
      this._hits = this.box2dQueryAABB(
        this.x - half,
        this.y - half,
        this.x + half,
        this.y + half,
        this._out
      );
    } catch (err) {
      if (!String(err && err.message).includes('not bound')) {
        console.error('[QueryAabbChurnProbe]', err);
      }
    }
  }
}
