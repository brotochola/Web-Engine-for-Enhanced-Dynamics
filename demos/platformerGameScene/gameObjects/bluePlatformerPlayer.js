import WEED from '/src/index.js';
import { Platform } from './platform.js';
import { PlatformerCharacterComponent } from '../components/platformerCharacterComponent.js';

const { LightEmitter, GameObject, AdobeAnimComponent, ParticleEmitter, AdobeAnimRegistry, RigidBody, Collider, Keyboard, CollisionListener, Transform } = WEED;

export class BluePlatformerPlayer extends GameObject {
  static serializable = true;
  static scriptUrl = import.meta.url;
  static components = [PlatformerCharacterComponent, AdobeAnimComponent, RigidBody, Collider, LightEmitter, CollisionListener];
  static assetName = 'blue_character';

  static jumpImpulse = -80000; // px/s² burst
  static moveAcceleration = 1800; // px/s²
  static scale = 0.35;
  static clips = Object.freeze({
    idle: 'idle',
    running: 'running',
    jumping: 'jumping',
  });

  setup() {
    this.rigidBody.static = 0;
    this.rigidBody.linearDamping = 0.001;

    this.collider.radius = 30;
    this.collider.visualRange = 120;
    this.setFixedRotation(1);

  }
  onCollisionEnter(other) {
    if (Transform.entityType[other] != Platform.entityType) return;
    this.vx *= 0.5;

    if (Transform.y[other] > this.y) {
      this.platformerCharacterComponent.isItStandingOnPlatform = other;
    }

    this.emitPArticles();
  }

  emitPArticles() {
    ParticleEmitter.emitFlat({
      count: Math.floor(this.rigidBody.speed / 60),
      x: this.x,
      y: this.y,
      texture: '_whiteCircle',
      alpha: { from: { min: 0.25, max: 0.5 }, to: 0 },
      scale: { min: 0.66, max: 2 },
      lifespan: { min: 100, max: 500 },
      angleXY: { min: -180, max: 180 },
      speed: { min: 3, max: 5 },
      layer: 'bloom',
    });
  }

  onCollisionExit(other) {
    if (other == this.platformerCharacterComponent.isItStandingOnPlatform) {
      this.platformerCharacterComponent.isItStandingOnPlatform = -1;
    }
  }

  onCollisionStay(other) {
    if (Transform.entityType[other] != Platform.entityType) return;
    // Refresh ground contact — Exit can fire on sleep without a matching Enter later
    if (Transform.y[other] > this.y) {
      this.platformerCharacterComponent.isItStandingOnPlatform = other;
    }
  }

  onSpawned(spawnConfig = {}) {
    this.platformerCharacterComponent.isItStandingOnPlatform = -1

    this.lightEmitter.lightColor = 0xffffff;
    this.lightEmitter.lightIntensity = 30000;
    this.lightEmitter.height = 0;
    this.lightEmitter.active = 1;
    this.lightEmitter.hasGlowSprite = 1;

    this.x = spawnConfig.x ?? 100;
    this.y = spawnConfig.y ?? 100;
    this.setVelocity(0, 0);
    this.jumpWasDown = false;

    const defaultClip =
      spawnConfig.clipName ??
      this._resolveClipName(BluePlatformerPlayer.clips.idle, BluePlatformerPlayer.clips.running);

    this.adobeAnimComponent.setAsset(BluePlatformerPlayer.assetName, defaultClip, {
      loop: true,
      scaleX: spawnConfig.scaleX ?? BluePlatformerPlayer.scale,
      scaleY: spawnConfig.scaleY ?? BluePlatformerPlayer.scale,
      anchorX: 0.5,
      anchorY: 0.73,
      alpha: 1,
      tint: 0xffffff,
    });
  }

  _resolveClipName(...candidates) {
    const assetId = AdobeAnimRegistry.getAssetId(BluePlatformerPlayer.assetName);
    if (!assetId) return candidates[0] || null;

    for (let i = 0; i < candidates.length; i++) {
      const name = candidates[i];
      if (!name) continue;
      const clipId = AdobeAnimRegistry.getClipId(assetId, name);
      if (clipId !== 0) return name;
    }
    return candidates[0] || null;
  }
  changeAnimation() {
    if (Math.abs(this.rigidBody.vy) > 0.1) {
      if (this.adobeAnimComponent.clipName != BluePlatformerPlayer.clips.running) {
        this.adobeAnimComponent.play(BluePlatformerPlayer.clips.running, false);
      }
      this.adobeAnimComponent.playbackRate = 0.1
      this.emitPArticlesAsJump()

    } else {
      this.adobeAnimComponent.playbackRate = this.rigidBody.speed / 300 + 0.2
      if (Math.abs(this.rigidBody.vx) > 6) {
        if (this.adobeAnimComponent.clipName != BluePlatformerPlayer.clips.running) {
          this.adobeAnimComponent.play(BluePlatformerPlayer.clips.running, true);
        }
      } else {
        if (this.adobeAnimComponent.clipName != BluePlatformerPlayer.clips.idle) {
          this.adobeAnimComponent.play(BluePlatformerPlayer.clips.idle, true);
        }
      }
    }

    if (this.rigidBody.vx > 0) this.adobeAnimComponent.scaleX = BluePlatformerPlayer.scale;
    else this.adobeAnimComponent.scaleX = -BluePlatformerPlayer.scale;
    this.adobeAnimComponent.scaleY = BluePlatformerPlayer.scale;
  }

  tick(dtRatio) {
    const amIOnAPlatform = this.platformerCharacterComponent.isItStandingOnPlatform > -1
    const ratioOfSideMovement = amIOnAPlatform ? 1 : 0.3
    const left = Keyboard.isDown('a') || Keyboard.isDown('arrowleft');
    const right = Keyboard.isDown('d') || Keyboard.isDown('arrowright');
    const jumpHeld = Keyboard.isDown('w') || Keyboard.isDown('arrowup') || Keyboard.isDown(' ');

    // console.log(left, right, jumpHeld);

    if (left) this.addAcceleration(-BluePlatformerPlayer.moveAcceleration * ratioOfSideMovement, 0);
    if (right) this.addAcceleration(BluePlatformerPlayer.moveAcceleration * ratioOfSideMovement, 0);
    if (jumpHeld && this.rigidBody.vy == 0 && this.rigidBody.ay == 0 && this.platformerCharacterComponent.isItStandingOnPlatform > -1) {
      this.addAcceleration(0, BluePlatformerPlayer.jumpImpulse);
    }

    if (Math.abs(this.rigidBody.vx) < 3) {
      this.vx = 0
    }
    if (Math.abs(this.rigidBody.vy) < 0.05) {
      this.vy = 0
    }

    this.changeAnimation();

    this.emitPArticlesAsIWalk()
  }

  emitPArticlesAsIWalk() {
    if (this.platformerCharacterComponent.isItStandingOnPlatform > -1 && Math.abs(this.vx) > 0) {
      const randomOffset = rng() * 2 - 1
      ParticleEmitter.emitFlat({
        count: rng() * 3,
        x: this.x,
        y: this.y + randomOffset * 10 + 10,
        texture: '_whiteCircle',
        alpha: { from: { min: 0.05, max: 0.15 }, to: 0 },
        scale: { min: 1, max: 2.3 },
        lifespan: 300,
        angleXY: randomOffset,
        speed: { min: 0, max: -this.vx * 0.01 },
        layer: 'bloom',
      });
    }
  }

  emitPArticlesAsJump() {

    ParticleEmitter.emitFlat({
      count: rng() * 3,
      x: this.x,
      y: this.y,
      texture: '_whiteCircle',
      alpha: { from: { min: 0.25, max: 0.5 }, to: 0 },
      scale: { min: 0.66, max: 2 },
      lifespan: 300,
      angleXY: 0,
      speed: 0,
      layer: 'bloom',
    });

  }
}
