import WEED from '/src/index.js';
import { LAYER_ROCKET, MASK_ROCKET, ROCKET_H, ROCKET_LEN, ROCKET_THRUST } from '../utils/badPiggiesGrid.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, ParticleEmitter, Keyboard, enums } = WEED;
const { ShapeType } = enums;

export class MachineRocket extends GameObject {
  static instances = [];
  static serializable = true;
  static components = [RigidBody, Collider, SpriteRenderer];

  setup() {
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.5;
  }

  onSpawned(spawnConfig = {}) {
    const ghost = !!spawnConfig.ghost;
    const width = spawnConfig.width ?? ROCKET_LEN;
    const height = spawnConfig.height ?? ROCKET_H;

    this.x = spawnConfig.x ?? this.x;
    this.y = spawnConfig.y ?? this.y;
    this.rotation = spawnConfig.rotation ?? -Math.PI / 2;

    this.collider.shapeType = ShapeType.Box;
    this.collider.width = width;
    this.collider.height = height;
    this.collider.radius = 0;
    this.collider.isTrigger = ghost ? 1 : 0;
    this.collider.friction = 0.4;
    this.collider.visualRange = Math.hypot(width, height) * 0.5 + 200;
    this.collider.collisionLayer = LAYER_ROCKET;
    this.collider.collisionMask = ghost ? 0 : MASK_ROCKET;

    this.rigidBody.static = 1;
    this.rigidBody.linearDamping = 0.05;
    this.rigidBody.angularDamping = 0.05;
    this.rigidBody.angularVelocity = 0;
    this.rigidBody.sleeping = 0;

    this.setSprite('_white');
    const origW = this.spriteRenderer.originalWidth || 8;
    const origH = this.spriteRenderer.originalHeight || origW;
    this.setScale(width / origW, height / origH);
    this.setTint(0xffffff);
    this.setAlpha(ghost ? 0.4 : 1);
  }

  tick() {
    if (this.rigidBody.static) return;
    if (!Keyboard.arrowup) return;

    const c = Math.cos(this.rotation);
    const s = Math.sin(this.rotation);
    this.addAcceleration(c * ROCKET_THRUST, s * ROCKET_THRUST);

    const nx = -c;
    const ny = -s;
    const tailX = this.x + nx * (ROCKET_LEN);
    const tailY = this.y + ny * (ROCKET_LEN);

    ParticleEmitter.emitFlat({
      count: { min: 1, max: 5 },
      x: tailX,
      y: tailY,
      dirX: nx,
      dirY: ny,
      spread: 0.1,
      speed: { min: 20, max: 60 },
      gravity: 0.66,
      lifespan: { min: 100, max: 300 },
      scale: { min: 0.5, max: 1 },
      texture: '_metaball',
      tint: { min: 0xffee66, max: 0xff6600 },
      alpha: { from: 0.5, to: 0 },
      layer: 'fire',
    });

    ParticleEmitter.emitFlat({
      count: 1,
      x: tailX,
      y: tailY,
      spread: { min: 100, max: 360 },
      speed: { min: 1, max: 5 },
      gravity: -0.05,
      lifespan: { min: 1000, max: 5900 },
      scale: { from: { min: 0.2, max: 1 }, to: 5 },
      texture: 'smoke',
      tint: { min: 0x666666, max: 0xbbbbbb },
      alpha: { from: { min: 0.1, max: 0.25 }, to: 0 },
      rotation: { from: { min: 0, max: 360 }, to: { min: 0, max: 360 } },
      layer: 'smoke',
    });
  }
}
