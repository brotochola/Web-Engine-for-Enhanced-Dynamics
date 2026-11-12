// Buenos Aires — a small barrio made by buenos-aires' barrio editor, with its people and cars, to try the engine's light and
// shadows on a town: every wall lit as the surface it is (lighting.faces), houses and cars that say what they are and cast it
// (VolumeShadowCaster), lamps and headlights that come on with the hour. The game is brotochola/buenos-aires; its editor
// exported this barrio (200 × 160 m, seed 385919651), and the people and cars here are its own, without its traffic rules.
//
//   lighting.faces         a lamp lights the wall that looks at it; F turns faces off (it reloads)
//   VolumeShadowCaster     houses (setHull, from the editor's boxes) and cars (setBox); V hides their shadows
//   ShadowCaster           people, street props and trees (setTexture: the whole tree's silhouette); B hides theirs
//   lighting.resolution    Q: 0.25, 0.5 or 1, how sharp the edge between two faces is (it reloads)
//   lighting.raycasted     R: lamps stopped by the houses' footprints; faces go off with it (it reloads)
//
// URL: ?hour=17.5, ?dayMinutes=8 (0 stops the clock), ?people=400, ?resolution=0.5, ?faces=0, ?raycast=1, ?backend=webgpu.
// Drag, the wheel or WASD move the camera; Z and X move the hour while held; H hides the panel.

import WEED from '/src/index.js';
import { SunPanel } from '../sunStreetScene/sunPanel.js';
import { CAR_MODELS, DRIVING_SHEETS, PARKED_SHEETS, WRECKED_SHEETS } from './carModels.js';
import { META, BARRIO, param, FACES, RAYCAST, OFF, TOWN_SWITCHES, TownSwitches } from './town.js';
import { House, StreetProp, Tree, hiddenLamps } from './townObjects.js';
import { Walker, PEOPLE_SHEETS, LPC_EXCLUDE, WALK_FIELDS } from './walkers.js';
import { DrivingCar, ParkedCar, WreckedCar } from './cars.js';
import { LoadingLine } from './loadingLine.js';

const { Scene, Camera, Decoration, Keyboard, Mouse, Layer, LightEmitter, NavGrid, SharedResource, Sun, BLEND_MODES, rng } = WEED;

const START_HOUR = param('hour', 17.5);
const DAY_MINUTES = param('dayMinutes', 8);
const PEOPLE = Math.max(0, Math.min(4000, Math.floor(param('people', 400))));
const RESOLUTIONS = [0.25, 0.5, 1];
const RESOLUTION = RESOLUTIONS.includes(param('resolution', 0.5)) ? param('resolution', 0.5) : 0.5;
const BACKEND = WEED.params?.get('backend') === 'webgpu' ? 'webgpu' : 'webgl';
const NIGHT_LIGHT = 0.25;
const SCRUB_HOURS = 0.04; // a frame, while Z or X is held
const HOURS = [12, 18.6, 22, 6.2]; // J: noon, dusk, night, dawn
/** The engine's load steps (Scene.LOAD_STEPS), as the loading screen names them. */
const STEP_NAMES = {
  audio: 'audio', scripts: 'scripts', buffers: 'shared memory', adobe: 'animations', atlas: 'sprite atlas', tilemaps: 'tile maps',
  flowfields: 'flowfields', shaders: 'shader sources', sounds: 'sounds', workers: 'workers', world: 'the barrio',
};

/** The floor's baked data (piso.bin), for the floor layer's textures. */
export class FloorData extends SharedResource {}

const f32 = (value) => ({ value, type: 'f32' });

const SHEETS = {
  props: { json: BARRIO + 'img/props.json', png: BARRIO + 'img/props.png' },
  arboles: { json: BARRIO + 'img/arboles.json', png: BARRIO + 'img/arboles.png' },
};
for (let i = 0; i < (META.hojasCaras || 0); i++) SHEETS['caras' + i] = { json: BARRIO + `img/caras${i}.json`, png: BARRIO + `img/caras${i}.png` };
for (const name of PEOPLE_SHEETS) {
  SHEETS[name] = { json: '/demos/img/civil1.json', png: `/demos/img/people/${name}.png`, excludeAnimations: LPC_EXCLUDE };
}
for (const name of new Set([...DRIVING_SHEETS, ...PARKED_SHEETS, ...WRECKED_SHEETS])) {
  SHEETS['car_' + name] = { json: `/demos/buenosAiresScene/img/cars/${name}.json`, png: `/demos/buenosAiresScene/img/cars/${name}.png` };
}
// The editor writes the flowfields as .bin (WeedJS's binary format) when META.ffExt says so, as JSON otherwise.
const FF_EXT = META.ffExt || '.json';
const FLOWFIELDS = { calles: BARRIO + 'ff_calles' + FF_EXT };
for (const name of WALK_FIELDS) FLOWFIELDS[name] = BARRIO + `ff_${name}${FF_EXT}`;

const _v = { x: 0, y: 0 };
const _view = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };

/** Two boxes on the floor, centre, heading (c, s) and half sizes, overlap: separating axes. */
function overlap(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (let k = 0; k < 4; k++) {
    const box = k < 2 ? a : b;
    const nx = k & 1 ? -box.s : box.c;
    const ny = k & 1 ? box.c : box.s;
    const ra = a.hl * Math.abs(nx * a.c + ny * a.s) + a.hw * Math.abs(ny * a.c - nx * a.s);
    const rb = b.hl * Math.abs(nx * b.c + ny * b.s) + b.hw * Math.abs(ny * b.c - nx * b.s);
    if (Math.abs(dx * nx + dy * ny) >= ra + rb) return false;
  }
  return true;
}

/**
 * The editor's car slots are 4.6 × 1.8 m: whether a model fits at slot k, with 30 cm to spare, against the other slots and the
 * props that stand (buenos-aires does the same).
 */
function carFit(world) {
  const px = META.PXM;
  const margin = 0.3 * px;
  const boxes = [];
  for (const c of world.autos) {
    const rot = c.rot || 0;
    boxes.push({ x: c.x, y: c.y, c: Math.cos(rot), s: Math.sin(rot), hl: 2.3 * px, hw: 0.9 * px });
  }
  for (const p of world.props) if (p.r > 0) boxes.push({ x: p.x, y: p.y, c: 1, s: 0, hl: p.r, hw: p.r });
  return (k, model) => {
    const a = boxes[k];
    const want = { x: a.x, y: a.y, c: a.c, s: a.s, hl: (model.length * px) / 2 + margin, hw: (model.width * px) / 2 + margin / 2 };
    const slot = { x: a.x, y: a.y, c: a.c, s: a.s, hl: a.hl + margin, hw: a.hw + margin / 2 };
    if (want.hl <= slot.hl && want.hw <= slot.hw) return true;
    for (let j = 0; j < boxes.length; j++) if (j !== k && overlap(want, boxes[j]) && !overlap(slot, boxes[j])) return false;
    return true;
  };
}

/** Reloads the page with one parameter changed: for what the scene reads when it loads. */
function reloadWith(key, value) {
  const url = new URL(location.href);
  url.searchParams.set(key, String(value));
  location.href = url.href;
}

export class BuenosAiresScene extends Scene {
  static config = {
    worldWidth: META.WW,
    worldHeight: META.WH,
    seed: 7,
    assets: { maxAtlasWidth: 8192, maxAtlasHeight: 4096 },
    spatial: { cellSize: 64, maxNeighbors: 48, maxEntitiesPerCell: 192, numberOfSpatialWorkers: 1 },
    logic: { numberOfLogicWorkers: 2, staggeredUpdates: true },
    physics: { gravity: { x: 0, y: 0 }, sleeping: true, subStepCount: 0 },
    particle: { maxParticles: 0, decals: false },
    decoration: {
      maxDecorations: (META.nPiezas || 0) + (META.nTiles || 0) + META.nPiezasArboles + 2 * META.nProps + META.nArboles + META.nCables + (META.nLineas || 0) + 3000,
      maxAttachedDecorationsPerEntity: 255,
    },
    renderer: { backend: BACKEND, ySort: true },
    // The houses are decorations: they do not fade out as the camera goes back.
    preRender: { startFadingDecorationsAtZoom: 0.2, hideDecorationsAtZoom: 0.1, cullingRatio: 0.3 },
    lighting: {
      // The floor is drawn at SYN (0.5), so the lamps' pools are ellipses.
      enabled: true, raycasted: RAYCAST, lightGlow: 'sprite', baseAmbient: 0.04, maxLights: 1024, groundScaleY: META.SYN,
      // heightScaleY: what a px of height rises on the screen. sunDirect 0.5: a face in the shade keeps half, as the editor lit it.
      faces: { enabled: FACES, heightScaleY: META.CZ, wrap: 0.15, gain: 1.3, sunDirect: 0.5 },
      shadowsEnabled: true, maxShadowCastingLights: 16, maxShadowsPerLight: 64, maxShadowsPerEntity: 2, shadowTextures: true,
      resolution: RESOLUTION, shadowResolution: RESOLUTION,
      // The sun on the camera's side (shadowAngleOffset 0), or every wall the camera sees would be against the light, and no
      // higher than 60 degrees, or at noon it would reach no wall.
      sun: {
        enabled: true, angle: 135, elevation: 40, intensity: 1, color: 0xfff4e0, shadowAlpha: 0.5, startHour: START_HOUR,
        shadowAngleOffset: 0, maxElevation: 60,
        dayCycle: { enabled: DAY_MINUTES > 0, speed: 1, dayDurationMinutes: DAY_MINUTES || 8 },
        night: { intensity: 0, color: 0x5473f2, from: 0.4, to: 0.1 },
      },
    },
    navigation: { enabled: true, cellSize: 64 },
    layers: {
      floor: {
        zIndex: 0.5,
        shader: {
          fragment: { webgl: '/demos/buenosAiresScene/floor.frag', webgpu: '/demos/buenosAiresScene/floor.wgsl' },
          worldRect: { width: META.WW, height: META.WH },
          textures: [
            { name: 'cellA', format: 'rgba8unorm', size: { width: META.CW, height: META.CH } },
            { name: 'cellB', format: 'rgba8unorm', size: { width: META.CW, height: META.CH } },
            { name: 'wealth', format: 'r8unorm', size: { width: META.WG, height: META.HG } },
            { name: 'noiseT', format: 'rgba8unorm', size: { width: 256, height: 256 } },
            { name: 'segs', format: 'rgba8unorm', size: { width: 12, height: META.NS } },
            { name: 'pits', format: 'rgba8unorm', size: { width: META.PW || 1, height: META.PH || 1 } },
          ],
          uniforms: {
            uMW: f32(META.MW), uMH: f32(META.MH), uK: f32(META.K), uSF: f32(META.SF), uSYN: f32(META.SYN), uGC: f32(META.GC),
            uCW: f32(META.CW), uCH: f32(META.CH), uWG: f32(META.WG), uHG: f32(META.HG), uPW: f32(META.PW || 1), uPH: f32(META.PH || 1),
            uRX: f32(0), uRY: f32(0), uRI: f32(0), uRE: f32(0),
          },
        },
      },
      // Stains, cracks and litter on the floor: over it, under the shadows.
      stains: { zIndex: 1.4, ySorting: false, maxItems: Math.max(2000, META.nProps + (META.nLineas || 0)) },
      // The props' baked shadows (sprites with their own alpha) fade with the sun: 0 at intensity 0.143, 1 at 0.857.
      bakedShadows: { zIndex: 1.6, ySorting: false, maxItems: Math.max(2000, META.nProps + META.nArboles), alphaBySun: { from: 0.143, to: 0.857 } },
      cables: { zIndex: 3.5, ySorting: false, maxItems: Math.max(1000, META.nCables + 100) },
      // Additive for real: sprite layers compose with shader.containerBlend, not with blendMode.
      glows: { zIndex: 5.5, blendMode: BLEND_MODES.ADD, shader: { containerBlend: BLEND_MODES.ADD }, ySorting: false, maxItems: 500 },
      lampGlows: { zIndex: 5.6, blendMode: BLEND_MODES.ADD, shader: { containerBlend: BLEND_MODES.ADD }, ySorting: false, maxItems: 1000 },
    },
  };

  static assets = { spritesheets: SHEETS, flowfields: FLOWFIELDS };

  static sharedResources = [
    [FloorData, {
      cellA: { type: Uint8Array, length: META.CW * META.CH * 4 },
      cellB: { type: Uint8Array, length: META.CW * META.CH * 4 },
      wealth: { type: Uint8Array, length: META.WG * META.HG },
      noise: { type: Uint8Array, length: 256 * 256 * 4 },
      segs: { type: Uint8Array, length: META.NS * 48 },
      pits: { type: Uint8Array, length: (META.PW || 1) * (META.PH || 1) * 4 },
    }],
    TOWN_SWITCHES,
  ];

  static entities = [
    [House, META.nCasas + 8],
    [Tree, META.nArboles + 8],
    [StreetProp, META.nProps + 64],
    [Walker, PEOPLE + 16],
    [DrivingCar, META.nAutos + 4],
    [ParkedCar, META.nAutos + 4],
    [WreckedCar, 16],
  ];

  focusX = META.WW / 2;
  focusY = META.WH / 2;
  zoomTarget = 1.2;
  drag = null;
  panel = null;
  paused = DAY_MINUTES <= 0;
  nightOn = false;
  volumesShown = true;
  spriteShadowsShown = true;
  people = 0;
  cars = 0;
  nextReadout = 0;
  /** Until the renderer has drawn its first frame (update), which comes after the last load step: it compiles the shaders. */
  loading = typeof document !== 'undefined' ? new LoadingLine('Buenos Aires') : null;

  async preload() {
    // The floor: baked data, into shared memory, into the shader's textures.
    const bytes = new Uint8Array(await (await fetch(BARRIO + 'piso.bin')).arrayBuffer());
    const parts = META.pisoPartes;
    for (const [name, field] of [['cellA', 'cellA'], ['cellB', 'cellB'], ['wealth', 'wealth'], ['noise', 'noise'], ['segs', 'segs'], ['pits', 'pits']]) {
      if (parts[name]) FloorData[field].set(bytes.subarray(parts[name][0], parts[name][0] + parts[name][1]));
    }
    const floor = Layer.get('floor');
    floor.updateTexture('cellA', FloorData.cellA);
    floor.updateTexture('cellB', FloorData.cellB);
    floor.updateTexture('wealth', FloorData.wealth);
    floor.updateTexture('noiseT', FloorData.noise);
    floor.updateTexture('segs', FloorData.segs);
    if (parts.pits) floor.updateTexture('pits', FloorData.pits);

    const world = await (await fetch(BARRIO + 'mundo.json')).json();
    if (!META.skew) throw new Error('Buenos Aires: the barrio must be exported with flat faces (the editor\'s skew on)');
    // The houses: an entity for what the house is, and its pictures as world decorations, each flat face with its scale, shear,
    // tint and order (sortOffsetY: the base of its column; innerZ: the painter's order in the house), and where it looks.
    // One config object for them all: loading makes no garbage a piece.
    const piece = { x: 0, y: 0, texture: '', scaleX: 1, scaleY: 1, skewX: 0, skewY: 0, tint: 0xffffff, sortOffsetY: 0, innerZ: 0, anchorX: 0.5, anchorY: 0.5 };
    for (const h of world.casas) {
      House.spawn({ x: h.x, y: h.y, col: h.col, r: h.r, k: h.k, l: h.l, sp: h.sp });
      const pieces = world.variantes[h.v];
      for (let i = 0; i < pieces.length; i++) {
        const t = pieces[i];
        piece.x = h.ox + t[1];
        piece.y = h.oy + t[2];
        piece.texture = t[0];
        piece.scaleX = t[3];
        piece.scaleY = t[4];
        piece.skewX = t[5];
        piece.skewY = t[6];
        piece.tint = t[7];
        piece.sortOffsetY = t[8];
        piece.innerZ = t[9];
        if (FACES && t.length >= 14) {
          // The normal in the engine's floor space: x along the screen, y across the floor towards the camera, z up.
          piece.faceNormalX = t[10];
          piece.faceNormalY = META.K * t[10] - t[11];
          piece.faceNormalZ = t[12];
          piece.faceHeight = t[13] * META.SF;
        } else piece.faceNormalX = undefined;
        Decoration.spawn(piece);
      }
    }
    const hidden = hiddenLamps(world);
    for (const p of world.props) {
      if (p.sh && !(p.r > 0)) {
        const a = META.anclas[p.sh];
        Decoration.spawn({ x: p.x, y: p.y, texture: 'props_' + p.sh, anchorX: a[0], anchorY: a[1], alpha: 0.45, layer: 'bakedShadows' });
      }
      if (p.r > 0) {
        StreetProp.spawn({ x: p.x, y: p.y, f: p.f, r: p.r, fl: p.fl, hidden: hidden.has(p) ? 1 : 0 });
        continue;
      }
      const a = META.anclas[p.f];
      const e = (META.escalas && META.escalas[p.f]) || 1;
      const sways = p.f.startsWith('plm_') || p.f.startsWith('yy_'); // plants: a shear, their foot stays
      Decoration.spawn({
        x: p.x, y: p.y, texture: 'props_' + p.f, anchorX: a[0], anchorY: a[1], scaleX: p.fl ? -e : e, scaleY: e,
        ...(sways ? { swaySkew: 1, swayAmplitude: 0.05 + rng() * 0.05, swayFrequency: 0.5 + rng() * 0.6 } : {}),
        ...(p.f.startsWith('gd_') ? { layer: 'stains' } : {}),
      });
    }
    // A tree with no silhouette gets the editor's baked shadow; one with a silhouette casts its own.
    const treeShadow = META.anclas.sh_tree;
    for (const a of world.arboles) {
      const kind = world.arbolTipos[a.t];
      Tree.spawn({ x: a.x, y: a.y, fl: a.fl, r: a.r, kind });
      if (treeShadow && !kind.sil) {
        Decoration.spawn({ x: a.x, y: a.y, texture: 'props_sh_tree', anchorX: treeShadow[0], anchorY: treeShadow[1], alpha: 0.4, layer: 'bakedShadows' });
      }
    }
    for (const c of world.cables) {
      const dx = c[2] - c[0];
      const dy = c[3] - c[1];
      const length = Math.sqrt(dx * dx + dy * dy);
      Decoration.spawn({ x: c[0], y: c[1], texture: '_white', anchorX: 0, anchorY: 0.5, scaleX: length / 8, scaleY: 1 / 8, rotation: Math.atan2(dy, dx), tint: 0x17171b, alpha: 0.85, layer: 'cables' });
    }
    for (const c of world.lineas || []) {
      const dx = c[2] - c[0];
      const dy = c[3] - c[1];
      const length = Math.sqrt(dx * dx + dy * dy);
      Decoration.spawn({ x: c[0], y: c[1], texture: '_white', anchorX: 0, anchorY: 0.5, scaleX: (length + 1) / 8, scaleY: 1.5 / 8, rotation: Math.atan2(dy, dx), tint: 0xf2f2ea, alpha: 0.8, layer: 'stains' });
    }
    // People: on points of the sidewalks (where the round-the-block field has a direction).
    for (let tries = 0; tries < PEOPLE * 60 && this.people < PEOPLE; tries++) {
      const x = rng() * META.WW;
      const y = rng() * META.WH;
      NavGrid.requestVectorFromStaticFlowfield('veredas', x, y, _v);
      if ((_v.x !== 0 || _v.y !== 0) && Walker.spawn({ x, y })) this.people++;
    }
    // Cars where the editor put them: driving ones with headlights, parked ones, wrecks. Each kind cycles through its models; a
    // driving model longer than the editor's slot only where it overlaps nothing the slot did not.
    const fits = carFit(world);
    let driving = 0;
    let parked = 0;
    // The camera starts on the driving car nearest the middle of the map.
    let first = null;
    let nearest = Infinity;
    for (let k = 0; k < world.autos.length; k++) {
      const c = world.autos[k];
      if (c.c === 'burnt') {
        WreckedCar.spawn({ x: c.x, y: c.y, rot: c.rot, sheet: WRECKED_SHEETS[0], still: 1 });
      } else if (c.m) {
        let sheet = DRIVING_SHEETS[driving++ % DRIVING_SHEETS.length];
        for (let n = 0; n < DRIVING_SHEETS.length && !fits(k, CAR_MODELS[sheet]); n++) sheet = DRIVING_SHEETS[driving++ % DRIVING_SHEETS.length];
        DrivingCar.spawn({ x: c.x, y: c.y, rot: c.rot, sheet, headlights: 1 });
        const d2 = (c.x - META.WW / 2) ** 2 + (c.y - META.WH / 2) ** 2;
        if (d2 < nearest) {
          nearest = d2;
          first = c;
        }
      } else {
        ParkedCar.spawn({ x: c.x, y: c.y, rot: c.rot, sheet: PARKED_SHEETS[parked++ % PARKED_SHEETS.length] });
      }
      this.cars++;
    }
    if (first) {
      this.focusX = first.x;
      this.focusY = first.y;
    }
  }

  create() {
    // The sun at the hour also with the clock stopped (?dayMinutes=0): sun.startHour sets it only on a day cycle.
    Sun.setTimeOfDay(START_HOUR);
    Camera.setFree(false);
    Camera.setZoom(this.zoomTarget);
    Camera.centerOn(this.focusX, this.focusY);
    for (let k = 0; k < 4; k++) TownSwitches.off.store(0, k);
    this.panel = new SunPanel([
      { key: ' ', keyName: 'Space', label: 'Clock', note: 'Z and X move the hour while held', press: () => this.togglePause() },
      { key: 'j', keyName: 'J', label: 'Jump to', note: 'noon, dusk, night, dawn', press: () => this.jumpHour() },
      { key: 'n', keyName: 'N', label: 'Night light', note: 'lighting.sun.night: a blue light of its own, Sun.intensity stays', press: () => this.toggleNight() },
      { key: 'v', keyName: 'V', label: 'Volume shadows', note: 'VolumeShadowCaster: houses and cars (the volumeShadows layer)', press: () => this.toggleVolumes() },
      { key: 'b', keyName: 'B', label: 'Sprite shadows', note: 'ShadowCaster: people, street props, trees (castedShadows)', press: () => this.toggleSpriteShadows() },
      { key: 'l', keyName: 'L', label: 'Lamps', note: 'street lamps and wooden posts, on from 18-19 h to 6-7 h', press: () => this.toggleSwitch(OFF.LAMPS) },
      { key: 'o', keyName: 'O', label: 'Headlights', note: 'LightEmitter.offsetX: ahead of each car, turning with it', press: () => this.toggleSwitch(OFF.HEADLIGHTS) },
      { key: 'c', keyName: 'C', label: 'Cars', note: 'stopped where they are, to look at one', press: () => this.toggleSwitch(OFF.CARS) },
      { key: 'p', keyName: 'P', label: 'People', note: 'stopped where they are', press: () => this.toggleSwitch(OFF.PEOPLE) },
      { key: 'f', keyName: 'F', label: 'Faces', note: 'lighting.faces: each wall lit as the surface it is (reloads)', press: () => reloadWith('faces', FACES ? 0 : 1) },
      { key: 'q', keyName: 'Q', label: 'Light resolution', note: 'lighting.resolution: the edge between two faces (reloads)', press: () => reloadWith('resolution', RESOLUTIONS[(RESOLUTIONS.indexOf(RESOLUTION) + 1) % RESOLUTIONS.length]) },
      { key: 'r', keyName: 'R', label: 'Raycast', note: 'lighting.raycasted: houses stop lamps; faces go off (reloads)', press: () => reloadWith('raycast', RAYCAST ? 0 : 1) },
    ]);
    this.showStates();
  }

  /** One of the engine's load steps finished (on the main thread, in the order they finish). */
  onLoadProgress(done, total, stage) {
    this.loading?.show((0.9 * done) / total, `${STEP_NAMES[stage] || stage} ready (${done} of ${total})`);
  }

  update(dtRatio = 1) {
    if (this.loading !== null) {
      if (this.readWorkerStepMs().renderer > 0) {
        this.loading.remove();
        this.loading = null;
      } else this.loading.show(0.95, 'the renderer compiles its shaders and draws the first frame');
    }
    if (Keyboard.isPressed(' ')) this.togglePause();
    if (Keyboard.isPressed('j')) this.jumpHour();
    if (Keyboard.isPressed('n')) this.toggleNight();
    if (Keyboard.isPressed('v')) this.toggleVolumes();
    if (Keyboard.isPressed('b')) this.toggleSpriteShadows();
    if (Keyboard.isPressed('l')) this.toggleSwitch(OFF.LAMPS);
    if (Keyboard.isPressed('o')) this.toggleSwitch(OFF.HEADLIGHTS);
    if (Keyboard.isPressed('c')) this.toggleSwitch(OFF.CARS);
    if (Keyboard.isPressed('p')) this.toggleSwitch(OFF.PEOPLE);
    if (Keyboard.isPressed('f')) reloadWith('faces', FACES ? 0 : 1);
    if (Keyboard.isPressed('q')) reloadWith('resolution', RESOLUTIONS[(RESOLUTIONS.indexOf(RESOLUTION) + 1) % RESOLUTIONS.length]);
    if (Keyboard.isPressed('r')) reloadWith('raycast', RAYCAST ? 0 : 1);
    if (Keyboard.isPressed('h')) this.panel.toggle();
    if (Keyboard.z) Sun.setTimeOfDay((Sun.hour + 24 - SCRUB_HOURS * dtRatio) % 24);
    if (Keyboard.x) Sun.setTimeOfDay((Sun.hour + SCRUB_HOURS * dtRatio) % 24);

    // The camera: drag, pinch, wheel, WASD or the arrows.
    const z = Camera.zoom || 1;
    if (Mouse.count === 1) {
      const cx = Mouse.canvasXAt(0);
      const cy = Mouse.canvasYAt(0);
      if (this.drag) {
        this.focusX -= (cx - this.drag[0]) / z;
        this.focusY -= (cy - this.drag[1]) / z;
      }
      this.drag = [cx, cy];
    } else this.drag = null;
    if (Mouse.count >= 2) this.zoomBy(Mouse.pinchRatio());
    if (Mouse.wheel) this.zoomBy(Math.exp(-Mouse.wheel * 0.0012));
    const pan = (12 / z) * dtRatio;
    if (Keyboard.a || Keyboard.arrowleft) this.focusX -= pan;
    if (Keyboard.d || Keyboard.arrowright) this.focusX += pan;
    if (Keyboard.w || Keyboard.arrowup) this.focusY -= pan;
    if (Keyboard.s || Keyboard.arrowdown) this.focusY += pan;
    this.keepInView();
    Camera.targetZoom = this.zoomTarget;
    Camera.follow(this.focusX, this.focusY, 0.35, dtRatio);

    const now = performance.now();
    if (now >= this.nextReadout) {
      this.nextReadout = now + 250;
      this.showReadout();
    }
  }

  async destroy() {
    this.panel?.remove();
    this.loading?.remove();
    this.loading = null;
    this.panel = null;
    await super.destroy();
  }

  zoomBy(f) {
    this.zoomTarget = Math.max(0.25, Math.min(4, this.zoomTarget * f));
  }

  /**
   * The whole view inside the map, which on the screen is a parallelogram (each px up shifts K/SYN px right), so the camera never
   * shows the world's edge.
   */
  keepInView() {
    const vb = Camera.getViewportBounds(_view);
    const z = Camera.zoom || 1;
    const cw = vb.width * z;
    const ch = vb.height * z;
    if (!(cw > 0 && ch > 0)) return;
    const S = META.SF;
    const widthPx = META.MW * S;
    const shift = META.K * S * META.MH;
    const kk = META.K / META.SYN;
    this.zoomTarget = Math.max(this.zoomTarget, ch / META.WH, (cw + kk * ch) / widthPx);
    const hw = cw / (2 * this.zoomTarget);
    const hh = ch / (2 * this.zoomTarget);
    this.focusY = Math.max(hh, Math.min(META.WH - hh, this.focusY));
    const lo = shift - kk * (this.focusY - hh) + hw;
    const hi = widthPx + shift - kk * (this.focusY + hh) - hw;
    this.focusX = lo <= hi ? Math.max(lo, Math.min(hi, this.focusX)) : (lo + hi) / 2;
  }

  togglePause() {
    this.paused = !this.paused;
    this.config.lighting.sun.dayCycle.enabled = !this.paused;
    this.showStates();
  }

  jumpHour() {
    const h = Sun.hour || 12;
    const next = HOURS.find((x) => x > h + 0.1) ?? HOURS[0];
    Sun.setTimeOfDay(next);
  }

  toggleNight() {
    this.nightOn = !this.nightOn;
    Sun.nightIntensity = this.nightOn ? NIGHT_LIGHT : 0;
    this.showStates();
  }

  toggleVolumes() {
    this.volumesShown = !this.volumesShown;
    const layer = Layer.get('volumeShadows');
    if (layer) layer.visible = this.volumesShown;
    this.showStates();
  }

  toggleSpriteShadows() {
    this.spriteShadowsShown = !this.spriteShadowsShown;
    if (Layer.castedShadows) Layer.castedShadows.visible = this.spriteShadowsShown;
    this.showStates();
  }

  toggleSwitch(which) {
    TownSwitches.off.store(TownSwitches.off.load(which) ? 0 : 1, which);
    this.showStates();
  }

  showStates() {
    const p = this.panel;
    const off = (k) => TownSwitches.off.load(k) === 1;
    p.show(' ', this.paused ? 'stopped' : 'running');
    p.show('j', HOURS.map((h) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`).join(', '));
    p.show('n', this.nightOn ? 'on' : 'off');
    p.show('v', this.volumesShown ? 'shown' : 'hidden');
    p.show('b', this.spriteShadowsShown ? 'shown' : 'hidden');
    p.show('l', off(OFF.LAMPS) ? 'off' : 'by the hour');
    p.show('o', off(OFF.HEADLIGHTS) ? 'off' : 'by the hour');
    p.show('c', off(OFF.CARS) ? 'stopped' : 'driving');
    p.show('p', off(OFF.PEOPLE) ? 'stopped' : 'walking');
    p.show('f', RAYCAST ? 'off with raycast' : FACES ? 'on' : 'off');
    p.show('q', String(RESOLUTION));
    p.show('r', RAYCAST ? 'on' : 'off');
  }

  showReadout() {
    const hour = Sun.hour;
    const hh = String(Math.floor(hour)).padStart(2, '0');
    const mm = String(Math.floor((hour % 1) * 60)).padStart(2, '0');
    const ms = this.readWorkerStepMs();
    let lit = 0;
    const active = LightEmitter.active;
    if (active) for (let i = 0; i < active.length; i++) if (active[i] === 1) lit++;
    this.panel.readout.textContent =
      `${hh}:${mm}   sun ${Sun.intensity.toFixed(2)}   night ${Sun.nightFactor.toFixed(2)}   shadow ${Sun.shadowOpacity.toFixed(2)}\n` +
      `renderer ${ms.renderer.toFixed(2)} ms   pre-render ${ms.preRender.toFixed(2)} ms   logic ${ms.logic.toFixed(2)} ms\n` +
      `${META.nCasas} houses, ${this.people} people, ${this.cars} cars, ${lit} lights on`;
  }
}
