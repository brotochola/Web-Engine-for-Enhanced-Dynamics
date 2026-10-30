// landingScene.js – WeedJS's home page (index.html at the repo root, served by GitHub Pages): a tour of the engine in
// six chapters along one landscape, one screen wide each (chapters.js). The wheel, the arrow keys and the page's dots
// move between them, and the time of day follows the camera. The landscape is one shader (shaders/landscape.wgsl)
// over the ground's heights (terrain.js); one Box2D chain makes the ground solid.
//
// Chapter 0: "Web Engine for Enhanced Dynamics" in Box2D bricks (bricksTitle.js) on the hills. A click sets off one of
// blastforgeScene's explosions; the nearest bricks burn in burningBoxesScene's fire.
//   ?backend=webgl   Pixi's WebGL backend (default WebGPU where the browser has it; the fire needs WebGPU)

import {
  explode,
  explosionAssets,
  explosionAssetsWgsl,
  explosionLayers,
  FIELD_LAYER,
  updateExplosions,
} from '../blastforgeScene/explosions.js';
import { PRESETS } from '../blastforgeScene/explosionPresets.js';
import { fireAssets, fireLayer } from '../burningBoxesScene/fireLayer.js';
import { Brick, BrickState, FIRE_LAYER, KICK, MAX_BRICKS, TRAILS_LAYER, layoutWord } from './bricksTitle.js';
import { CHAPTERS, ChapterTour } from './chapters.js';
import {
  Ground,
  TERRAIN_STEP,
  TerrainMap,
  Wall,
  groundChain,
  groundChainPoints,
  terrainSamples,
  terrainSchema,
  writeHeights,
} from './terrain.js';

const { Scene, Layer, Mouse, Camera, LAYER_KIND, BLEND_MODES } = WEED;

function param(name, fallback) {
  const search = globalThis.location?.search;
  const value = typeof search === 'string' ? new URLSearchParams(search).get(name) : null;
  return value == null || value === '' ? fallback : value;
}

// The page's values. Workers get the scene's config from the page, and what their ticks need from the spawns.
const BACKEND = param('backend', globalThis.navigator?.gpu ? 'webgpu' : 'webgl') === 'webgl' ? 'webgl' : 'webgpu';
/** One chapter is one screen. */
const VIEW_W = typeof globalThis.innerWidth === 'number' ? globalThis.innerWidth : 1920;
const VIEW_H = typeof globalThis.innerHeight === 'number' ? globalThis.innerHeight : 1080;
const WORLD_W = VIEW_W * CHAPTERS.length;
const WORLD_H = VIEW_H;
const LOGIC_WORKERS = 4; // they share the bricks' ticks

const LANDSCAPE = 'landscape';
/** The fire is a WebGPU compute layer: on WebGL the bricks blast without burning. */
const FIRE_ON = BACKEND === 'webgpu';
/** World px per fire cell; the lattice covers the whole world. */
const FIRE_CELL = 4;
/** Bodies burning at once that the fire packs; a blast lights the nearest few hundred bricks. */
const FIRE_BODIES = 2048;
/** How long a brick burns (ms), and how much of the blast's reach lights bricks. */
const BURN_MS = [6000, 10000];
const BURN_REACH = 0.42;
/** blastforgeScene's fuel barrel, without the parts that need its ground: dust ring, landing pieces, scorch, flames. */
const BLAST = { ...PRESETS.barrel, dust: 0, sparks: 0, debris: 0, scorch: 0, flames: 0, flameTime: 0, secondary: 0 };
/** Puffs per blast, times the preset's: a denser, softer fireball. */
const BLAST_AMOUNT = 2.5;
/** The explosion layers' texel, in world px: one, and no bands or dither (uSmooth), so the blast reads real. */
const BLAST_PIXEL = 1;

/** The fragment's file for this backend, next to this scene. */
const shaderUrl = (name) => new URL(`./shaders/${name}`, import.meta.url).href;

/**
 * blastforgeScene's explosion layers, smooth: no bands, dither or outline. They expect a logic worker to set blasts
 * off; here the page does.
 */
function blastLayers() {
  const layers = explosionLayers({ pixelZoom: BLAST_PIXEL, palette: BLAST.palette });
  for (const layer of Object.values(layers)) {
    if (layer.gpuRings) layer.gpuRings = { main: 1, logic: 0, particle: 0 };
  }
  const field = layers[FIELD_LAYER].shader.uniforms;
  field.uSmooth.value = 1;
  field.uDither.value = 0;
  field.uOutline.value = 0;
  return layers;
}

/** burningBoxesScene's fire, its smoke paled: soot does not show on a dark sky. */
function landingFire() {
  const layer = fireLayer({
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    cellSize: FIRE_CELL,
    lfRadius: 6,
    maxBodies: FIRE_BODIES,
    maxParticles: 64, // no LiquidFun in it: only burning bodies feed it
  });
  layer.shader.uniforms.uSmokeLift.value = 0.75;
  layer.shader.uniforms.uSmokeDens.value = 1;
  return layer;
}

export class LandingScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: 7,
    // A blast of the whole word kicks every brick: two commands each.
    physics: {
      numberOfPhysicsWorkers: 4,
      commandRingCapacity: 32768,
      maxChainPoints: groundChainPoints(WORLD_W) + 64,
    },
    spatial: { numberOfSpatialWorkers: 0, maxNeighbors: 0 },
    logic: { numberOfLogicWorkers: LOGIC_WORKERS },
    particle: { maxParticles: 0, decals: false },
    lighting: { enabled: false },
    renderer: { backend: BACKEND },
    layers: {
      // Sky, sun and moon, stars, clouds, mountains and the ground, behind everything.
      [LANDSCAPE]: {
        zIndex: 0,
        shader: {
          fragment: { webgpu: shaderUrl('landscape.wgsl'), webgl: shaderUrl('landscape.frag') },
          worldRect: { width: WORLD_W, height: WORLD_H },
          textures: [{ name: 'heights', format: 'rgba8unorm', size: { width: terrainSamples(WORLD_W), height: 1 } }],
          uniforms: {
            uDay: { value: CHAPTERS[0].day, type: 'f32' },
            uTerrain: { value: [TERRAIN_STEP, terrainSamples(WORLD_W), WORLD_W, WORLD_H], type: 'vec4<f32>' },
          },
        },
      },
      [TRAILS_LAYER]: {
        kind: LAYER_KIND.GPU_PARTICLES,
        zIndex: 2.8,
        maxParticles: 131072,
        gpuRings: { main: 0, logic: 1, particle: 0 }, // the bricks' ticks
        blendMode: BLEND_MODES.ADD,
      },
      ...blastLayers(),
      ...(FIRE_ON ? { [FIRE_LAYER]: landingFire() } : {}),
    },
  };

  static assets = {
    textures: { ...explosionAssets.textures },
    shaders: { ...(BACKEND === 'webgpu' ? explosionAssetsWgsl : explosionAssets).shaders, ...fireAssets.shaders },
  };

  static entities = [
    [Brick, MAX_BRICKS],
    [Ground, 1],
    [Wall, 3],
  ];

  static sharedResources = [[TerrainMap, terrainSchema(WORLD_W)]];

  create() {
    Camera.setZoom(1);
    Camera.centerOn(VIEW_W / 2, VIEW_H / 2);
    writeHeights(WORLD_W, VIEW_W, VIEW_H);
    this.landscape = Layer.get(LANDSCAPE);
    this.landscape.updateTexture('heights', TerrainMap.heights);
    this.word = layoutWord(VIEW_W, VIEW_H);
    this.unit = Math.min(VIEW_W, VIEW_H) / 1000; // sizes that follow the screen
    this.blastSize = Math.max(1, 2 * this.unit); // the fireball: 40 px of radius at size 1
    this.tour = new ChapterTour(VIEW_W, VIEW_H);
    this.buildHud();
  }

  createNewGame() {
    Ground.spawn({ x: 0, y: 0, chain: groundChain(WORLD_W, VIEW_W, VIEW_H) });
    const t = 200; // wall thickness, outside the world
    Wall.spawn({ x: -t / 2, y: WORLD_H / 2, width: t, height: WORLD_H * 3 });
    Wall.spawn({ x: WORLD_W + t / 2, y: WORLD_H / 2, width: t, height: WORLD_H * 3 });
    Wall.spawn({ x: WORLD_W / 2, y: -t / 2 - WORLD_H, width: WORLD_W + 2 * t, height: t });
    // The bricks start scattered over the first chapter and fly into the words.
    const { size, bricks } = this.word;
    for (const b of bricks) {
      Brick.spawn({
        x: Math.random() * VIEW_W,
        y: Math.random() * VIEW_H * 0.7,
        homeX: b.x,
        homeY: b.y,
        size,
        color: b.color,
      });
    }
  }

  update(dtRatio, deltaTimeMs) {
    this.tour.update(dtRatio, deltaTimeMs);
    this.landscape.setUniform('uDay', this.tour.day());
    if (Mouse.isButton0Pressed) this.blast(Mouse.x, Mouse.y);
    updateExplosions(deltaTimeMs); // the blasts' lights and shockwaves, on the thread that sets them off
  }

  /**
   * One of blastforgeScene's fireballs at (x, y). The bricks within reach fly off (the page writes their kick, their
   * own ticks apply it), and the nearest ones catch fire.
   */
  blast(x, y) {
    const reach = 150 * this.unit + 40;
    const lit = reach * BURN_REACH;
    const list = Brick.getAllActive();
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      const brick = Brick.get(i);
      const dx = brick.x - x;
      const dy = brick.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > reach * reach) continue;
      const d = Math.sqrt(d2) || 1;
      const f = 1 - d / reach;
      const speed = (450 + 2300 * f) * Math.max(0.6, this.unit);
      const angle = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.7;
      BrickState.kickX[i] = Math.cos(angle) * speed;
      BrickState.kickY[i] = Math.sin(angle) * speed - 500 * this.unit;
      BrickState.spin[i] = (Math.random() - 0.5) * 50 * f;
      BrickState.timer[i] = 2300 + Math.random() * 1000 + 600 * f;
      if (FIRE_ON && d < lit) BrickState.burn[i] = BURN_MS[0] + Math.random() * (BURN_MS[1] - BURN_MS[0]);
      BrickState.mode[i] = KICK;
    }
    explode(x, y, BLAST, { size: this.blastSize, amount: BLAST_AMOUNT });
    Camera.shake(7 * Math.max(0.6, this.unit), 300);
  }

  async destroy() {
    clearInterval(this.hudTimer);
    this.tour?.destroy();
    await super.destroy();
  }

  /** Live numbers: bodies, threads, fps. */
  buildHud() {
    const hud = document.getElementById('weed-hud');
    if (!hud) return;
    const w = this.workers;
    const threads =
      1 +
      w.logicWorkers.length +
      w.spatialWorkers.length +
      w.preRenderWorkers.length +
      (w.particle ? 1 : 0) +
      (w.renderer ? 1 : 0) +
      (w.physics ? this.config.physics.numberOfPhysicsWorkers : 0);
    const fmt = (n) => n.toLocaleString('en-US');
    this.hudTimer = setInterval(() => {
      hud.innerHTML =
        `<b>${fmt(Brick.activeCount + 4)}</b> Box2D bodies<br>` +
        `<b>${threads}</b> threads · <b>${Math.round(this.mainFPS || 0)}</b> fps`;
    }, 250);
  }
}
