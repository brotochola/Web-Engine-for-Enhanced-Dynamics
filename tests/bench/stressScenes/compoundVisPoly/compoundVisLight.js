import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, LightEmitter, enums } = WEED;
const { ShapeType } = enums;

const WORLD_W = 2400;
const WORLD_H = 2400;

export class CompoundVisLight extends GameObject {
  static components = [RigidBody, Collider, LightEmitter];

  onSpawned({ x = 0, y = 0, vx = 0, vy = 0 } = {}) {
    this.x = x;
    this.y = y;
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 6;
    this.collider.visualRange = 2200;
    this.rigidBody.static = 0;
    this.rigidBody.linearDamping = 0;
    this.rigidBody.angularDamping = 0;
    this.lightEmitter.lightColor = 0xfff2d0;
    this.lightEmitter.lightIntensity = 22500;
    this.lightEmitter.height = 0;
    this.lightEmitter.active = 1;
    this.lightEmitter.hasGlowSprite = 0;
    this.setVelocity(vx, vy);
    this.setAwake(true);
  }

  tick() {
    const i = this.index;
    let vx = RigidBody.vx[i];
    let vy = RigidBody.vy[i];
    if ((this.x < 200 && vx < 0) || (this.x > WORLD_W - 200 && vx > 0)) vx = -vx;
    if ((this.y < 200 && vy < 0) || (this.y > WORLD_H - 200 && vy > 0)) vy = -vy;
    RigidBody.vx[i] = vx;
    RigidBody.vy[i] = vy;
  }
}
