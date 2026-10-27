import WEED from '/src/index.js';
import { Platform } from './platform.js';
import { PlatformerCharacterComponent } from '../components/platformerCharacterComponent.js';

const { LightEmitter, GameObject, AdobeAnimComponent, ParticleEmitter, AdobeAnimRegistry, RigidBody, Collider, Keyboard, Gamepad, CollisionListener, Transform } = WEED;

export class BluePlatformerPlayer extends GameObject {
  static components = [PlatformerCharacterComponent, AdobeAnimComponent, RigidBody, Collider, LightEmitter, CollisionListener];
  static assetName = 'blue_character';

  // What a level file (levels/*.scene.json: its Player, where it starts) and the editor set for the player:
  // onSpawned gets every one, the default filled in when the file leaves it out. A level places it, so a save
  // does not keep it (not serializable).
  static spawnParams = {
    // One-shot kick: addVelocity, not an acceleration burst (whose height
    // depended on how many physics steps ran before the next tick).
    jumpSpeed: { value: 1333, min: 200, max: 4000, step: 1, tip: 'px/s: what the old -80000 px/s² burst gave on one 60 Hz step' },
    moveAcceleration: { value: 3800, min: 100, max: 20000, step: 10, tip: 'px/s² while left or right is held' },
    scale: { value: 0.35, min: 0.05, max: 2, step: 0.01, tip: 'The character’s size' },
    radius: { value: 30, min: 4, max: 200, step: 1, tip: 'Its collider’s radius, px' },
    friction: { value: 0.2, min: 0, max: 2, step: 0.01 },
    linearDamping: { value: 0.5, min: 0, max: 10, step: 0.05, tip: 'How fast it slows down by itself' },
    lightIntensity: { value: 3000, min: 0, max: 30000, step: 100, tip: 'The light it carries' },
  };
  static stickThreshold = 0.35; // left stick past this counts as left/right
  static stickJumpThreshold = 0.6; // stick pushed up this far jumps, like the up arrow
  static clips = Object.freeze({
    idle: 'idle',
    running: 'running',
    jumping: 'jumping',
  });

  onCollisionEnter(other) {
    if (!GameObject.is(other, Platform)) return;
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
      // layer: 'bloom',
    });
  }

  onCollisionExit(other) {
    if (other == this.platformerCharacterComponent.isItStandingOnPlatform) {
      this.platformerCharacterComponent.isItStandingOnPlatform = -1;
    }
  }

  onCollisionStay(other) {
    if (!GameObject.is(other, Platform)) return;
    // Refresh ground contact — Exit can fire on sleep without a matching Enter later
    if (Transform.y[other] > this.y) {
      this.platformerCharacterComponent.isItStandingOnPlatform = other;
    }
  }

  onSpawned(params) {
    // What each tick reads.
    this.jumpSpeed = params.jumpSpeed;
    this.moveAcceleration = params.moveAcceleration;
    this.spriteScale = params.scale;

    this.rigidBody.static = 0;
    this.rigidBody.linearDamping = params.linearDamping;

    this.collider.radius = params.radius;
    this.collider.friction = params.friction;
    this.collider.visualRange = 120;
    this.setFixedRotation(1);
    this.platformerCharacterComponent.isItStandingOnPlatform = -1

    this.lightEmitter.lightColor = 0xffffff;
    this.lightEmitter.lightIntensity = params.lightIntensity;
    this.lightEmitter.height = 0;
    this.lightEmitter.active = 1;
    this.lightEmitter.hasGlowSprite = 0.5;

    this.x = params.x;
    this.y = params.y;
    this.setVelocity(0, 0);
    this.jumpWasDown = false;

    const defaultClip = this._resolveClipName(BluePlatformerPlayer.clips.idle, BluePlatformerPlayer.clips.running);

    this.adobeAnimComponent.setAsset(BluePlatformerPlayer.assetName, defaultClip, {
      loop: true,
      scaleX: params.scale,
      scaleY: params.scale,
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

    if (this.rigidBody.vx > 0) this.adobeAnimComponent.scaleX = this.spriteScale;
    else this.adobeAnimComponent.scaleX = -this.spriteScale;
    this.adobeAnimComponent.scaleY = this.spriteScale;
  }

  tick(dtRatio) {
    const amIOnAPlatform = this.platformerCharacterComponent.isItStandingOnPlatform > -1
    const ratioOfSideMovement = amIOnAPlatform ? 1 : 0.3
    const stickX = Gamepad.leftX;
    const left = Keyboard.isDown('a') || Keyboard.isDown('arrowleft')
      || Gamepad.isLeftDown || stickX < -BluePlatformerPlayer.stickThreshold;
    const right = Keyboard.isDown('d') || Keyboard.isDown('arrowright')
      || Gamepad.isRightDown || stickX > BluePlatformerPlayer.stickThreshold;
    const jumpHeld = Keyboard.isDown('w') || Keyboard.isDown('arrowup') || Keyboard.isDown(' ')
      || Gamepad.isADown || Gamepad.isUpDown || Gamepad.leftY < -BluePlatformerPlayer.stickJumpThreshold;

    // console.log(left, right, jumpHeld);

    if (left) this.addAcceleration(-this.moveAcceleration * ratioOfSideMovement, 0);
    if (right) this.addAcceleration(this.moveAcceleration * ratioOfSideMovement, 0);
    if (jumpHeld && this.rigidBody.vy == 0 && this.platformerCharacterComponent.isItStandingOnPlatform > -1) {
      this.addVelocity(0, -this.jumpSpeed);
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
        // layer: 'bloom',
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
      // layer: 'bloom',
    });

  }
}
