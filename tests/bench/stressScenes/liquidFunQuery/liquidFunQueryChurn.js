import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, LiquidFun } = WEED;

/**
 * Per-tick sync LiquidFun.queryAABB + rayCast (logic worker).
 * Also one-shot self-check once particles exist.
 */
export class LiquidFunQueryChurn extends GameObject {
  static components = [RigidBody, Collider];

  onSpawned({ x = 0, y = 0 } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = 0;
    this.rigidBody.static = true;
    this.collider.radius = 1;
    this.rigidBody.syncMassFromCollider();
    this._out = new Int32Array(512);
    this._checked = false;
    this._t = 0;
  }

  tick() {
    this._t += 1;
    const cx = this.x;
    const cy = this.y;
    const half = 120 + (this._t % 40);
    try {
      LiquidFun.queryAABB(cx - half, cy - half, cx + half, cy + half, this._out);
      LiquidFun.rayCast(cx - 400, cy, cx + 400, cy + 80, this._out);
    } catch (err) {
      if (!String(err && err.message).includes('not bound')) {
        console.error('[LiquidFunQueryChurn]', err);
      }
      return;
    }

    if (this._checked) return;
    const views = LiquidFun.getViews();
    const n = views?.count ? views.count[0] | 0 : 0;
    if (n < 100) return;

    const count = LiquidFun.queryAABB(cx - 200, cy - 200, cx + 200, cy + 200, this._out);
    this._checked = true;
    const ok = count > 0;
    console.log(`[LiquidFunQueryChurn] self-check count=${count} particles=${n} ok=${ok}`);
    this.sendMessageToScene({
      type: 'liquidFunQuerySelfCheck',
      ok,
      count,
      particles: n,
    });
  }
}
