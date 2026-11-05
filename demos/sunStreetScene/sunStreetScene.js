// Sun Street — a day on a street, with the sun, night and mesh options on one screen. An oblique view: height only
// rises on the screen, so a house is a volume, and a ShadowCaster, which flips a sprite from its foot, cannot shadow it.
//
//   lighting.sun.night     the night's own blue light, which leaves Sun.intensity alone (N)
//   lighting.sun.colors    this scene's colours by hour: the deep orange dusk
//   Sun's publish          E overrides the day cycle in update, every frame, and nothing flickers: workers only see
//                          what the main thread leaves at the end of its frame
//   alphaBySun             windows and lamp halos come up with 'night', clouds go with a ramp, no code in update
//   layer.alpha            L, on a sprite layer and a MESH layer
//   sunProjected           each house's shadow is a mesh with a height per vertex (setHeights), sent once and moved
//                          by the GPU; trees and people use ShadowCaster, and the shadows agree
//   LightEmitter.offsetX   the headlights sit ahead of the car and turn with it (O); the cars are carScene's
//   setTexture             T: the trees cast another tree's silhouette, their sprite stays
//   mesh range uploads     the flag rewrites its vertices every frame and the still tufts are not sent again: the
//                          renderer's time in the panel does not grow with ?tufts=
//   WEED.params            ?carSpeed= is read on the logic worker
//
// URL: ?hour=20 (start hour), ?paused=1, ?dayMinutes=1 (a whole day), ?cars=6, ?carSpeed=4, ?tufts=60000, ?backend=webgpu.
// WASD or arrows pan, the wheel zooms, H hides the panel.

import WEED from '/src/index.js';
import { LAP, ROAD_CX, ROAD_CY, ROAD_WIDTH, WORLD_H, WORLD_W } from './streetLayout.js';
import { CarShadow, FlagPole, GrassTufts, HouseShadow, RoadBand, RoadDashes, StreetFlag } from './gameObjects/streetMeshes.js';
import { StreetCar, StreetCloud, StreetHouse, StreetLamp, StreetTree, StreetWalker } from './gameObjects/streetSprites.js';
import { SunPanel } from './sunPanel.js';

const { Scene, Camera, Decoration, Keyboard, Layer, Sun, Transform, BLEND_MODES, LAYER_KIND } = WEED;

const param = (key, fallback) => Number(WEED.params?.get(key) ?? fallback);
const START_HOUR = param('hour', 16.5);
const DAY_MINUTES = param('dayMinutes', 1);
const CARS = Math.max(0, Math.floor(param('cars', 6)));
const TUFTS = Math.max(1, Math.floor(param('tufts', 60000)));
const BACKEND = WEED.params?.get('backend') === 'webgpu' ? 'webgpu' : 'webgl';

const NIGHT_INTENSITY = 0.14;
const ECLIPSE_INTENSITY = 0.02;
const FADED_ALPHA = 0.3;
const CLOUD_ALPHA = 0.55;
const HEADLIGHT_OFFSET = 110;
const SCRUB_HOURS = 0.06; // per frame

const HOUSE_ROWS = [
  { y: 320, xs: [330, 630, 930, 1230, 1530] },
  { y: 680, xs: [480, 780, 1320] },
  { y: 1040, xs: [330, 630, 930, 1230, 1530] },
];
const HOUSES = HOUSE_ROWS.reduce((sum, row) => sum + row.xs.length, 0);
const LAMPS = [
  [600, 470], [900, 470], [1200, 470],
  [450, 852], [750, 852], [1050, 852], [1350, 852],
];
const FLAG = { x: 1020, y: 680 };
const CLOUDS = [
  { x: 200, y: 220, scale: 1.1, speed: 0.5 },
  { x: 900, y: 620, scale: 0.8, speed: 0.35 },
  { x: 1500, y: 900, scale: 1, speed: 0.42 },
];
const WALKERS = 8;
const WALKER_SHEETS = ['amarillo_01', 'female_01', 'amarillo_02', 'female_03'];
const CAR_SHEETS = ['red', 'yellow', 'blue', 'white', 'black', 'poli'];

export class SunStreetScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: 7,
    spatial: { cellSize: 128, maxNeighbors: 32, noLimitFPS: false },
    logic: { noLimitFPS: false },
    physics: { noLimitFPS: false, gravity: { x: 0, y: 0 } },
    particle: { noLimitFPS: false, maxParticles: 0, decals: false },
    decoration: { maxDecorations: 64 },
    renderer: {
      backend: BACKEND,
      noLimitFPS: false,
      ySort: true,
      maxMeshVerts: TUFTS * 3 + 8000,
      maxMeshIndices: TUFTS * 3 + 16000,
    },
    layers: {
      grass: { kind: LAYER_KIND.TILING, texture: 'grass', tileScale: 1, parallax: 1, zIndex: 0 },
      tufts: { kind: LAYER_KIND.MESH, zIndex: 0.4 },
      sidewalk: { kind: LAYER_KIND.MESH, zIndex: 0.45 },
      street: { kind: LAYER_KIND.MESH, zIndex: 0.5 },
      houseShadows: { kind: LAYER_KIND.MESH, zIndex: 1.5, sunProjected: true },
      flags: { kind: LAYER_KIND.MESH, zIndex: 3 },
      clouds: { zIndex: 4, ySorting: false, alpha: CLOUD_ALPHA, alphaBySun: { from: 0.15, to: 0.5 } },
      nightGlows: { zIndex: 5.6, ySorting: false, blendMode: BLEND_MODES.ADD, alphaBySun: 'night' },
    },
    lighting: {
      enabled: true,
      baseAmbient: 0.06,
      maxLights: 32,
      shadowsEnabled: true,
      shadowTextures: true,
      maxShadowCastingLights: 8,
      maxShadowsPerLight: 24,
      sun: {
        enabled: true,
        startHour: START_HOUR,
        shadowAlpha: 0.6,
        dayCycle: { enabled: true, speed: 1, dayDurationMinutes: DAY_MINUTES },
        night: { intensity: NIGHT_INTENSITY, color: 0x4a6cff, from: 0.4, to: 0.1 },
        colors: [
          { hour: 0, color: 0x1a1a2e },
          { hour: 5, color: 0x2d4a6e },
          { hour: 6.5, color: 0xff8855 },
          { hour: 8, color: 0xffeedd },
          { hour: 12, color: 0xffffff },
          { hour: 16, color: 0xffeedd },
          { hour: 18, color: 0xff9a55 },
          { hour: 19.5, color: 0xff5522 },
          { hour: 21, color: 0x2d4a6e },
          { hour: 24, color: 0x1a1a2e },
        ],
      },
    },
  };

  static assets = {
    textures: {
      grass: '/demos/img/bg.png',
      house1: '/demos/img/house1.png',
      house2: '/demos/img/house2.png',
      tree1: '/demos/img/tree1.png',
      tree2: '/demos/img/tree2.png',
      tallLight: '/demos/img/tallLight.png',
      cloud: '/demos/img/cloud.png',
      halo: '/demos/sunStreetScene/halo.png',
      square: '/demos/img/10_10_square.png',
    },
    spritesheets: {
      ...Object.fromEntries(CAR_SHEETS.map((name) => [`car_${name}`, { json: `/demos/img/cars/${name}.json`, png: `/demos/img/cars/${name}.png` }])),
      ...Object.fromEntries(WALKER_SHEETS.map((name) => [name, { json: '/demos/img/civil1.json', png: `/demos/img/people/${name}.png` }])),
    },
  };

  static entities = [
    [GrassTufts, 1],
    [RoadBand, 2],
    [RoadDashes, 1],
    [StreetHouse, HOUSES],
    [HouseShadow, HOUSES],
    [StreetTree, 10],
    [StreetLamp, LAMPS.length],
    [StreetWalker, WALKERS],
    [StreetCar, CARS],
    [CarShadow, CARS],
    [StreetCloud, CLOUDS.length],
    [StreetFlag, 1],
    [FlagPole, 1],
  ];

  _panel = null;
  _nightOn = true;
  _eclipse = false;
  _paused = param('paused', 0) === 1;
  _headlightsAhead = true;
  _treeShadows = false;
  _faded = false;
  _nextReadout = 0;

  create() {
    Sun.setTimeOfDay(START_HOUR);
    Camera.setFree(true, { panSpeed: 12 });
    Camera.setFreeTarget(WORLD_W * 0.5, WORLD_H * 0.5);
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
    Camera.setZoom(Math.min(innerWidth / WORLD_W, innerHeight / WORLD_H));
    this._applyClock();

    this._panel = new SunPanel([
      { key: ' ', keyName: 'Space', label: 'Clock', note: 'Z and X move the hour, held. H hides this panel', press: () => this._togglePause() },
      { key: 'n', keyName: 'N', label: 'Night light', note: 'A blue light of its own: Sun.intensity, lamps and shadows stay', press: () => this._toggleNight() },
      { key: 'e', keyName: 'E', label: 'Eclipse', note: 'update overrides Sun.intensity after the cycle, every frame: it must not flicker', press: () => this._toggleEclipse() },
      { key: 'o', keyName: 'O', label: 'Headlights', note: 'At night. LightEmitter.offsetX: the pool ahead of the car, through the bends', press: () => this._toggleHeadlights() },
      { key: 't', keyName: 'T', label: 'Tree shadows', note: 'ShadowCaster.setTexture: another silhouette, the same sprite', press: () => this._toggleTreeShadows() },
      { key: 'l', keyName: 'L', label: 'layer.alpha', note: 'On the road (MESH layers) and the clouds (a sprite layer)', press: () => this._toggleFade() },
    ]);
    this._showStates();
  }

  createNewGame() {
    GrassTufts.spawn({ x: WORLD_W * 0.5, y: WORLD_H * 0.5, count: TUFTS });
    RoadBand.spawn({ x: ROAD_CX, y: ROAD_CY, layer: 'sidewalk', width: ROAD_WIDTH + 36, tint: 0xb4b0a4 });
    RoadBand.spawn({ x: ROAD_CX, y: ROAD_CY, layer: 'street', width: ROAD_WIDTH, tint: 0x4b4d52 });
    RoadDashes.spawn({ x: ROAD_CX, y: ROAD_CY });

    let house = 0;
    for (const row of HOUSE_ROWS) {
      for (const x of row.xs) {
        const texture = house++ % 2 === 0 ? 'house1' : 'house2';
        StreetHouse.spawn({ x, y: row.y, texture });
        HouseShadow.spawn({ x, y: row.y });
        Decoration.spawn({ x: x + (texture === 'house1' ? 40 : 34), y: row.y - 51, texture: 'square', layer: 'nightGlows', tint: 0xffb648, scaleX: 6.4, scaleY: 3.8, anchorY: 0.5, alpha: 0.6 });
      }
    }
    for (const row of [HOUSE_ROWS[0], HOUSE_ROWS[2]]) {
      for (let i = 0; i < row.xs.length - 1; i++) {
        StreetTree.spawn({ x: row.xs[i] + 150, y: row.y + 4, texture: i % 2 === 0 ? 'tree1' : 'tree2', scale: 0.85 });
      }
    }
    StreetTree.spawn({ x: 630, y: 640, texture: 'tree1', scale: 0.8 });
    StreetTree.spawn({ x: 1170, y: 640, texture: 'tree2', scale: 0.8 });

    for (const [x, y] of LAMPS) {
      StreetLamp.spawn({ x, y });
      Decoration.spawn({ x, y: y - 118, texture: 'halo', layer: 'nightGlows', tint: 0xffc070, scaleX: 1.6, scaleY: 1.6, anchorY: 0.5, alpha: 0.8 });
    }
    for (let i = 0; i < WALKERS; i++) {
      const y = i < WALKERS / 2 ? 336 : 844;
      StreetWalker.spawn({ x: 300 + i * 170, y, sheet: WALKER_SHEETS[i % WALKER_SHEETS.length], from: 280, to: 1520, direction: i % 2 === 0 ? 1 : -1 });
    }
    for (let i = 0; i < CARS; i++) {
      const car = StreetCar.spawn({ x: ROAD_CX, y: ROAD_CY, sheet: `car_${CAR_SHEETS[i % CAR_SHEETS.length]}`, distance: (i / CARS) * LAP, offset: HEADLIGHT_OFFSET });
      CarShadow.spawn({ x: ROAD_CX, y: ROAD_CY, carIndex: car.index });
    }
    for (const cloud of CLOUDS) StreetCloud.spawn(cloud);
    FlagPole.spawn({ x: FLAG.x, y: FLAG.y });
    StreetFlag.spawn({ x: FLAG.x + 3, y: FLAG.y - 136 });
  }

  update(dtRatio) {
    if (Keyboard.isPressed(' ')) this._togglePause();
    if (Keyboard.isPressed('n')) this._toggleNight();
    if (Keyboard.isPressed('e')) this._toggleEclipse();
    if (Keyboard.isPressed('o')) this._toggleHeadlights();
    if (Keyboard.isPressed('t')) this._toggleTreeShadows();
    if (Keyboard.isPressed('l')) this._toggleFade();
    if (Keyboard.isPressed('h')) this._panel.toggle();
    if (Keyboard.z) Sun.setTimeOfDay((Sun.hour + 24 - SCRUB_HOURS * dtRatio) % 24);
    if (Keyboard.x) Sun.setTimeOfDay((Sun.hour + SCRUB_HOURS * dtRatio) % 24);
    // After the cycle, as a game overrides the sun. Workers read this value, never the cycle's.
    if (this._eclipse) Sun.intensity = ECLIPSE_INTENSITY;

    const now = performance.now();
    if (now >= this._nextReadout) {
      this._nextReadout = now + 250;
      this._showReadout();
    }
  }

  async destroy() {
    this._panel?.remove();
    this._panel = null;
    await super.destroy();
  }

  _applyClock() {
    this.config.lighting.sun.dayCycle.enabled = !this._paused;
  }

  _togglePause() {
    this._paused = !this._paused;
    this._applyClock();
    this._showStates();
  }

  _toggleNight() {
    this._nightOn = !this._nightOn;
    Sun.nightIntensity = this._nightOn ? NIGHT_INTENSITY : 0;
    this._showStates();
  }

  _toggleEclipse() {
    this._eclipse = !this._eclipse;
    if (!this._eclipse) Sun.setTimeOfDay(Sun.hour); // a stopped clock would keep the override
    this._showStates();
  }

  _toggleHeadlights() {
    this._headlightsAhead = !this._headlightsAhead;
    for (const car of StreetCar.instances) {
      if (Transform.active[car.index]) car.lightEmitter.offsetX = this._headlightsAhead ? HEADLIGHT_OFFSET : 0;
    }
    this._showStates();
  }

  _toggleTreeShadows() {
    this._treeShadows = !this._treeShadows;
    for (const tree of StreetTree.instances) {
      if (!Transform.active[tree.index]) continue;
      if (this._treeShadows) tree.shadowCaster.setTexture('tree2', { anchorX: 0.5, anchorY: 1, scaleX: 1.5, scaleY: 1.5 });
      else tree.shadowCaster.clearTexture();
    }
    this._showStates();
  }

  _toggleFade() {
    this._faded = !this._faded;
    Layer.get('street').alpha = this._faded ? FADED_ALPHA : 1;
    Layer.get('sidewalk').alpha = this._faded ? FADED_ALPHA : 1;
    Layer.get('clouds').alpha = this._faded ? FADED_ALPHA * CLOUD_ALPHA : CLOUD_ALPHA;
    this._showStates();
  }

  _showStates() {
    const panel = this._panel;
    panel.show(' ', this._paused ? 'stopped' : 'running');
    panel.show('n', this._nightOn ? 'on' : 'off');
    panel.show('e', this._eclipse ? 'on' : 'off');
    panel.show('o', this._headlightsAhead ? `${HEADLIGHT_OFFSET} px ahead` : 'on the car');
    panel.show('t', this._treeShadows ? 'a big tree' : "the sprite's");
    panel.show('l', this._faded ? String(FADED_ALPHA) : '1');
  }

  _showReadout() {
    const hour = Sun.hour;
    const hh = String(Math.floor(hour)).padStart(2, '0');
    const mm = String(Math.floor((hour % 1) * 60)).padStart(2, '0');
    const ms = this.readWorkerStepMs();
    this._panel.readout.textContent =
      `${hh}:${mm}   sun ${Sun.intensity.toFixed(2)}   night ${Sun.nightFactor.toFixed(2)}   shadow ${Sun.shadowOpacity.toFixed(2)}\n` +
      `renderer ${ms.renderer.toFixed(2)} ms   pre-render ${ms.preRender.toFixed(2)} ms   logic ${ms.logic.toFixed(2)} ms\n` +
      `${TUFTS.toLocaleString('en')} still tufts beside a waving flag`;
  }
}
