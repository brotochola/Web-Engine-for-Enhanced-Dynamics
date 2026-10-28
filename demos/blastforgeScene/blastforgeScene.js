// blastforgeScene.js – Blastforge's pixel-art explosions as a Weed.js scene.
//
// Click the ground (or press Space) to set off the preset picked in the panel. Trees, rocks, barrels and crates
// stand on the ground, y-sorted; each blast's fire and smoke is sorted among them (the field layer's
// sortWithEntities), so whatever stands in front of a blast hides it.
//
// Who does what:
//   - The panel (main thread, blastforgePanel.js) writes its choices into BlastSettings.
//   - Detonator runs on a logic worker. It reads the mouse, the keyboard and BlastSettings in tick() and calls
//     explode(). FrameGuide keeps the LPC frame under the mouse while the panel shows it.
//   - The vertex shader moves the fire, smoke, dust and embers (GPU particles), the particle worker moves the
//     sparks and debris, and the renderer draws the explosion layers (see explosions.js).

import WEED from '/src/index.js';
import { FIELD_LAYER, explode, explosionAssets, explosionLayers, setExplosionPalette, updateExplosions } from './explosions.js';
import { PRESETS } from './explosionPresets.js';
import { BlastTuning, tunedPreset } from './blastTuning.js';
import { GROUND_LAYER, ScorchMap, groundAssets, groundLayer, scorchSchema } from './blastGround.js';

const { Scene, GameObject, SpriteRenderer, SharedResource, Mouse, Keyboard, Camera, Layer } = WEED;

const WORLD_WIDTH = 2048;
const WORLD_HEIGHT = 1536;
/** Camera zoom. Every world pixel is drawn as PIXEL_ZOOM × PIXEL_ZOOM screen pixels. */
const PIXEL_ZOOM = 3;
const AUTO_BLAST_EVERY_MS = { min: 1100, max: 2400 };
/** The LPC frame guide's layer, over everything. */
const GUIDE_LAYER = 'guide';
/** Props on the ground, by weight. Each is a texture in textures/, standing on its bottom edge. */
const PROP_KINDS = [['tree', 7], ['bush', 5], ['rock', 4], ['barrel', 2], ['crate', 2]];
/** One prop at most per cell of this size (px), in a third of the cells. */
const PROP_CELL = { w: 96, h: 80 };

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
    guide: Uint8Array, // 1 = the LPC frame guide follows the mouse
  };
}

/** A tree, bush, rock, barrel or crate, y-sorted by its foot. */
export class Prop extends GameObject {
  static components = [SpriteRenderer];

  onSpawned({ x = 0, y = 0, kind = 'rock' } = {}) {
    this.x = x;
    this.y = y;
    this.setSprite(kind);
    this.setAnchor(0.5, 1);
  }
}

/** A 64×64 LPC character frame at the mouse, as the lab draws it: what a blast looks like next to a character. */
export class FrameGuide extends GameObject {
  static components = [SpriteRenderer];

  onSpawned() {
    this.setSprite('lpcFrame');
    this.setAnchor(0, 0);
    this.setLayer(GUIDE_LAYER);
    this.visible = false;
  }

  tick() {
    const shown = BlastSettings.guide[0] === 1 && Mouse.isPresent;
    this.visible = shown;
    if (!shown) return;
    this.x = Math.floor(Mouse.x) - 32;
    this.y = Math.floor(Mouse.y) - 32;
  }
}

/** Turns clicks, Space and the auto-detonate switch into explosions. */
export class Detonator extends GameObject {
  static components = [];

  onSpawned() {
    this.shownPreset = -1; // the preset last picked in the panel
    this.tuning = -1; // the BlastTuning generation this.preset was built from
    this.preset = PRESET_LIST[0]; // the picked preset, as tuned in the panel
    this.palette = null; // the palette the field layer has
    this.untilAutoBlastMs = 0;
  }

  tick(dtRatio, deltaTime) {
    const presetIndex = BlastSettings.preset[0];
    const generation = Atomics.load(BlastTuning.generation, 0);
    if (presetIndex !== this.shownPreset || generation !== this.tuning) {
      // The preset as tuned in the panel: rebuilt when the panel writes, never per blast.
      this.tuning = generation;
      this.preset = tunedPreset(presetIndex, PRESET_LIST[presetIndex] ?? PRESET_LIST[0]);
      if (this.preset.palette !== this.palette) {
        this.palette = this.preset.palette;
        setExplosionPalette(this.palette);
      }
      // A newly picked preset goes off once in the middle of the view.
      if (presetIndex !== this.shownPreset) {
        this.shownPreset = presetIndex;
        this.detonate(this.preset, Camera.centerX, Camera.centerY);
      }
    }
    const preset = this.preset;

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
    // The look shaders are GLSL. Nearest sampling keeps textures as hard pixels. The y-sort orders the props, and
    // the blasts among them.
    renderer: { backend: 'webgl', atlasScaleMode: 'nearest', ySort: true },
    particle: {
      maxParticles: 20000, // sparks and debris; fire, smoke, dust and embers are GPU particles
      decals: true, // landed debris (the ground keeps the scorch marks: blastGround.js)
      decalsResolution: 1, // one decal texel per world pixel
    },
    layers: {
      [GROUND_LAYER]: groundLayer({ worldWidth: WORLD_WIDTH, worldHeight: WORLD_HEIGHT }),
      ...explosionLayers({ pixelZoom: PIXEL_ZOOM, palette: PRESET_LIST[0].palette }),
      [GUIDE_LAYER]: { zIndex: 5, maxItems: 1, ySorting: false },
    },
  };

  static entities = [
    [Detonator, 1],
    [Prop, 220],
    [FrameGuide, 1],
  ];

  static sharedResources = [
    [BlastSettings, BlastSettings.schema],
    [BlastTuning, BlastTuning.schema],
    [ScorchMap, scorchSchema(WORLD_WIDTH, WORLD_HEIGHT)],
  ];

  static assets = {
    textures: {
      ...Object.fromEntries(PROP_KINDS.map(([kind]) => [kind, `/demos/blastforgeScene/textures/${kind}.png`])),
      ...explosionAssets.textures,
      lpcFrame: '/demos/blastforgeScene/textures/lpcFrame.png',
    },
    shaders: { ...explosionAssets.shaders, ...groundAssets.shaders },
  };

  async create() {
    BlastSettings.preset[0] = 0;
    BlastSettings.size[0] = 1;
    BlastSettings.amount[0] = 1;
    BlastSettings.wind[0] = 0;
    BlastSettings.autoDetonate[0] = 0;
    BlastSettings.guide[0] = 0;

    Camera.setZoom(PIXEL_ZOOM);
    Camera.centerOn(WORLD_WIDTH / 2, WORLD_HEIGHT / 2);

    // The panel is DOM: main thread only, so it is loaded here rather than imported by the workers.
    const { buildBlastPanel } = await import('./blastforgePanel.js');
    this._removePanel = buildBlastPanel({
      presets: PRESET_LIST,
      settings: BlastSettings,
      fieldLayer: Layer.get(FIELD_LAYER),
      ground: Layer.get(GROUND_LAYER),
      scorch: ScorchMap,
    });
  }

  createNewGame() {
    Detonator.spawn();
    FrameGuide.spawn();
    spawnProps();
  }

  async destroy() {
    if (this._removePanel) this._removePanel();
    this._removePanel = null;
    await super.destroy();
  }
}

/**
 * Props in a third of the cells of a grid, jittered, the same every time (a fixed seed). Two stand by the middle of
 * the view, where the first blast goes off: a tree just in front of it and one behind.
 */
function spawnProps() {
  let seed = 0x1b1a57;
  const next = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const total = PROP_KINDS.reduce((sum, [, weight]) => sum + weight, 0);
  const pick = () => {
    let r = next() * total;
    for (const [kind, weight] of PROP_KINDS) if ((r -= weight) < 0) return kind;
    return PROP_KINDS[0][0];
  };
  const cx = WORLD_WIDTH / 2;
  const cy = WORLD_HEIGHT / 2;
  Prop.spawn({ x: cx + 14, y: cy + 26, kind: 'tree' });
  Prop.spawn({ x: cx - 30, y: cy - 22, kind: 'tree' });
  for (let y = PROP_CELL.h / 2; y < WORLD_HEIGHT; y += PROP_CELL.h) {
    for (let x = PROP_CELL.w / 2; x < WORLD_WIDTH; x += PROP_CELL.w) {
      if (next() > 0.33) continue;
      const px = x + (next() - 0.5) * PROP_CELL.w * 0.7;
      const py = y + (next() - 0.5) * PROP_CELL.h * 0.7;
      if (Math.abs(px - cx) < 90 && Math.abs(py - cy) < 70) continue; // keep the first blast's spot clear
      Prop.spawn({ x: px, y: py, kind: pick() });
    }
  }
}

function randomBetween({ min, max }) {
  return min + Math.random() * (max - min);
}
