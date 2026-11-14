import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, CollisionListener, enums } = WEED;
const { ShapeType } = enums;

/** One body of the pile: a ball or a wall, set up the same for both classes below. */
function setUpContactDrainBody(body, {
  x = 0,
  y = 0,
  radius = 10,
  width = 24,
  height = 24,
  shape = 'circle',
  isStatic = false,
} = {}) {
  body.x = x;
  body.y = y;
  body.rotation = 0;
  body.rigidBody.static = isStatic ? 1 : 0;
  body.rigidBody.linearDamping = 0.05;
  body._hits = 0;
  body._stays = 0;
  body._exits = 0;

  if (shape === 'box') {
    body.collider.shapeType = ShapeType.Box;
    body.collider.width = width;
    body.collider.height = height;
    body.setScale(Math.max(width, height) / 14);
  } else {
    body.collider.shapeType = ShapeType.Circle;
    body.collider.radius = radius;
    body.setScale((radius * 2) / 14);
  }
  body.collider.visualRange = 0;
  body.collider.collisionLayer = 0;
  body.setSprite('ball');
  body.setAnchor(0.5, 0.5);
  body.setAlpha(isStatic ? 0.9 : 0.7);
}

/** Dynamic or static collider with CollisionListener so logic drains the contact ring. */
export class ContactDrainBody extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer, CollisionListener];

  onSpawned(opts) {
    setUpContactDrainBody(this, opts);
  }

  onCollisionEnter() {
    this._hits++;
  }

  onCollisionStay() {
    this._stays++;
  }

  onCollisionExit() {
    this._exits++;
  }
}

/** The same body without onCollisionStay (?stay=0): the logic worker walks no pairs for stay (E-302). */
export class ContactDrainBodyNoStay extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer, CollisionListener];

  onSpawned(opts) {
    setUpContactDrainBody(this, opts);
  }

  onCollisionEnter() {
    this._hits++;
  }

  onCollisionExit() {
    this._exits++;
  }
}
