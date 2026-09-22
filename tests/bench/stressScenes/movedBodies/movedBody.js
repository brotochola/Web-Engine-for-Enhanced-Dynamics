import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer } = WEED;

/**
 * Stress body. Static stays out of the Box2D move list.
 * Dynamic writes x every tick so it is a teleport mover every step.
 */
export class MovedBody extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer];

  onSpawned({
    x = 0,
    y = 0,
    dynamic = false,
    visualRange = 0,
    radius = 10,
    vx = 3,
    minX = 0,
    maxX = 1000,
    solver = false,
  } = {}) {
    this.x = x;
    this.y = y;
    this.rotation = 0;
    this.rigidBody.static = dynamic ? 0 : 1;
    this.rigidBody.linearDamping = 0;
    this.rigidBody.fixedRotation = 1;
    if (solver) {
      this.rigidBody.vx = vx;
      this.rigidBody.vy = vx * 0.5;
    }
    this.collider.radius = radius;
    this.collider.visualRange = visualRange;
    this.setSprite('ball');
    this.setScale((radius * 2) / 14);
    this.setAnchor(0.5, 0.5);
    this._dynamic = dynamic && !solver ? 1 : 0;
    this._vx = vx;
    this._minX = minX;
    this._maxX = maxX;
  }
}

/** Mixed scene: teleport every tick so the mover list stays a fixed fraction. */
export class MovedTicker extends MovedBody {
  onSpawned(spawnConfig = {}) {
    super.onSpawned(spawnConfig);
    this._dynamic = spawnConfig.dynamic ? 1 : 0;
  }

  tick() {
    if (!this._dynamic) return;
    let x = this.x + this._vx;
    if (x > this._maxX) x = this._minX;
    else if (x < this._minX) x = this._maxX;
    this.x = x;
  }
}
