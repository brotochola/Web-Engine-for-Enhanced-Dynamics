import WEED from '/src/index.js';

const { GameObject, Keyboard, RigidBody, Collider, SpriteRenderer, Camera, Transform } = WEED;

const HALF_W = 11;
const HALF_H = 14;
const THRUST_ACCEL = 3100;
const LOOK_AHEAD = 0.2;
const CAM_SMOOTH = 0.12;

export class Ship extends GameObject {
  static scriptUrl = import.meta.url;
  static serializable = false;
  static instances = [];
  static components = [RigidBody, Collider, SpriteRenderer];

  setup() {
    this.collider.visualRange = 80;
  }

  onSpawned(spawnConfig = {}) {
    this.collider.width = HALF_W * 2;
    this.collider.height = HALF_H * 2;
    this.collider.radius = 0;
    this.collider.friction = 0.4;
    this.collider.restitution = 0.05;
    this.rigidBody.static = 0;
    this.rigidBody.linearDamping = 0.35;
    this.rigidBody.angularDamping = 5;
    this.setFixedRotation(1);

    this.setSprite('_white');
    this.setAnchor(0.5, 0.5);
    this.setTint(0x48bb78);
    this.setAlpha(1);
    const orig = this.spriteRenderer.originalWidth || 8;
    this.setScale((HALF_W * 2) / orig, (HALF_H * 2) / orig);
  }

  tick(dtRatio) {

    if (Keyboard.w) this.addAcceleration(0, -THRUST_ACCEL);

    if (Keyboard.a) this.addAcceleration(-THRUST_ACCEL * 0.25, 0);

    if (Keyboard.d) this.addAcceleration(THRUST_ACCEL * 0.25, 0);

    const worldH = this.config.worldHeight;
    const worldW = this.config.worldWidth;
    if (this.y > worldH + 160) {
      this.x = worldW * 0.5;
      this.y = Math.max(HALF_H + 8, worldH * 0.72);
      this.vx = 0;
      this.vy = 0;
      this.angularVelocity = 0;
    }

    Camera.targetZoom = 0.9;
    Camera.followEntity(this.index, LOOK_AHEAD, CAM_SMOOTH, dtRatio);
  }

}
