// blastforgeScene.js – Blastforge's pixel-art explosions as a Weed.js scene.
//
// Click the ground (or press Space) to set off the preset picked in the panel.
//
// Who does what:
//   - The panel (main thread, blastforgePanel.js) writes its choices into BlastSettings.
//   - Detonator, the only entity, runs on a logic worker. It reads the mouse, the keyboard and BlastSettings in
//     tick() and calls explode().
//   - The particle worker moves the particles, and the renderer draws the explosion layers (see explosions.js).

import WEED from '/src/index.js';
import { FIELD_LAYER, explode, explosionAssets, explosionLayers, setExplosionPalette, updateExplosions } from './explosions.js';
import { PRESETS } from './explosionPresets.js';

const { Scene, GameObject, SharedResource, Mouse, Keyboard, Camera, Layer, LAYER_KIND } = WEED;

const WORLD_WIDTH = 2048;
const WORLD_HEIGHT = 1536;
/** Camera zoom. Every world pixel is drawn as PIXEL_ZOOM × PIXEL_ZOOM screen pixels. */
const PIXEL_ZOOM = 3;
const AUTO_BLAST_EVERY_MS = { min: 1100, max: 2400 };

/** Presets in panel order. BlastSettings.preset holds an index into this list. */
export const PRESET_LIST = Object.values(PRESETS);

/**
 * The panel's choices. One writer: the panel, on the main thread.
 * Readers: Detonator, on a logic worker.
 */
export class BlastSettings extends SharedResource {
  static schema = {
    preset: Uint8Array, // index into PRESET_LIST
    size: Float32Array, // scales the whole blast
    amount: Float32Array, // scales the number of puffs
    wind: Float32Array, // px/s, + pushes right
    autoDetonate: Uint8Array, // 1 = random blasts around the view
  };
}

/** Turns clicks, Space and the auto-detonate switch into explosions. */
export class Detonator extends GameObject {
  static components = [];

  onSpawned() {
    this.shownPreset = -1; // the preset whose palette the field layer has
    this.untilAutoBlastMs = 0;
  }

  tick(dtRatio, deltaTime) {
    const presetIndex = BlastSettings.preset[0];
    const preset = PRESET_LIST[presetIndex] ?? PRESET_LIST[0];

    // A newly picked preset recolors the field layer and goes off once in the middle of the view.
    if (presetIndex !== this.shownPreset) {
      this.shownPreset = presetIndex;
      setExplosionPalette(preset.palette);
      this.detonate(preset, Camera.centerX, Camera.centerY);
    }

    if (Mouse.isButton0Pressed) this.detonate(preset, Mouse.x, Mouse.y);
    if (Keyboard.isPressed('space')) {
      const x = Mouse.isPresent ? Mouse.x : Camera.centerX;
      const y = Mouse.isPresent ? Mouse.y : Camera.centerY;
      this.detonate(preset, x, y);
    }

    if (BlastSettings.autoDetonate[0]) {
      this.untilAutoBlastMs -= deltaTime;
      if (this.untilAutoBlastMs <= 0) {
        this.untilAutoBlastMs = randomBetween(AUTO_BLAST_EVERY_MS);
        const view = Camera.getViewportBounds();
        const margin = Math.min(view.width, view.height) * 0.2;
        this.detonate(
          preset,
          view.left + margin + Math.random() * (view.width - 2 * margin),
          view.top + margin + Math.random() * (view.height - 2 * margin)
        );
      }
    }

    // Smoke, embers, follow-up blasts and ground flames that start later.
    updateExplosions(deltaTime);
  }

  detonate(preset, x, y) {
    explode(x, y, preset, {
      size: BlastSettings.size[0],
      amount: BlastSettings.amount[0],
      wind: BlastSettings.wind[0],
    });
  }
}

export class BlastforgeScene extends Scene {
  static config = {
    worldWidth: WORLD_WIDTH,
    worldHeight: WORLD_HEIGHT,
    // Nothing here collides, so the scene runs without Box2D: no physics worker, no WASM.
    physics: { enabled: false },
    // The look shaders are GLSL. Nearest sampling keeps textures as hard pixels.
    renderer: { backend: 'webgl', atlasScaleMode: 'nearest' },
    particle: {
      maxParticles: 60000, // pool indices are Uint16, so the pool stays under 65536
      decals: true, // scorch marks and landed debris
      decalsResolution: 1, // one decal texel per world pixel
    },
    layers: {
      ground: { kind: LAYER_KIND.TILING, texture: 'ground', zIndex: 0 },
      ...explosionLayers({ pixelZoom: PIXEL_ZOOM, palette: PRESET_LIST[0].palette }),
    },
  };

  static entities = [[Detonator, 1]];

  static sharedResources = [[BlastSettings, BlastSettings.schema]];

  static assets = {
    textures: {
      ground: '/demos/blastforgeScene/textures/ground.png',
      ...explosionAssets.textures,
    },
    shaders: explosionAssets.shaders,
  };

  async create() {
    BlastSettings.preset[0] = 0;
    BlastSettings.size[0] = 1;
    BlastSettings.amount[0] = 1;
    BlastSettings.wind[0] = 0;
    BlastSettings.autoDetonate[0] = 0;

    Camera.setZoom(PIXEL_ZOOM);
    Camera.centerOn(WORLD_WIDTH / 2, WORLD_HEIGHT / 2);

    // The panel is DOM: main thread only, so it is loaded here rather than imported by the workers.
    const { buildBlastPanel } = await import('./blastforgePanel.js');
    this._removePanel = buildBlastPanel({ presets: PRESET_LIST, settings: BlastSettings, fieldLayer: Layer.get(FIELD_LAYER) });
  }

  createNewGame() {
    Detonator.spawn();
  }

  async destroy() {
    if (this._removePanel) this._removePanel();
    this._removePanel = null;
    await super.destroy();
  }
}

function randomBetween({ min, max }) {
  return min + Math.random() * (max - min);
}
