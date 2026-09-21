import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, LiquidFun } = WEED;

/**
 * Runs sync LiquidFun.queryAABB + rayCast once particles exist.
 */
export class LiquidFunQueryProbe extends GameObject {
  static components = [RigidBody, Collider];

  onSpawned({ x = 0, y = 0, expectedMin = 10 } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = 0;
    this.rigidBody.static = true;
    this.collider.radius = 1;
    this.rigidBody.syncMassFromCollider();
    this._expectedMin = expectedMin | 0;
    this._queried = false;
    this._out = new Int32Array(256);
  }

  tick() {
    if (this._queried) return;
    const views = LiquidFun.getViews();
    const n = views?.count ? views.count[0] | 0 : 0;
    if (n < this._expectedMin) return;

    try {
      const half = 200;
      const aabbCount = LiquidFun.queryAABB(
        this.x - half,
        this.y - half,
        this.x + half,
        this.y + half,
        this._out,
      );
      const rayCount = LiquidFun.rayCast(
        this.x - 300,
        this.y,
        this.x + 300,
        this.y,
        this._out,
      );
      if (aabbCount < this._expectedMin) return;

      this._queried = true;
      const ok = aabbCount >= this._expectedMin && rayCount >= 0;
      console.log(
        `[LiquidFunQueryProbe] aabb=${aabbCount} ray=${rayCount} particles=${n} ok=${ok}`,
      );
      this.sendMessageToScene({
        type: 'liquidFunQuerySelfCheck',
        ok,
        aabbCount,
        rayCount,
        particles: n,
      });
    } catch (err) {
      if (!String(err && err.message).includes('not bound')) {
        console.error('[LiquidFunQueryProbe]', err);
        this._queried = true;
      }
    }
  }
}
