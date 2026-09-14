import WEED from '/src/index.js';
import { CELL, LAYER_BOX, MASK_BOX } from '../utils/badPiggiesGrid.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, enums } = WEED;
const { ShapeType } = enums;

const BOX_TEX = 100;

export class MachineBox extends GameObject {
  static scriptUrl = import.meta.url;
  static instances = [];
  static serializable = true;
  static components = [RigidBody, Collider, SpriteRenderer];

  setup() {
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.5;
  }

  onSpawned(spawnConfig = {}) {
    const ghost = !!spawnConfig.ghost;
    const size = spawnConfig.size ?? CELL;

    this.x = spawnConfig.x ?? this.x;
    this.y = spawnConfig.y ?? this.y;
    this.rotation = 0;

    this.collider.shapeType = ShapeType.Box;
    this.collider.width = size //* 1.1;
    this.collider.height = size //* 1.1;
    this.collider.radius = 0;
    this.collider.isTrigger = ghost ? 1 : 0;
    this.collider.friction = 1;
    this.collider.visualRange = Math.hypot(size, size) * 0.5 + 200;
    this.collider.collisionLayer = LAYER_BOX;
    this.collider.collisionMask = ghost ? 0 : MASK_BOX;

    this.rigidBody.static = 1;
    this.rigidBody.linearDamping = 0.05;
    this.rigidBody.angularDamping = 0.05;
    this.rigidBody.angularVelocity = 0;
    this.rigidBody.sleeping = 0;

    this.setSprite(spawnConfig.sprite || 'box');
    this.setScale(size / BOX_TEX, size / BOX_TEX);
    this.setTint(spawnConfig.tint ?? 0xc8a06a);
    this.setAlpha(ghost ? 0.4 : 1);
  }

  tick() { }
}
