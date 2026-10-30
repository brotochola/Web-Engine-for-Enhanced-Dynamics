// landingScene.js – WeedJS's home page (index.html at the repo root, served by GitHub Pages): a tour of the engine in
// six chapters along one landscape, one screen wide each (chapters.js). The wheel, the arrow keys and the page's dots
// move between them, and the time of day follows the camera. The landscape is one shader (shaders/landscape.wgsl)
// over the ground's heights (terrain.js); one Box2D chain makes the ground solid.
//
// Chapter 0: "Web Engine for Enhanced Dynamics" in Box2D bricks (bricksTitle.js) on the hills. Chapter 1: a lake fed by
// a waterfall, LiquidFun water (water.js). Chapter 2: LiquidFun soft bodies a swipe cuts in two (jelly.js). Chapter 4:
// a night camp
// (camp.js). A click blows up the spot (fx.js: GPU particle fire, smoke and embers) and the nearest bodies burn in
// burningBoxesScene's fire.
//   ?backend=webgl   Pixi's WebGL backend (default WebGPU where the browser has it; the fire needs WebGPU)

import { fireAssets, fireLayer } from '../burningBoxesScene/fireLayer.js';
import { Brick, BrickState, FIRE_LAYER, KICK, MAX_BRICKS, TRAILS_LAYER, layoutWord } from './bricksTitle.js';
import { Camp, CampLog, CampProp } from './camp.js';
import { CHAPTERS, ChapterTour } from './chapters.js';
import { fxAssets, fxExplosion, fxLayers } from './fx.js';
import { Blade, JELLY_LAYER, jellyAssets, jellyLayer, pokeJellies, spawnJellies } from './jelly.js';
import { Floater, Paddle, WATER_LAYER, WATER_RADIUS, Waterworks, waterAssets, waterLayer } from './water.js';
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
/** The chapters the scene acts in. */
const HERO = 0;
const FLUIDS = 1;
const SOFT = 2;
const ROPES = 3;
const CAMP = 4;

/** The fragment's file for this backend, next to this scene. */
const shaderUrl = (name) => new URL(`./shaders/${name}`, import.meta.url).href;

/** burningBoxesScene's fire, its smoke paled (soot does not show on a dark sky) and its flames shorter. */
function landingFire() {
  const layer = fireLayer({
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    cellSize: FIRE_CELL,
    lfRadius: 6,
    maxBodies: FIRE_BODIES,
    maxParticles: 64, // no LiquidFun in it: only burning bodies feed it
  });
  const u = layer.shader.uniforms;
  u.uSmokeLift.value = 0.75;
  u.uSmokeDens.value = 1;
  // Small bodies: shorter, livelier flames than burningBoxesScene's crates.
  u.uRise.value = -600;
  u.uFireCool.value = 3;
  u.uFireNoise.value = 0.35;
  u.uSwirlForce.value = 0.85;
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
      // No world gravity: the title's bricks float at their places. Water falls by setRadialGravity (water.js).
      liquidFun: { enabled: true, radius: WATER_RADIUS, maxCount: 16000, subSteps: 2 },
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
      [WATER_LAYER]: waterLayer(),
      [JELLY_LAYER]: jellyLayer(WATER_RADIUS),
      ...fxLayers(),
      ...(FIRE_ON ? { [FIRE_LAYER]: landingFire() } : {}),
    },
  };

  static assets = {
    textures: {
      ...fxAssets.textures,
      campCrate: '/demos/img/box_100_100.png',
      campBarrel: '/demos/img/barrel1.png',
    },
    shaders: { ...fireAssets.shaders, ...waterAssets.shaders, ...jellyAssets.shaders },
  };

  static entities = [
    [Brick, MAX_BRICKS],
    [Ground, 1],
    [Wall, 3],
    [CampProp, 16],
    [CampLog, 4],
    [Floater, 16],
    [Paddle, 1],
    [Blade, 1],
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
    this.tour = new ChapterTour(VIEW_W, VIEW_H);
    this.pressX = 0; // where the pointer went down, canvas px: a tap or a swipe
    this.pressY = 0;
    this.camp = new Camp(CAMP * VIEW_W, VIEW_W, VIEW_H, this.unit);
    this.water = new Waterworks(FLUIDS * VIEW_W, VIEW_W, VIEW_H, this.unit);
    this.waterLayer = Layer.get(WATER_LAYER);
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
    this.camp.spawn();
    this.water.spawn(WORLD_W);
    spawnJellies(SOFT * VIEW_W, VIEW_W, VIEW_H, this.unit);
    // The blade cuts in the soft bodies' and the ropes' chapters.
    const diameter = WATER_RADIUS * 2;
    Blade.spawn({
      x0: SOFT * VIEW_W,
      x1: (ROPES + 1) * VIEW_W,
      particleMass: diameter * diameter, // LiquidFun density 1
      forceProcessOnLogicWorker: 0,
    });
  }

  update(dtRatio, deltaTimeMs) {
    this.tour.update(dtRatio, deltaTimeMs);
    const day = this.tour.day();
    this.landscape.setUniform('uDay', day);
    this.waterLayer.setUniform('uDay', day);
    if (Mouse.isButton0Pressed) {
      this.pressX = Mouse.canvasXAt(0);
      this.pressY = Mouse.canvasYAt(0);
    }
    // A tap (a press and release in place) pokes the jellies; a swipe is the blade's (jelly.js).
    if (Mouse.isButton0Released && this.tour.index === SOFT) {
      const mx = Mouse.canvasXAt(0) - this.pressX;
      const my = Mouse.canvasYAt(0) - this.pressY;
      if (mx * mx + my * my < 64) pokeJellies(Mouse.x, Mouse.y, 160 * Math.max(0.7, this.unit));
    }
    if (Mouse.isButton0Pressed) {
      if (this.tour.index === HERO) this.blast(Mouse.x, Mouse.y);
      else if (this.tour.index === FLUIDS) this.water.click(Mouse.x, Mouse.y);
      else if (this.tour.index === CAMP) this.camp.blast(Mouse.x, Mouse.y);
    }
    this.camp.update(deltaTimeMs, this.near(CAMP));
    this.water.update(deltaTimeMs, this.near(FLUIDS));
  }

  /** Whether chapter i is on screen or next to it. */
  near(i) {
    return Math.abs(Camera.centerX - (i + 0.5) * VIEW_W) < VIEW_W * 1.2;
  }

  /**
   * An explosion at (x, y) (fx.js). The bricks within reach fly off (the page writes their kick, their own ticks apply
   * it), and the nearest ones catch fire.
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
    fxExplosion(x, y, Math.max(0.6, this.unit));
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
