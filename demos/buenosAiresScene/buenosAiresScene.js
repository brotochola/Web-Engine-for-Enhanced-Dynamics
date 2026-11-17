// Buenos Aires: Parque Chas, a barrio of the city, as the Editor de Barrios exports it (its package is barrio/), lit by
// WeedJS's 3D light: every wall lit as the surface it is (the houses are faces with a normal each), the sun's and the
// lamps' shadows from shadow maps, each surface's self-shadow, depth by the pixel. The people are the demos'
// standard LPC characters and the cars the standard MinZiin ones, each with its height map; the loose objects are the
// standard objects. The cars keep the traffic law (traffic.js); lamps, headlights and windows come on with the hour.
//
//   barrioLoader.js   the only file that knows the package (scene file, meta.js, the gzipped binaries)
//   town.js           what every part shares; townObjects.js houses, trees, objects, traffic lights, the fountain;
//   cars.js           the cars; carModels.js which model each car is; walkers.js the people; traffic.js the law;
//   litWindows.js     the windows at dusk; standardObjects.js the objects' index, as the classes need it
//
// URL: ?hour=17.5, ?dayMinutes=8 (0 stops the clock), ?people=5000, ?resolution=0.5, ?backend=webgpu.
// Drag, the wheel or WASD move the camera; Z and X move the hour while held; H hides the panel.

import WEED from '/src/index.js';
import { SunPanel } from '../sunStreetScene/sunPanel.js';
import { LoadingLine } from './loadingLine.js';
import { fetchBinary, fetchBarrioScene, loadBarrio } from './barrioLoader.js';
import {
  META, BARRIO, PX_PER_M, param, OFF, TOWN_SWITCHES, TownSwitches, TRAFFIC, TRAFFIC_RESOURCE, CROSSING_STRIDE, Traffic,
  ROUNDABOUT,
} from './town.js';
import { Casa, Arbol, Prop, Semaforo, SemaforoLuz, Fuente } from './townObjects.js';
import { AutoIA, AutoEstacionado, LuzAuto } from './cars.js';
import { Persona, PEOPLE_SHEETS, LPC_UNUSED, WALK_FIELDS } from './walkers.js';
import { CAR_DIR, CAR_SHEETS, chooseCarSheets } from './carModels.js';
import { LitWindows } from './litWindows.js';
import { worldToFloorMetres } from './traffic.js';
import {
  OBJECT_NAMES, OBJECT_DECORATIONS, TRAFFIC_LIGHT_OBJECT, objectNamed, objectSheetSpecs, objectDecoration, isSolid,
  solidRadiusPx,
} from './standardObjects.js';

const {
  Scene, Camera, Decoration, DecorationComponent, Keyboard, Mouse, Layer, LightEmitter, NavGrid, SharedResource, Sun, BLEND_MODES,
  LAYER_KIND, rng,
} = WEED;

const SCENE_FILE = `${BARRIO}parquechas.scene.json`;
const START_HOUR = param('hour', 17.5);
const DAY_MINUTES = param('dayMinutes', 8);
const RESOLUTIONS = [0.25, 0.5, 1];
const RESOLUTION = RESOLUTIONS.includes(param('resolution', 0.5)) ? param('resolution', 0.5) : 0.5;
const BACKEND = WEED.params?.get('backend') === 'webgpu' ? 'webgpu' : 'webgl';
const CORES = globalThis.navigator?.hardwareConcurrency || 4;
/** The night's own blue light (lighting.sun.night), on the N key. */
const NIGHT_LIGHT = 0.25;
/** Hours the clock moves a frame while Z or X is held. */
const SCRUB_HOURS = 0.04;
/** J: noon, dusk, night, dawn. */
const HOURS = [12, 18.6, 22, 6.2];
/** The engine's load steps (Scene.onLoadProgress), as the loading screen names them. */
const STEP_NAMES = {
  audio: 'audio', scripts: 'scripts', buffers: 'shared memory', adobe: 'animations', atlas: 'sprite atlas', tilemaps: 'tile maps',
  flowfields: 'flowfields', shaders: 'shader sources', sounds: 'sounds', workers: 'workers', world: 'the barrio',
};

// ---- the pools, from the package's counts (meta.js) ----

const count = (key, fallback = 0) => (Number.isFinite(META[key]) ? META[key] : fallback);
const HOUSES = count('nCasas');
const TREES = count('nArboles');
/** Every loose object: more than the ones that stop a car (the entities), so it is room enough for them. */
const OBJECTS_PLACED = count('nProps');
/** Every traffic light the barrio places (META.nSemaforos): those at a crossing the traffic table knows and the rest. */
const TRAFFIC_LIGHTS = count('nSemaforos', TRAFFIC.nSem | 0);
/** The barrio's fountains, each throwing its water. */
const FOUNTAINS = count('nFuentes', 4);
const CAR_PLACES = count('nAutos');
const DRIVING_CARS = count('nAutosM', CAR_PLACES);
const POLICE_CARS = count('nPoli', CAR_PLACES);
const PARKED_CARS = Math.max(0, CAR_PLACES - DRIVING_CARS);
/** A scene with physics holds 65 535 entities at most (N-253): the people get what the barrio leaves. */
const ENTITY_LIMIT = 65535;
const POOLS_BUT_PEOPLE =
  HOUSES + 8 + TREES + 8 + OBJECTS_PLACED + 64 + TRAFFIC_LIGHTS + 8 + 4 * (TRAFFIC_LIGHTS + 8) + FOUNTAINS + 4 +
  DRIVING_CARS + 8 + PARKED_CARS + 8 + DRIVING_CARS + 2 * POLICE_CARS + 16;
const PEOPLE_MAX = Math.max(0, ENTITY_LIMIT - POOLS_BUT_PEOPLE - 64);
const PEOPLE = Math.max(0, Math.min(PEOPLE_MAX, Math.floor(param('people', 5000))));
/** Decorations: what the package places (its count, else the sum of its kinds), and room for the beacons' dots. */
const DECORATIONS = Math.min(
  1048575,
  (Number.isFinite(META.nDecoraciones)
    ? META.nDecoraciones
    : count('nTiles') + count('nPiezasArboles') + count('nDecoProps') + count('nCables') + count('nGrafitis') +
      count('nLineas') + count('nVentanas')) + 4 * POLICE_CARS + 4096,
);

// ---- the assets ----

/** One of the editor's own sheets, in the package. */
const editorSheet = (name) => ({ json: `${BARRIO}img/${name}.json`, png: `${BARRIO}img/${name}.png` });

const SHEETS = {};
for (let sheet = 0; sheet < count('hojasCaras'); sheet++) SHEETS[`caras${sheet}`] = editorSheet(`caras${sheet}`);
SHEETS.arboles = editorSheet('arboles');
if (META.nGrafitis !== 0) SHEETS.grafitis = editorSheet('grafitis');
// The windows' lit panes keep their colour at night: an unshaded sheet (DX-UNSHADED).
if (META.nVentanas !== 0) SHEETS.ventanas = { ...editorSheet('ventanas'), unshaded: true };
Object.assign(SHEETS, objectSheetSpecs());
// People and cars: the demos' standard sheets with their height maps; no normal maps (the engine derives them).
for (const name of PEOPLE_SHEETS) {
  SHEETS[name] = { json: '/demos/img/civil1.json', png: `/demos/img/${name}.png`, heightMap: `/demos/img/${name}_h.png`, excludeAnimations: LPC_UNUSED };
}
for (const name of CAR_SHEETS) SHEETS[name] = { json: `${CAR_DIR}${name}.json`, png: `${CAR_DIR}${name}.png`, heightMap: `${CAR_DIR}${name}_h.png` };

/** The editor's flowfields (WeedJS's binary format, gzipped inside): the cars' lanes and the people's ways. */
const FLOWFIELDS = { calles: `${BARRIO}ff_calles.bin` };
for (const name of WALK_FIELDS) FLOWFIELDS[name] = `${BARRIO}ff_${name}.bin`;

/**
 * The scene file's decoration classes (format 1's `static decorations`, with barrioLoader's keys): what every
 * decoration of a class shares.
 */
export const DECORATION_CLASSES = {
  // The houses' walls and roofs: the editor's caras sheets (their names are the atlas's), each a face with its normal.
  Cara: { anchorX: 0.5, anchorY: 0.5 },
  // A house's accessories (water tanks, air conditioners, antennas, roof pots): pictures with no plane of their own,
  // drawn over the face behind them (the editor gives them that face's sort point and innerZ 1).
  Accesorio: { anchorX: 0.5, anchorY: 0.5 },
  // What is on a wall: graffiti, signs, climbers (the editor's grafitis sheet).
  Grafiti: { sheet: 'grafitis', anchorX: 0.5, anchorY: 0.5 },
  // The windows' lit panes: hidden; at dusk the scene lights a share of them (LitWindows).
  Ventana: { sheet: 'ventanas', anchorX: 0.5, anchorY: 0.5, hidden: true, keep: true },
  // A tree's branches with their leaves, hung from the tree, swaying about their base, each at its own pace.
  Rama: { sheet: 'arboles', anchorX: 0.5, anchorY: 1, sway: true, swayAmplitude: { min: 0.01, max: 0.02 }, swayFrequency: { min: 0.4, max: 0.7 } },
  // Loose objects that stop nothing: the standard objects, each with its own anchor, scale and sway.
  Prop: { perTexture: OBJECT_DECORATIONS },
  // The objects' drawn shadows (sh_*): on a layer that fades with the sun.
  Sombra: { perTexture: OBJECT_DECORATIONS, layer: 'bakedShadows', alpha: 0.45 },
  // Overhead cables: an 8 px white texel stretched (scaleX = length / 8) and turned, dark.
  Cable: { texture: '_white', anchorX: 0, anchorY: 0.5, scaleY: 1 / 8, tint: 0x17171b, alpha: 0.9, layer: 'cables' },
  // Lines painted on a court, flat on the floor.
  Linea: { texture: '_white', anchorX: 0, anchorY: 0.5, scaleY: 1.5 / 8, tint: 0xf2f2ea, alpha: 0.8, layer: 'stains' },
};

/** The floor's baked data (piso.bin.gz), for the floor layer's textures. */
export class FloorData extends SharedResource {}

const f32 = (value) => ({ value, type: 'f32' });
const _view = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
const _floor = { x: 0, y: 0 };
const _way = { x: 0, y: 0 };

/** How rich the block at a world point is, 0 to 1 (the editor's wealth, 10 m cells). */
function wealthAt(x, y) {
  worldToFloorMetres(META, x, y, _floor);
  const column = Math.max(0, Math.min(META.WG - 1, Math.floor(_floor.x / 10)));
  const row = Math.max(0, Math.min(META.HG - 1, Math.floor(_floor.y / 10)));
  return FloorData.wealth[row * META.WG + column] / 255;
}

/** The index of what a spawn returned, -1 for nothing. */
const indexOf = (entity) => (entity ? entity.index : -1);

/** The first object with a spout: a Fuente record that names none shows it. */
const FOUNTAIN_OBJECT = OBJECT_NAMES.find((name) => Array.isArray(objectNamed(name).spout)) || '';

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
    // ?twinFormat=B or C: the twin page's other formats (E-497's tournament), to compare.
    assets: { maxAtlasWidth: 8192, maxAtlasHeight: 4096, twinFormat: ['A', 'B', 'C'].includes(WEED.params?.get('twinFormat')) ? WEED.params.get('twinFormat') : 'A' },
    spatial: { cellSize: 64, maxNeighbors: 48, maxEntitiesPerCell: 192, numberOfSpatialWorkers: CORES >= 6 ? 2 : 1 },
    logic: { numberOfLogicWorkers: CORES >= 8 ? 3 : 2, staggeredUpdates: true },
    physics: { gravity: { x: 0, y: 0 }, sleeping: true, subStepCount: 0, commandRingCapacity: 65536 },
    particle: { maxParticles: 0, decals: false },
    decoration: { maxDecorations: DECORATIONS, maxAttachedDecorationsPerEntity: 32 },
    // The barrio is pixel art: its atlas is sampled nearest, so a sprite's edge is its own pixel or none. Sampled linear,
    // a scaled sprite's outline came out half transparent, and those pixels took the light of what stood behind them (a
    // bright rim round a head in shade).
    renderer: { backend: BACKEND, ySort: true, atlasScaleMode: 'nearest' },
    // The houses are decorations: they do not fade out as the camera goes back.
    preRender: { startFadingDecorationsAtZoom: 0.2, hideDecorationsAtZoom: 0.1, cullingRatio: 0.3 },
    // The barrio's camera, the standard art's (people, cars, objects): the floor drawn SYN as tall as it is wide, a px
    // of height rising CZ px on the screen.
    camera: { floorScaleY: META.SYN, heightScaleY: META.CZ },
    lighting: {
      enabled: true,
      // ?lightEdges=0 stretches the light as a plain texture (DX-LIGHTEDGES off), to compare.
      lightEdges: WEED.params?.get('lightEdges') !== '0',
      lightGlow: 'sprite',
      baseAmbient: 0.04,
      maxLights: 1024,
      // Every house holds a volume (its hull) for the shadow maps.
      maxVolumes: HOUSES + 16,
      shadowsEnabled: true,
      sunShadows: 'map',
      lampShadows: 'map',
      selfShadow: true,
      maxShadowCastingLights: 16,
      maxShadowsPerLight: 64,
      maxShadowsPerEntity: 2,
      resolution: RESOLUTION,
      shadowResolution: RESOLUTION,
      // The sun on the camera's side (shadowAngleOffset 0), or every wall the camera sees would be against the light, and
      // no higher than 60°, or at noon it would reach no wall. skyLight 0.5: a wall in the shade keeps half its light,
      // as the editor lit it.
      sun: {
        enabled: true, angle: 135, elevation: 40, intensity: 1, color: 0xfff4e0, shadowAlpha: 0.5, startHour: START_HOUR,
        shadowAngleOffset: 0, maxElevation: 60, skyLight: 0.5,
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
            // The roundabout (Parque Chas has one): its centre, its island's and its road's radius, in metres.
            uRX: f32(ROUNDABOUT ? ROUNDABOUT.mx : 0), uRY: f32(ROUNDABOUT ? ROUNDABOUT.my : 0),
            uRI: f32(ROUNDABOUT ? ROUNDABOUT.ri : 0), uRE: f32(ROUNDABOUT ? ROUNDABOUT.re : 0),
          },
        },
      },
      // Lines painted on the floor: over it, under the shadows.
      stains: { zIndex: 1.4, ySorting: false, maxItems: Math.max(1000, count('nLineas') + 100) },
      // The objects' drawn shadows fade with the sun: 0 at intensity 0.143, 1 at 0.857.
      bakedShadows: { zIndex: 1.6, ySorting: false, maxItems: Math.max(2000, OBJECTS_PLACED), alphaBySun: { from: 0.143, to: 0.857 } },
      // The fountain's water: GPU particles over the entities (its jet is over 3 m up: what passes in front stays under it).
      water: { kind: LAYER_KIND.GPU_PARTICLES, zIndex: 3.4, maxParticles: 4096, gpuRings: { main: 0, logic: 1, particle: 0 }, pixelSnap: true },
      cables: { zIndex: 3.5, ySorting: false, maxItems: Math.max(1000, count('nCables') + 100) },
      // The beacons' halos: additive for real (sprite layers compose with shader.containerBlend).
      glows: { zIndex: 5.5, blendMode: BLEND_MODES.ADD, shader: { containerBlend: BLEND_MODES.ADD }, ySorting: false, maxItems: 500 },
    },
  };

  static assets = { spritesheets: SHEETS, flowfields: FLOWFIELDS };

  static decorations = DECORATION_CLASSES;

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
    TRAFFIC_RESOURCE,
  ];

  static entities = [
    [Casa, HOUSES + 8],
    [Arbol, TREES + 8],
    [Prop, OBJECTS_PLACED + 64],
    [Semaforo, TRAFFIC_LIGHTS + 8],
    [SemaforoLuz, 4 * (TRAFFIC_LIGHTS + 8)],
    [Fuente, FOUNTAINS + 4],
    [AutoIA, DRIVING_CARS + 8],
    [AutoEstacionado, PARKED_CARS + 8],
    [LuzAuto, DRIVING_CARS + 2 * POLICE_CARS + 16],
    [Persona, PEOPLE + 16],
  ];

  focusX = META.WW / 2;
  focusY = META.WH / 2;
  zoomTarget = 1.2;
  /** Where the pointer was last frame while dragging (canvas px), NaN when not dragging: no array a frame. */
  dragX = NaN;
  dragY = NaN;
  panel = null;
  paused = DAY_MINUTES <= 0;
  nightOn = false;
  people = 0;
  cars = 0;
  nextReadout = 0;
  /** The car places the scene file gives (LugarAuto): the scene chooses each one's car once the barrio stands. */
  carPlaces = [];
  /** x, y and radius of every object that stops a car, for the car places' fit. */
  solidProps = [];
  windows = null;
  /** Until the renderer has drawn its first frame (update), which comes after the last load step: it compiles the shaders. */
  loading = typeof document !== 'undefined' ? new LoadingLine('Buenos Aires: Parque Chas') : null;

  async preload() {
    this.loading?.show(0.9, 'the barrio: its floor, its traffic and its scene file');
    const [floorBytes, trafficBytes, doc] = await Promise.all([
      fetchBinary(`${BARRIO}piso.bin.gz`),
      TRAFFIC.n ? fetchBinary(`${BARRIO}transito.bin.gz`) : Promise.resolve(null),
      fetchBarrioScene(SCENE_FILE),
    ]);
    this.fillFloor(floorBytes);
    this.fillTraffic(trafficBytes, doc);
    const result = await loadBarrio(doc, {
      where: SCENE_FILE,
      classes: this.entityClasses(),
      decorations: DECORATION_CLASSES,
      spawnDecorations: (config) => Decoration.spawnMany(config),
      spawnDecoration: (config) => Decoration.spawn(config),
      random: rng,
      onProgress: (done, total) => this.loading?.show(0.9 + (0.04 * done) / Math.max(1, total), `the barrio: ${done} of ${total} things`),
    });
    this.windows = new LitWindows(result.kept.Ventana || [], rng, DecorationComponent.alpha);
    this.spawnCars();
    this.spawnPeople();
    if (Array.isArray(META.inicio)) {
      this.focusX = META.inicio[0];
      this.focusY = META.inicio[1];
    }
  }

  /** The floor's baked data, into shared memory, into the floor layer's textures (pisoPartes: where each part starts). */
  fillFloor(bytes) {
    const parts = META.pisoPartes;
    for (const [part, field] of [['cellA', 'cellA'], ['cellB', 'cellB'], ['wealth', 'wealth'], ['noise', 'noise'], ['segs', 'segs'], ['pits', 'pits']]) {
      if (parts[part]) FloorData[field].set(bytes.subarray(parts[part][0], parts[part][0] + parts[part][1]));
    }
    const floor = Layer.get('floor');
    floor.updateTexture('cellA', FloorData.cellA);
    floor.updateTexture('cellB', FloorData.cellB);
    floor.updateTexture('wealth', FloorData.wealth);
    floor.updateTexture('noiseT', FloorData.noise);
    floor.updateTexture('segs', FloorData.segs);
    if (parts.pits) floor.updateTexture('pits', FloorData.pits);
  }

  /**
   * The traffic data: transito.bin (a Uint16 a 1 m cell) and the crossings (meta.js's transito.cruces, or the scene
   * file's `cruces`: x, y, lights, the first street's heading x, y, the light cycle's offset), for every logic worker.
   */
  fillTraffic(bytes, doc) {
    if (bytes) {
      const cells = Math.min(Traffic.grid.length, bytes.byteLength >> 1);
      Traffic.grid.set(new Uint16Array(bytes.buffer, bytes.byteOffset, cells));
    }
    const crossings = (TRAFFIC.cruces || doc.cruces || []).slice(0, TRAFFIC.n | 0);
    if (TRAFFIC.n && crossings.length === 0) console.warn(`${SCENE_FILE}: the barrio has ${TRAFFIC.n} crossings and no "cruces": its traffic lights stay still`);
    crossings.forEach((crossing, id) => {
      for (let value = 0; value < CROSSING_STRIDE; value++) Traffic.crossings[id * CROSSING_STRIDE + value] = crossing[value] ?? 0;
    });
  }

  /** What each class of the scene file's entities becomes. */
  entityClasses() {
    return {
      Casa: (config) => indexOf(Casa.spawn(config)),
      Arbol: (config) => indexOf(Arbol.spawn(config)),
      Prop: (config, context) => this.spawnProp(config, context),
      Semaforo: (config, context) => this.spawnProp({ f: TRAFFIC_LIGHT_OBJECT, ...config }, context),
      Fuente: (config, context) => this.spawnProp({ f: FOUNTAIN_OBJECT, ...config }, context),
      LugarAuto: (config) => {
        this.carPlaces.push({ x: config.x, y: config.y, rotation: config.rotation || 0, color: config.color, moving: !!config.moving });
        return -1;
      },
    };
  }

  /**
   * A standard object (`f`): one that stops a car is an entity (a fountain a Fuente, the traffic light a Semaforo, the
   * rest a Prop); one that stops nothing, a decoration (cheaper).
   */
  spawnProp(config, context) {
    const object = objectNamed(config.f);
    if (!object) {
      context.warnOnce(`the object "${config.f}" is not in demos/img/objetos/index.js: skipped`);
      return -1;
    }
    if (!isSolid(object)) {
      context.spawnDecoration(objectDecoration(config.f, config.x, config.y, !!config.fl, config.scaleX, config.scaleY));
      return -1;
    }
    this.solidProps.push(config.x, config.y, solidRadiusPx(object));
    if (Array.isArray(object.spout)) return indexOf(Fuente.spawn(config));
    if (config.f === TRAFFIC_LIGHT_OBJECT) return indexOf(Semaforo.spawn(config));
    return indexOf(Prop.spawn(config));
  }

  /** The cars, where the editor put them: each place's model chosen here (carModels.js); the moving ones drive. */
  spawnCars() {
    const chosen = chooseCarSheets(this.carPlaces, this.solidProps, wealthAt, rng, PX_PER_M);
    this.carPlaces.forEach((place, position) => {
      const { sheet, driveForce } = chosen[position];
      const config = { x: place.x, y: place.y, rotation: place.rotation, sheet, driveForce };
      const drives = place.moving && place.color !== 'burnt';
      if (drives ? AutoIA.spawn(config) : AutoEstacionado.spawn(config)) this.cars++;
    });
  }

  /** The people, at random points of the sidewalks (where the round-the-block field has a direction). */
  spawnPeople() {
    for (let tries = 0; tries < PEOPLE * 60 && this.people < PEOPLE; tries++) {
      const x = rng() * META.WW;
      const y = rng() * META.WH;
      NavGrid.requestVectorFromStaticFlowfield('veredas', x, y, _way);
      if ((_way.x !== 0 || _way.y !== 0) && Persona.spawn({ x, y })) this.people++;
    }
  }

  create() {
    // The sun at the hour also with the clock stopped (?dayMinutes=0): sun.startHour sets it only on a day cycle.
    Sun.setTimeOfDay(START_HOUR);
    Camera.setFree(false);
    Camera.setZoom(this.zoomTarget);
    Camera.centerOn(this.focusX, this.focusY);
    for (let which = 0; which < 4; which++) TownSwitches.off.store(0, which);
    this.panel = new SunPanel([
      { key: ' ', keyName: 'Space', label: 'Clock', note: 'Z and X move the hour while held', press: () => this.togglePause() },
      { key: 'j', keyName: 'J', label: 'Jump to', note: 'noon, dusk, night, dawn', press: () => this.jumpHour() },
      { key: 'n', keyName: 'N', label: 'Night light', note: 'lighting.sun.night: a blue light of its own, Sun.intensity stays', press: () => this.toggleNight() },
      { key: 'l', keyName: 'L', label: 'Lamps', note: 'street lamps and posts, on from 18-19 h to 6-7 h, each at its minute', press: () => this.toggleSwitch(OFF.LAMPS) },
      { key: 'o', keyName: 'O', label: 'Car lights', note: 'cone headlights (a LuzAuto child for the right one) and the police beacons', press: () => this.toggleSwitch(OFF.HEADLIGHTS) },
      { key: 'c', keyName: 'C', label: 'Cars', note: 'stopped where they are, to look at one', press: () => this.toggleSwitch(OFF.CARS) },
      { key: 'p', keyName: 'P', label: 'People', note: 'stopped where they are', press: () => this.toggleSwitch(OFF.PEOPLE) },
      { key: 'q', keyName: 'Q', label: 'Light resolution', note: 'lighting.resolution: 0.25, 0.5 or 1 (reloads)', press: () => this.nextResolution() },
    ]);
    this.showStates();
  }

  /** One of the engine's load steps finished (on the main thread, in the order they finish). */
  onLoadProgress(done, total, stage) {
    this.loading?.show((0.9 * done) / total, `${STEP_NAMES[stage] || stage} ready (${done} of ${total})`);
  }

  update(dtRatio = 1) {
    this.updateLoadingScreen();
    this.readKeys(dtRatio);
    this.moveCamera(dtRatio);
    const now = performance.now();
    this.windows?.update(Sun.hour, now);
    if (now >= this.nextReadout) {
      this.nextReadout = now + 250;
      this.showReadout();
    }
  }

  updateLoadingScreen() {
    if (this.loading === null) return;
    if (this.readWorkerStepMs().renderer > 0) {
      this.loading.remove();
      this.loading = null;
    } else {
      this.loading.show(0.95, 'the renderer compiles its shaders and draws the first frame');
    }
  }

  readKeys(dtRatio) {
    if (Keyboard.isPressed(' ')) this.togglePause();
    if (Keyboard.isPressed('j')) this.jumpHour();
    if (Keyboard.isPressed('n')) this.toggleNight();
    if (Keyboard.isPressed('l')) this.toggleSwitch(OFF.LAMPS);
    if (Keyboard.isPressed('o')) this.toggleSwitch(OFF.HEADLIGHTS);
    if (Keyboard.isPressed('c')) this.toggleSwitch(OFF.CARS);
    if (Keyboard.isPressed('p')) this.toggleSwitch(OFF.PEOPLE);
    if (Keyboard.isPressed('q')) this.nextResolution();
    if (Keyboard.isPressed('h')) this.panel.toggle();
    if (Keyboard.z) Sun.setTimeOfDay((Sun.hour + 24 - SCRUB_HOURS * dtRatio) % 24);
    if (Keyboard.x) Sun.setTimeOfDay((Sun.hour + SCRUB_HOURS * dtRatio) % 24);
  }

  /** The free camera: drag, pinch, the wheel, WASD or the arrows. */
  moveCamera(dtRatio) {
    const zoom = Camera.zoom || 1;
    if (Mouse.count === 1) {
      const canvasX = Mouse.canvasXAt(0);
      const canvasY = Mouse.canvasYAt(0);
      if (!Number.isNaN(this.dragX)) {
        this.focusX -= (canvasX - this.dragX) / zoom;
        this.focusY -= (canvasY - this.dragY) / zoom;
      }
      this.dragX = canvasX;
      this.dragY = canvasY;
    } else {
      this.dragX = NaN;
      this.dragY = NaN;
    }
    if (Mouse.count >= 2) this.zoomBy(Mouse.pinchRatio());
    if (Mouse.wheel) this.zoomBy(Math.exp(-Mouse.wheel * 0.0012));
    const pan = (12 / zoom) * dtRatio;
    if (Keyboard.a || Keyboard.arrowleft) this.focusX -= pan;
    if (Keyboard.d || Keyboard.arrowright) this.focusX += pan;
    if (Keyboard.w || Keyboard.arrowup) this.focusY -= pan;
    if (Keyboard.s || Keyboard.arrowdown) this.focusY += pan;
    this.keepInView();
    Camera.targetZoom = this.zoomTarget;
    Camera.follow(this.focusX, this.focusY, 0.35, dtRatio);
  }

  async destroy() {
    this.panel?.remove();
    this.loading?.remove();
    this.loading = null;
    this.panel = null;
    await super.destroy();
  }

  zoomBy(factor) {
    this.zoomTarget = Math.max(0.25, Math.min(4, this.zoomTarget * factor));
  }

  /**
   * The whole view inside the map, which on the screen is a parallelogram (each px up shifts K/SYN px right), so the
   * camera never shows the world's edge.
   */
  keepInView() {
    const view = Camera.getViewportBounds(_view);
    const zoom = Camera.zoom || 1;
    const canvasWidth = view.width * zoom;
    const canvasHeight = view.height * zoom;
    if (!(canvasWidth > 0 && canvasHeight > 0)) return;
    const mapWidthPx = META.MW * META.SF;
    const shift = META.K * META.SF * META.MH;
    const slant = META.K / META.SYN;
    this.zoomTarget = Math.max(this.zoomTarget, canvasHeight / META.WH, (canvasWidth + slant * canvasHeight) / mapWidthPx);
    const halfWidth = canvasWidth / (2 * this.zoomTarget);
    const halfHeight = canvasHeight / (2 * this.zoomTarget);
    this.focusY = Math.max(halfHeight, Math.min(META.WH - halfHeight, this.focusY));
    const lowest = shift - slant * (this.focusY - halfHeight) + halfWidth;
    const highest = mapWidthPx + shift - slant * (this.focusY + halfHeight) - halfWidth;
    this.focusX = lowest <= highest ? Math.max(lowest, Math.min(highest, this.focusX)) : (lowest + highest) / 2;
  }

  togglePause() {
    this.paused = !this.paused;
    this.config.lighting.sun.dayCycle.enabled = !this.paused;
    this.showStates();
  }

  jumpHour() {
    const hour = Sun.hour || 12;
    Sun.setTimeOfDay(HOURS.find((h) => h > hour + 0.1) ?? HOURS[0]);
  }

  toggleNight() {
    this.nightOn = !this.nightOn;
    Sun.nightIntensity = this.nightOn ? NIGHT_LIGHT : 0;
    this.showStates();
  }

  toggleSwitch(which) {
    TownSwitches.off.store(TownSwitches.off.load(which) ? 0 : 1, which);
    this.showStates();
  }

  nextResolution() {
    reloadWith('resolution', RESOLUTIONS[(RESOLUTIONS.indexOf(RESOLUTION) + 1) % RESOLUTIONS.length]);
  }

  showStates() {
    const panel = this.panel;
    const off = (which) => TownSwitches.off.load(which) === 1;
    panel.show(' ', this.paused ? 'stopped' : 'running');
    panel.show('j', HOURS.map((h) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`).join(', '));
    panel.show('n', this.nightOn ? 'on' : 'off');
    panel.show('l', off(OFF.LAMPS) ? 'off' : 'by the hour');
    panel.show('o', off(OFF.HEADLIGHTS) ? 'off' : 'as it gets dark');
    panel.show('c', off(OFF.CARS) ? 'stopped' : 'driving');
    panel.show('p', off(OFF.PEOPLE) ? 'stopped' : 'walking');
    panel.show('q', String(RESOLUTION));
  }

  showReadout() {
    const hour = Sun.hour;
    const hh = String(Math.floor(hour)).padStart(2, '0');
    const mm = String(Math.floor((hour % 1) * 60)).padStart(2, '0');
    const ms = this.readWorkerStepMs();
    let lit = 0;
    const active = LightEmitter.active;
    if (active) for (let index = 0; index < active.length; index++) if (active[index] === 1) lit++;
    this.panel.readout.textContent =
      `${META.lugar || 'Parque Chas'}  ${hh}:${mm}   sun ${Sun.intensity.toFixed(2)}   night ${Sun.nightFactor.toFixed(2)}\n` +
      `renderer ${ms.renderer.toFixed(2)} ms   pre-render ${ms.preRender.toFixed(2)} ms   logic ${ms.logic.toFixed(2)} ms\n` +
      `${HOUSES} houses, ${this.people} people, ${this.cars} cars, ${lit} lights on`;
  }
}
