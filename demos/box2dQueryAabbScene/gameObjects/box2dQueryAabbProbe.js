import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, Box2d, enums } = WEED;
const { ShapeType } = enums;

/**
 * Static box for Box2dQueryAabbScene self-check.
 */
export class Box2dQueryAabbTarget extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [RigidBody, Collider, SpriteRenderer];

  onSpawned({ x = 0, y = 0, size = 40 } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = 0;
    this.rigidBody.static = true;
    this.collider.shapeType = ShapeType.Box;
    this.collider.width = size;
    this.collider.height = size;
    this.rigidBody.syncMassFromCollider();
    this.setSprite('box');
    this.setScale(size / 100);
    this.setAnchor(0.5, 0.5);
  }

  tick() {}
}

/**
 * Runs one sync Box2d.queryAABB and asserts known targets are found.
 * ponytail: smallest runnable check for QueryAABB gameplay API.
 */
export class Box2dQueryAabbProbe extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [RigidBody, Collider];

  onSpawned({ x = 0, y = 0, expectedMin = 3 } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = 0;
    this.rigidBody.static = true;
    this.collider.radius = 1;
    this.rigidBody.syncMassFromCollider();
    this._expectedMin = expectedMin | 0;
    this._queried = false;
    this._out = new Int32Array(64);
  }

  tick() {
    if (this._queried) return;

    try {
      const half = 120;
      const count = Box2d.queryAABB(
        this.x - half,
        this.y - half,
        this.x + half,
        this.y + half,
        this._out,
      );

      let foundSelf = false;
      for (let i = 0; i < Math.min(count, this._out.length); i++) {
        if (this._out[i] === this.index) foundSelf = true;
      }

      // Bodies may not exist on the first frame — retry until hits appear.
      if (count < this._expectedMin) return;

      this._queried = true;
      const ok = foundSelf;
      console.log(
        `[Box2dQueryAabbProbe] count=${count} foundSelf=${foundSelf} ok=${ok}`,
      );
      if (!ok) {
        console.error(
          `[Box2dQueryAabbProbe] FAIL expectedMin=${this._expectedMin} count=${count} foundSelf=${foundSelf}`,
        );
      }
      this.sendMessageToScene({
        type: 'box2dQueryAabbSelfCheck',
        ok,
        count,
        foundSelf,
      });
    } catch (err) {
      // SAB not bound yet (pre-box2dReady) — retry next tick.
      if (!String(err && err.message).includes('not bound')) {
        console.error('[Box2dQueryAabbProbe]', err);
        this._queried = true;
      }
    }
  }
}
