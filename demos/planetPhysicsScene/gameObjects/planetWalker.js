// Walks the sphere. Box2D world gravity is zero; this tick is the pull.

import { CX, CY, G } from '../planetGravity.js';
import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, LightEmitter, Keyboard, Camera, enums } = WEED;
const { ShapeType } = enums;

const RADIUS = 16;
const SPEED = 260;
const JUMP = 420;

export class PlanetWalker extends GameObject {
  static serializable = true;
  static components = [RigidBody, Collider, SpriteRenderer, LightEmitter];
  static forceProcessOnLogicWorker = 0;

  onSpawned(spawnConfig = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = RADIUS;
    this.collider.friction = 0.8;
    this.collider.visualRange = 400;
    this.rigidBody.linearDamping = 0.05;
    this.setSprite('square');
    this.setAnchor(0.5, 0.5);
    this.setScale(3.2, 4.8);
    this.setTint(0xffcc33);
    this.lightEmitter.lightColor = 0xffe8c0;
    this.lightEmitter.lightIntensity = 2800;
    this.lightEmitter.height = 0;
    this.lightEmitter.glowHeightOffset = 10;
    this.lightEmitter.active = 1;
    this.lightEmitter.hasGlowSprite = 0.5;
    this.x = spawnConfig.x ?? CX;
    this.y = spawnConfig.y ?? CY;
    this._jump = 0;
    this.cam = spawnConfig._saveRestore ? (Camera.rotation || 0) : 0;
    this.setVelocity(0, 0);
  }

  tick(dtRatio) {
    const dt = dtRatio > 0 ? dtRatio / 60 : 0;
    const i = this.index;
    const dx = CX - this.x;
    const dy = CY - this.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const tx = -uy;
    const ty = ux;
    let side = 0;
    if (Keyboard.isDown('d') || Keyboard.isDown('arrowright')) side -= 1;
    if (Keyboard.isDown('a') || Keyboard.isDown('arrowleft')) side += 1;
    const vx = RigidBody.vx[i];
    const vy = RigidBody.vy[i];
    const inward = vx * ux + vy * uy;
    this.setVelocity(ux * inward + tx * side * SPEED, uy * inward + ty * side * SPEED);
    RigidBody.ax[i] = ux * G;
    RigidBody.ay[i] = uy * G;
    this.angularVelocity = 0;
    if (this._jump > 0) this._jump -= dt;
    const jump = Keyboard.isDown('w') || Keyboard.isDown(' ') || Keyboard.isDown('arrowup');
    if (jump && this._jump <= 0) {
      this.addVelocity(-ux * JUMP, -uy * JUMP);
      this._jump = 0.45;
    }
    const outX = -ux;
    const outY = -uy;
    const a = Math.atan2(outY, outX);
    this.rotation = a + Math.PI / 2;
    const target = -Math.PI / 2 - a;
    let diff = target - this.cam;
    diff = ((diff + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    this.cam += diff * (1 - Math.exp(-dt * 12));
    this.setScale((side < 0 ? -1 : 1) * 3.2, 4.8);
    Camera.setAngle(this.cam);
    Camera.followEntity(i, 0, 0.15, dtRatio);
  }
}
