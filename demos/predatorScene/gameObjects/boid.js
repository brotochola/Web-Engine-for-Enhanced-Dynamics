// Boid.js - Classic flocking (cohesion / separation / alignment)

import WEED from '/src/index.js';
import { enqueueSetRotCS } from '/src/box2d/box2dCommandRing.js';

const { enums, GameObject, RigidBody, Collider, SpriteRenderer, Mouse, Transform } = WEED;
const { ShapeType } = enums;
class Boid extends GameObject {
  static deriveSpeed = true;

  static turnFactor = 2;
  static tickInterval = 30;
  static protectedRangeSq = 75 * 75
  static centeringFactor = 1;
  static avoidFactor = 18;
  static matchingFactor = 2;
  static margin = 20;
  static mouseAvoidRangeSq = 250 * 250;
  static mouseAvoidStrength = 1000;
  static faceSpeedMin = 8;
  static maxNeighbors = 32;

  static components = [RigidBody, Collider, SpriteRenderer];

  onSpawned(spawnConfig = {}) {
    this.rigidBody.linearDamping = 0.01;
    this.collider.active = false;
    this.collider.width = 10;
    this.collider.height = 10;
    this.collider.visualRange = 100;
    this.collider.collisionMask = 0;
    this.collider.shapeType = ShapeType.Box

    this.spriteRenderer.scaleX = 1;
    this.spriteRenderer.scaleY = 1;
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.5;
    const config = this.config || {};

    this.x = spawnConfig.x ?? rng() * (config.worldWidth || 800);
    this.y = spawnConfig.y ?? rng() * (config.worldHeight || 600);
    this.transform.rotation = 0;

    this.rigidBody.vx = spawnConfig.vx ?? 0;
    this.rigidBody.vy = spawnConfig.vy ?? 0;
    this.rigidBody.ax = 0;
    this.rigidBody.ay = 0;

    this.setFixedRotation(1);
    this.setSprite(spawnConfig.sprite ?? 'square');
  }

  tick(_dtRatio, deltaTime) {
    const i = this.index;
    const tX = Transform.x;
    const tY = Transform.y;
    const rbVX = RigidBody.vx;
    const rbVY = RigidBody.vy;

    const myX = tX[i];
    const myY = tY[i];
    const protectedRangeSq = Boid.protectedRangeSq;

    let centerX = 0;
    let centerY = 0;
    let avgVX = 0;
    let avgVY = 0;
    let separateX = 0;
    let separateY = 0;
    let flockCount = 0;

    const neighborCount = this.neighborCount;
    const nMax = neighborCount//neighborCount < Boid.maxNeighbors ? neighborCount : Boid.maxNeighbors;

    for (let n = 0; n < nMax; n++) {
      const j = this.getNeighbor(n);
      const dx = tX[j] - myX;
      const dy = tY[j] - myY;
      const dist2 = dx * dx + dy * dy;

      if (dist2 < protectedRangeSq && dist2 > 1) {
        const strength = (protectedRangeSq - dist2) / protectedRangeSq;
        separateX -= (dx / dist2) * strength;
        separateY -= (dy / dist2) * strength;
        continue;
      }

      centerX += tX[j];
      centerY += tY[j];
      avgVX += rbVX[j];
      avgVY += rbVY[j];
      flockCount++;
    }

    let ax = separateX * Boid.avoidFactor;
    let ay = separateY * Boid.avoidFactor;

    if (flockCount > 0) {
      const inv = 1 / flockCount;
      centerX *= inv;
      centerY *= inv;
      ax += (centerX - myX) * Boid.centeringFactor;
      ay += (centerY - myY) * Boid.centeringFactor;
      ax += (avgVX * inv - rbVX[i]) * Boid.matchingFactor;
      ay += (avgVY * inv - rbVY[i]) * Boid.matchingFactor;
    }

    if (Mouse.isDown && Mouse.isPresent) {
      const mdx = Mouse.x - myX;
      const mdy = Mouse.y - myY;
      const mDist2 = mdx * mdx + mdy * mdy;
      if (mDist2 < Boid.mouseAvoidRangeSq && mDist2 > 1) {
        const mStr = Boid.mouseAvoidStrength / mDist2;
        ax -= mdx * mStr;
        ay -= mdy * mStr;
      }
    }

    const worldWidth = this.config.worldWidth || 800;
    const worldHeight = this.config.worldHeight || 600;
    const frameMs = deltaTime > 0 ? deltaTime : 16.67;
    const t = (frameMs * Boid.tickInterval) / 1000;
    let vx = rbVX[i];
    let vy = rbVY[i];
    let x = myX;
    let y = myY;
    const reachX = Math.abs(vx) * t + Math.abs(ax) * t * t + Boid.margin;
    const reachY = Math.abs(vy) * t + Math.abs(ay) * t * t + Boid.margin;
    const peel = Boid.turnFactor;
    let pos = false;
    let vel = false;

    if (vx < 0 && x <= reachX) {
      vx = peel;
      vel = true;
      if (ax < 0) ax = 0;
      if (x < 0) {
        x = 0;
        pos = true;
      }
    } else if (vx > 0 && x >= worldWidth - reachX) {
      vx = -peel;
      vel = true;
      if (ax > 0) ax = 0;
      if (x > worldWidth) {
        x = worldWidth;
        pos = true;
      }
    }

    if (vy < 0 && y <= reachY) {
      vy = peel;
      vel = true;
      if (ay < 0) ay = 0;
      if (y < 0) {
        y = 0;
        pos = true;
      }
    } else if (vy > 0 && y >= worldHeight - reachY) {
      vy = -peel;
      vel = true;
      if (ay > 0) ay = 0;
      if (y > worldHeight) {
        y = worldHeight;
        pos = true;
      }
    }

    if (pos) this.setPosition(x, y);
    if (vel) this.setVelocity(vx, vy);

    if (ax !== 0 || ay !== 0) this.addAcceleration(ax, ay);

    const speed = RigidBody.speed[i];
    if (speed > Boid.faceSpeedMin) {
      const inv = 1 / speed;
      enqueueSetRotCS(i, rbVX[i] * inv, rbVY[i] * inv);
    }
  }
}

export { Boid };
