import { Floor } from '/demos/ballsScene/gameObjects/floor.js';
import { TerrainIsland } from './terrainIsland.js';
import { WorldGrid, RAY_MASK_NO_STATIC, TUNE, SHOT_KIND_GRID, SHOT_KIND_BODY } from '../worldGrid.js';
import WEED from '/src/index.js';

const {
  GameObject,
  Keyboard,
  Mouse,
  RigidBody,
  Collider,
  SpriteRenderer,
  Camera,
  Transform,
  Ray,
  ParticleEmitter,
} = WEED;

const HALF_W = 11;
const HALF_H = 14;
const THRUST_ACCEL = 3100;
const LOOK_AHEAD = 0;
const CAM_SMOOTH = 0.12;
const MUZZLE_PAD = Math.hypot(HALF_W, HALF_H) + 4;

export class Ship extends GameObject {
  static scriptUrl = import.meta.url;
  static serializable = false;
  static instances = [];
  static components = [RigidBody, Collider, SpriteRenderer];
  static forceProcessOnLogicWorker = 0;

  static noHit = { hit: false, distance: Infinity, hitX: 0, hitY: 0, entityIndex: -1 };

  setup() {
    this.collider.visualRange = 80;
    this._lastFireAt = 0;
    this._laserOn = 0;
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
    this._lastFireAt = 0;
    this._laserOn = 0;
  }

  tick(dtRatio, _deltaTime, accumulatedTime) {
    if (Keyboard.w) this.addAcceleration(0, -THRUST_ACCEL);
    if (Keyboard.a) this.addAcceleration(-THRUST_ACCEL * 0.25, 0);
    if (Keyboard.d) this.addAcceleration(THRUST_ACCEL * 0.25, 0);

    if (Keyboard.isPressed('c')) this._laserOn = 1;
    if (Keyboard.isPressed('z') || Keyboard.isPressed('x') || Keyboard.isPressed('v')) this._laserOn = 0;

    const worldH = this.config.worldHeight;
    const worldW = this.config.worldWidth;
    if (this.y > worldH + 160) {
      this.x = worldW * 0.5;
      this.y = Math.max(HALF_H + 8, worldH * 0.72);
      this.vx = 0;
      this.vy = 0;
      this.angularVelocity = 0;
    }

    if (
      this._laserOn &&
      !Mouse.isDebugToolActive &&
      WorldGrid.tuneGet(TUNE.UI_BLOCK) < 0.5 &&
      Mouse.isButton0Down
    ) {
      const now = accumulatedTime || 0;
      if (now - this._lastFireAt >= WorldGrid.tuneGet(TUNE.SHOT_COOLDOWN)) {
        this._lastFireAt = now;
        this._tryShoot();
      }
    }

    Camera.targetZoom = 0.9;
    Camera.followEntity(this.index, LOOK_AHEAD, CAM_SMOOTH, dtRatio);
  }

  _tryShoot() {
    const dx = Mouse.x - this.x;
    const dy = Mouse.y - this.y;
    const distSq = dx * dx + dy * dy;
    if (distSq < 1e-12) return;
    const inv = 1 / Math.sqrt(distSq);
    const ux = dx * inv;
    const uy = dy * inv;
    const ox = this.x + ux * MUZZLE_PAD;
    const oy = this.y + uy * MUZZLE_PAD;
    const rayLen = Math.max(this.config.worldWidth, this.config.worldHeight) * 1.5;

    const gridHit = WorldGrid.castRay(ox, oy, ux, uy, rayLen);
    const bodyMax = gridHit.hit ? gridHit.distance : rayLen;
    const bodyHit = bodyMax > 1e-6
      ? Ray.castWithInfo(
        ox, oy, ox + ux * bodyMax, oy + uy * bodyMax, bodyMax, RAY_MASK_NO_STATIC, null, this.index
      )
      : Ship.noHit;
    const useGrid = gridHit.hit && (!bodyHit.hit || gridHit.distance <= bodyHit.distance);
    const useBody = bodyHit.hit && !useGrid;
    const hx = useGrid ? gridHit.x : useBody ? bodyHit.hitX : ox + ux * rayLen;
    const hy = useGrid ? gridHit.y : useBody ? bodyHit.hitY : oy + uy * rayLen;

    this._emitLaser(ox, oy, hx, hy, useGrid || useBody);
    if (useGrid) {
      WorldGrid.pushHit(SHOT_KIND_GRID, hx, hy, -1, -1);
      return;
    }
    if (!useBody) return;

    const type = Transform.entityType ? Transform.entityType[bodyHit.entityIndex] : -1;
    if (type === Floor.entityType || type !== TerrainIsland.entityType) return;
    WorldGrid.pushHit(
      SHOT_KIND_BODY,
      bodyHit.hitX,
      bodyHit.hitY,
      bodyHit.entityIndex,
      bodyHit.fixtureIndex == null ? -1 : bodyHit.fixtureIndex,
    );
  }

  _emitLaser(ox, oy, hx, hy, didHit) {
    const beamDist = Math.hypot(hx - ox, hy - oy);
    const numberOfParticles = beamDist > 150 ? 150 : beamDist / 10;
    ParticleEmitter.emitAlongLine({
      x0: ox,
      y0: oy,
      x1: hx,
      y1: hy,
      vx: { min: -0.5, max: 0.5 },
      vy: { min: -0.5, max: 0.5 },
      count: numberOfParticles,
      texture: '_whiteCircle',
      gravity: -0.1,
      lifespan: { min: 150, max: 320 },
      scale: { from: { min: 1.0, max: 1.4 }, to: { min: 1.5, max: 2 } },
      tint: { min: 0x7ef9ff, max: 0xddffff },
      alpha: { from: { min: 0.55, max: 0.95 }, to: 0 },
      layer: 'fx',
    });
    if (!didHit) return;
    ParticleEmitter.emitFlat({
      count: { min: 4, max: 8 },
      x: hx,
      y: hy,
      angleXY: { min: 0, max: 360 },
      speed: { min: 2, max: 8 },
      gravity: 0.15,
      lifespan: { min: 70, max: 160 },
      scale: { min: 1, max: 2.2 },
      texture: '_whiteCircle',
      tint: { min: 0xaaffff, max: 0xffffff },
      alpha: { from: { min: 0.5, max: 0.95 }, to: 0 },
      layer: 'fx',
    });
  }
}
