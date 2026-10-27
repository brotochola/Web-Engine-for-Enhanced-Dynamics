// The editor's handles and entity pick in Chromium (VISUAL_EDITOR_PLAN.md ED-20, ED-22, ED-27, ED-45;
// tests/bench/editorHandlesSmoke.mjs), loaded from editorHandles.scene.json: a class for each kind of handle, sized by
// spawn params named like its component's columns, and a Door sized in code (its handles dimmed). The Guard walks a
// route (a points param, in world coordinates) and names a Door (an entity param).
import WEED from '/src/index.js';

const { Scene, GameObject, Collider, SpriteRenderer, LightEmitter, enums } = WEED;
const { ShapeType } = enums;

/** A white sprite of that size, to see and click. */
function paint(entity, w, h, tint) {
  entity.setSprite('_white');
  entity.setScale(w / 8, h / 8);
  entity.setAnchor(0.5, 0.5);
  entity.setTint(tint);
}

export class Block extends GameObject {
  static components = [Collider, SpriteRenderer];
  static spawnParams = {
    width: { value: 160, min: 8, max: 2000, step: 1 },
    height: { value: 40, min: 8, max: 2000, step: 1 },
  };

  onSpawned(params) {
    this.collider.shapeType = ShapeType.Box;
    this.collider.radius = 0;
    this.collider.width = params.width;
    this.collider.height = params.height;
    paint(this, params.width, params.height, 0x4f7cac);
  }
}

export class Ball extends GameObject {
  static components = [Collider, SpriteRenderer];
  static spawnParams = { radius: { value: 30, min: 4, max: 500, step: 1 } };

  onSpawned(params) {
    this.collider.radius = params.radius;
    paint(this, params.radius * 2, params.radius * 2, 0xc0504d);
  }
}

export class Rock extends GameObject {
  static components = [Collider, SpriteRenderer];
  static spawnParams = {
    points: { value: [0, -40, 40, 30, -40, 30], type: 'points', tip: 'Its polygon, about its position' },
  };

  onSpawned(params) {
    if (!this.collider.makePolygon(params.points)) {
      this.collider.width = 40;
      this.collider.height = 40;
    }
    paint(this, this.collider.width, this.collider.height, 0x9bbb59);
  }
}

export class Lamp extends GameObject {
  static components = [SpriteRenderer, LightEmitter];
  static spawnParams = { lightIntensity: { value: 2500, min: 0, max: 1000000, step: 1 } };

  onSpawned(params) {
    this.lightEmitter.lightIntensity = params.lightIntensity;
    paint(this, 24, 24, 0xffd966);
  }
}

export class Door extends GameObject {
  static components = [Collider, SpriteRenderer];

  onSpawned() {
    this.collider.width = 40;
    this.collider.height = 80;
    paint(this, 40, 80, 0x8064a2);
  }
}

export class Guard extends GameObject {
  static components = [SpriteRenderer];
  static spawnParams = {
    route: { value: null, type: 'points', tip: 'The x, y pairs it walks' },
    door: { value: null, type: 'entity', class: 'Door', tip: 'The door it opens' },
  };

  onSpawned() {
    paint(this, 24, 40, 0xf79646);
  }
}

export class EditorHandlesScene extends Scene {
  static config = {
    worldWidth: 2000,
    worldHeight: 1400,
    seed: 1,
    spatial: { numberOfSpatialWorkers: 0 },
    logic: { numberOfLogicWorkers: 1 },
    particle: { maxParticles: 0, decals: false },
    physics: { enabled: false },
    renderer: { backend: 'webgl' },
    lighting: { enabled: false },
  };

  static entities = [
    [Block, 8],
    [Ball, 8],
    [Rock, 8],
    [Lamp, 8],
    [Door, 8],
    [Guard, 8],
  ];
}
