// Digger — A/D walk, W/up jetpack, LMB laser, F place lamp.

import WEED from '/src/index.js';
import { flushMamushkaDeferred, sleepFarMamushkaBoxes, MamushkaBox } from './mamushkaBox.js';
import { Lamp } from './lamp.js';

const {
  GameObject,
  AdobeAnimComponent,
  AdobeAnimRegistry,
  RigidBody,
  Collider,
  LightEmitter,
  Keyboard,
  CollisionListener,
  Mouse,
  Ray,
  ParticleEmitter,
  Transform,
} = WEED;

const MOVE_ACCEL = 1800;
const AIR_CONTROL = 0.35;
const JETPACK_ACCEL = -3600;
const SCALE = 0.35;
const BODY_RADIUS = 30;
const LASER_COOLDOWN_MS = 30;
const LASER_RANGE = 10000;
const LASER_DAMAGE = 0.5;
const HELMET_INTENSITY = 3000;
const ASSET = 'blue_character';
const CLIPS = Object.freeze({
  idle: 'idle',
  running: 'running',
  jumping: 'jumping',
});

export class Digger extends GameObject {
  static components = [
    AdobeAnimComponent,
    RigidBody,
    Collider,
    CollisionListener,
    LightEmitter,
  ];

  setup() {
    this.rigidBody.static = 0;
    this.rigidBody.linearDamping = 0.12;
    this.collider.radius = BODY_RADIUS;
    this.collider.visualRange = 700;
    this.collider.friction = 0.5
    this.setFixedRotation(1);
    this.lightEmitter.lightColor = 0xffe8c0;
    this.lightEmitter.lightIntensity = HELMET_INTENSITY;
    this.lightEmitter.height = 0;
    this.lightEmitter.glowHeightOffset = 10;
    this.lightEmitter.active = 1;
    this.lightEmitter.hasGlowSprite = 1;
    this._grounded = 0;
    this._lastFireAt = 0;
    this._laserArmed = 0;
    this._lampsCarried = 0;
    this._placeLockUntil = 0;
    this._now = 0;
  }

  onSpawned(spawnConfig = {}) {
    this._grounded = 0;
    this._lastFireAt = 0;
    this._laserArmed = Mouse.isButton0Down ? 0 : 1;
    this._lampsCarried = spawnConfig.lamps != null ? spawnConfig.lamps | 0 : 0;
    this._placeLockUntil = 0;
    this._now = 0;
    this.x = spawnConfig.x ?? 100;
    this.y = spawnConfig.y ?? 100;
    this.setVelocity(0, 0);
    this.lightEmitter.active = 1;
    this.lightEmitter.lightIntensity = HELMET_INTENSITY;

    const clip = this._resolveClip(CLIPS.idle, CLIPS.running);
    this.adobeAnimComponent.setAsset(ASSET, clip, {
      loop: true,
      scaleX: spawnConfig.scaleX ?? SCALE,
      scaleY: spawnConfig.scaleY ?? SCALE,
      anchorX: 0.5,
      anchorY: 0.73,
      alpha: 1,
      tint: 0xffffff,
    });
  }

  onCollisionEnter(other) {
    if (Transform.entityType[other] === Lamp.entityType) {
      this._pickLamp(other);
      return;
    }
    if (Transform.y[other] > this.y) this._grounded = 1;
  }

  onCollisionStay(other) {
    if (Transform.entityType[other] === Lamp.entityType) return;
    if (Transform.y[other] > this.y) this._grounded = 1;
  }

  onCollisionExit(_other) {
    this._grounded = 0;
  }

  _pickLamp(entityIndex) {
    if ((this._now || 0) < this._placeLockUntil) return;
    const lamp = GameObject.get(entityIndex);
    if (!lamp || !lamp.active) return;
    lamp.despawn();
    this._lampsCarried++;
  }

  _tryPlaceLamp(accumulatedTime) {
    if (!Keyboard.isPressed('f')) return;
    if ((this._lampsCarried | 0) <= 0) return;
    const now = accumulatedTime || 0;
    if (now < this._placeLockUntil) return;
    this._lampsCarried--;
    this._placeLockUntil = now + 250;
    const face = (this.adobeAnimComponent.scaleX || SCALE) >= 0 ? 1 : -1;
    Lamp.spawn({
      x: this.x + face * (BODY_RADIUS + 18),
      y: this.y + BODY_RADIUS * 0.4,
    });
  }

  _resolveClip(...candidates) {
    const assetId = AdobeAnimRegistry.getAssetId(ASSET);
    if (!assetId) return candidates[0] || null;
    for (let i = 0; i < candidates.length; i++) {
      const name = candidates[i];
      if (!name) continue;
      if (AdobeAnimRegistry.getClipId(assetId, name) !== 0) return name;
    }
    return candidates[0] || null;
  }

  _faceAndAnim(jetting) {
    const vx = this.rigidBody.vx || 0;
    const moving = Math.abs(vx) > 6;
    if (jetting) {
      if (this.adobeAnimComponent.clipName !== CLIPS.jumping) {
        this.adobeAnimComponent.play(CLIPS.jumping, true);
      }
      this.adobeAnimComponent.playbackRate = 0.15;
    } else if (moving) {
      if (this.adobeAnimComponent.clipName !== CLIPS.running) {
        this.adobeAnimComponent.play(CLIPS.running, true);
      }
      this.adobeAnimComponent.playbackRate = Math.abs(vx) / 300 + 0.2;
    } else if (this.adobeAnimComponent.clipName !== CLIPS.idle) {
      this.adobeAnimComponent.play(CLIPS.idle, true);
      this.adobeAnimComponent.playbackRate = 0.2;
    }
    this.adobeAnimComponent.scaleX = vx >= 0 ? SCALE : -SCALE;
    this.adobeAnimComponent.scaleY = SCALE;
  }

  _emitJetpack() {
    ParticleEmitter.emitFlat({
      count: { min: 6, max: 12 },
      x: this.x,
      y: this.y + BODY_RADIUS * 0.7,
      dirX: 0,
      dirY: 1,
      spread: 0.22,
      speed: { min: 22, max: 58 },
      gravity: 0.45,
      lifespan: { min: 120, max: 320 },
      scale: { min: 0.55, max: 1.35 },
      texture: '_whiteCircle',
      tint: { min: 0xffeeaa, max: 0xff3300 },
      alpha: { min: 0.7, max: 1 },
      layer: 'fx',
    });
    ParticleEmitter.emitFlat({
      count: { min: 2, max: 5 },
      x: this.x,
      y: this.y + BODY_RADIUS * 0.9,
      spread: { min: 80, max: 280 },
      speed: { min: 1, max: 7 },
      gravity: -0.15,
      lifespan: { min: 360, max: 900 },
      scale: { min: 1.0, max: 2.4 },
      texture: '_whiteCircle',
      tint: { min: 0x555555, max: 0xbbbbbb },
      alpha: { from: { min: 0.1, max: 0.26 }, to: 0 },
      layer: 'fx',
    });
  }

  _fireLaser(accumulatedTime) {
    if (!this._laserArmed) {
      if (!Mouse.isButton0Down) this._laserArmed = 1;
      return;
    }
    if (!Mouse.isButton0Down) return;
    const now = accumulatedTime || 0;
    if (now - this._lastFireAt < LASER_COOLDOWN_MS) return;
    this._lastFireAt = now;

    const mouseX = Mouse.x;
    const mouseY = Mouse.y;
    const aimDx = mouseX - this.x;
    const aimDy = mouseY - this.y;
    const aimLenSq = aimDx * aimDx + aimDy * aimDy;
    if (aimLenSq < 1) return;
    const invAimLen = 1 / Math.sqrt(aimLenSq);
    const dirX = aimDx * invAimLen;
    const dirY = aimDy * invAimLen;
    const muzzleX = this.x + dirX * (BODY_RADIUS + 2);
    const muzzleY = this.y + dirY * (BODY_RADIUS + 2);

    const hit = Ray.castWithInfo(
      muzzleX,
      muzzleY,
      muzzleX + dirX * LASER_RANGE,
      muzzleY + dirY * LASER_RANGE,
      LASER_RANGE
    );
    const hitX = hit.hit ? hit.hitX : muzzleX + dirX * LASER_RANGE;
    const hitY = hit.hit ? hit.hitY : muzzleY + dirY * LASER_RANGE;
    const beamDist = hit.hit ? hit.distance : LASER_RANGE;
    const numberOfParticles = beamDist > 150 ? 150 : beamDist / 10;

    ParticleEmitter.emitAlongLine({
      x0: muzzleX,
      y0: muzzleY,
      x1: hitX,
      y1: hitY,
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

    if (hit.hit) {
      ParticleEmitter.emitFlat({
        count: { min: 4, max: 8 },
        x: hitX,
        y: hitY,
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

    if (!hit.hit || hit.entityIndex < 0) return;
    if (Transform.entityType[hit.entityIndex] !== MamushkaBox.entityType) return;
    const box = GameObject.get(hit.entityIndex);
    if (box && box.active) box.takeHit(LASER_DAMAGE);
  }

  tick(_dtRatio, _deltaTime, accumulatedTime) {
    flushMamushkaDeferred();
    sleepFarMamushkaBoxes(this.x, this.y);
    this._now = accumulatedTime || 0;
    this._tryPlaceLamp(this._now);

    const left = Keyboard.isDown('a') || Keyboard.isDown('arrowleft');
    const right = Keyboard.isDown('d') || Keyboard.isDown('arrowright');
    const jet = Keyboard.isDown('w') || Keyboard.isDown('arrowup');
    const side = this._grounded ? 1 : AIR_CONTROL;

    if (left) this.addAcceleration(-MOVE_ACCEL * side, 0);
    if (right) this.addAcceleration(MOVE_ACCEL * side, 0);
    if (jet) {
      this.addAcceleration(0, JETPACK_ACCEL);
      this._emitJetpack();
    }

    this._faceAndAnim(jet);
    this._fireLaser(accumulatedTime);
    this._grounded = 0;
  }
}
