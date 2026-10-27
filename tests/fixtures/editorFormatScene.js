// The scene file's joints and decorations in Chromium (VISUAL_EDITOR_PLAN.md ED-21, ED-25;
// tests/bench/editorFormatSmoke.mjs): blocks with bodies that the file joins, and a decoration class the brush
// paints. No gravity, so what the file places stays where it is until something pushes it.
import WEED from '/src/index.js';

const { Scene, GameObject, RigidBody, Collider, SpriteRenderer, enums } = WEED;
const { ShapeType } = enums;

export class FormatBlock extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer];
  static spawnParams = {
    size: { value: 60, min: 8, max: 400, step: 1 },
    fixed: { value: false, tip: 'A static body' },
  };

  onSpawned(params) {
    const size = params.size;
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.5;
    this.collider.shapeType = ShapeType.Box;
    this.collider.width = size;
    this.collider.height = size;
    this.collider.visualRange = size + 100;
    this.rigidBody.static = params.fixed ? 1 : 0;
    this.rigidBody.linearDamping = 0;
    this.rigidBody.angularDamping = 0;
    this.setSprite('box');
    this.setScale(size / 100, size / 100);
  }
}

export class EditorFormatScene extends Scene {
  static config = {
    worldWidth: 2000,
    worldHeight: 1500,
    seed: 1,
    logic: { numberOfLogicWorkers: 1 },
    particle: { maxParticles: 0, decals: false },
    decoration: { maxDecorations: 512 },
    physics: { maxJoints: 16, gravity: { x: 0, y: 0 }, sleeping: false },
    renderer: { backend: 'webgl' },
    lighting: { enabled: false },
  };

  static assets = {
    textures: { box: '/demos/img/box_100_100.png' },
  };

  static entities = [[FormatBlock, 16]];

  static decorations = {
    Pebble: { texture: 'box', scale: { min: 0.08, max: 0.16 }, anchorY: 0.5, tint: { min: 0x777777, max: 0xbbbbbb } },
  };
}
