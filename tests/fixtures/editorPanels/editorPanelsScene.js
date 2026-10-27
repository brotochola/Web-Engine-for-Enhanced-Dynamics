// The editor's panels in Chromium (VISUAL_EDITOR_PLAN.md ED-24, ED-26, ED-45; tests/bench/editorPanelsSmoke.mjs): a
// level (level.scene.json) of crates on the entities layer and walkers on a `props` layer of the scene's own, over a
// Tiled tilemap drawn on a `ground` layer. A crate's look is a `sprite` param and a walker's an `animation` param,
// over the scene's textures and the civil1 spritesheet. The smoke writes the tilemap's file (__ground.tilemap.json)
// before it loads the level, and removes it after.
import WEED from '/src/index.js';

const { Scene, GameObject, SpriteRenderer, Camera, LAYER_KIND } = WEED;

export class Crate extends GameObject {
  static components = [SpriteRenderer];

  static spawnParams = {
    sprite: { value: 'barrel', type: 'sprite', tip: 'Any texture the scene loaded' },
    size: { value: 1, min: 0.25, max: 4, step: 0.25 },
  };

  onSpawned(params) {
    this.setSprite(params.sprite);
    this.setScale(params.size);
    this.x = params.x;
    this.y = params.y;
  }
}

export class Walker extends GameObject {
  static components = [SpriteRenderer];

  static spawnParams = {
    anim: { value: 'walk_down', type: 'animation', tip: 'An animation of civil1' },
  };

  onSpawned(params) {
    this.setSpritesheet('civil1');
    this.setAnimation(params.anim);
    this.setLayer('props');
    this.x = params.x;
    this.y = params.y;
  }
}

export class EditorPanelsScene extends Scene {
  static config = {
    worldWidth: 1536,
    worldHeight: 960,
    seed: 1,
    logic: { numberOfLogicWorkers: 1 },
    particle: { maxParticles: 0, decals: false },
    physics: { enabled: false },
    renderer: { backend: 'webgl' },
    lighting: { enabled: false },
    layers: {
      ground: { kind: LAYER_KIND.TILEMAP, tilemap: 'ground', zIndex: 0 },
      props: { zIndex: 3.5, maxItems: 64 },
    },
  };

  static assets = {
    textures: {
      barrel: '/demos/img/barrel1.png',
      bunny: '/demos/img/bunny.png',
    },
    spritesheets: {
      civil1: { json: '/demos/img/civil1.json', png: '/demos/img/civil1.png' },
    },
    tilemaps: {
      ground: { json: '/tests/fixtures/editorPanels/__ground.tilemap.json', png: '/demos/img/tilemap/2.png' },
    },
  };

  static entities = [
    [Crate, 16],
    [Walker, 16],
  ];

  create() {
    Camera.centerOn(768, 480);
  }
}
