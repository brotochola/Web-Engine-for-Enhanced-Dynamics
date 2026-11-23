import WEED from '/src/index.js';
import { fetchBarrioScene, loadBarrio } from '/demos/buenosAiresScene/barrioLoader.js';
import { Casa, Arbol } from '/demos/buenosAiresScene/townObjects.js';
import { META, BARRIO } from '/demos/buenosAiresScene/town.js';

const { Scene, GameObject, SpriteRenderer, ShadowCaster, LightEmitter, Camera, Sun, Decoration } = WEED;

/**
 * The two ways a house can go to WeedJS, side by side under the same light: on the left, two of Parque Chas's houses as the
 * Editor de Barrios exports them (a decoration a face, each with its normal and height: DX-FACES, DX-FACEDEPTH), from the
 * barrio's own package; on the right, the same two houses as one sprite each with a height map and a normal map, baked by
 * the editor from the same design, turn and textures (its herramientas/casas_mapas.js: houseLight/casas_mapas*.png, the
 * anchors at each house's foot in houseLight/anclas.json). Each side has the same two trees from the barrio, two LPC
 * people and a street lamp, at the same places. Both houses cast the same volume (the package's hull), so what differs is
 * how their surfaces take the light: the faces' planes against the maps' pixels.
 * A sprite with maps takes lighting.normalShading (by the engine's default, by day only what turns well away from the sun
 * darkens, and little; under a lamp its normals shade it whole): the map houses' walls turned from the sun keep most of
 * their light by day, where a face's go into its shade.
 *
 * The barrio's camera and lighting (sun and lamp shadow maps, self-shadow, the sky light). Nothing moves: for side-by-side
 * pictures and compareCaptures.mjs.
 *
 * `?hour=` (default 15; 22 by night, the lamp on), `?side=faces|maps` (that half alone, at `?zoom=`, default 2),
 * `?mapCast=heightMap` (the map houses cast their height maps instead of the hull), `?mapNormals=0` (the map houses
 * without their normal map: normals from the heights), `?resolution=` (lighting's, default 1), `?backend=webgpu`.
 *
 * `?bench=faces|maps`: the cost of each way instead. A grid of `?cols=` by `?rows=` houses (default 12 by 8, 170 by 190 px a
 * house, the two alternating) of that way alone, a street lamp at the curb before every other house (lit by night), no trees
 * or people, the camera at its middle at `?zoom=` (default 1): about the barrio's density of houses on the screen.
 */
const P = WEED.params;
function num(key, fallback) {
  const raw = P?.get(key);
  const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
const HOUR = num('hour', 15);
const SIDE = P?.get('side') === 'faces' || P?.get('side') === 'maps' ? P.get('side') : '';
const ZOOM = num('zoom', SIDE ? 2 : P?.get('bench') ? 1 : 0.96);
const MAP_CAST = P?.get('mapCast') === 'heightMap' ? 'heightMap' : 'hull';
const MAP_NORMALS = P?.get('mapNormals') !== '0';
const RESOLUTION = num('resolution', 1);
const BACKEND = P?.get('backend') === 'webgpu' ? 'webgpu' : 'webgl';
const BENCH = P?.get('bench') === 'faces' || P?.get('bench') === 'maps' ? P.get('bench') : '';
const BENCH_COLS = Math.max(1, Math.floor(num('cols', 12)));
const BENCH_ROWS = Math.max(1, Math.floor(num('rows', 8)));
const BENCH_CELL = [170, 190];
const BENCH_HOUSES = BENCH ? BENCH_COLS * BENCH_ROWS : 0;
const BENCH_LAMPS = Math.ceil(BENCH_HOUSES / 2);
const HERE = '/tests/bench/stressScenes/houseLight/';
/** The houses, by their prefab in the package (the sheet's frames have the same names). */
const HOUSES = ['casa_125', 'casa_168'];
const TREES = ['arbol_fresno_1', 'arbol_platano_0'];
/** Each half of the world: the faces' on the left, the maps' on the right. */
const HALF = 660;
const W = BENCH ? BENCH_COLS * BENCH_CELL[0] : 2 * HALF;
const H = BENCH ? BENCH_ROWS * BENCH_CELL[1] + 120 : 720;
/** Within a half: each house's foot, each tree's, the people's and the lamp's. */
const HOUSE_AT = [[220, 400], [520, 400]];
/** Each tree on its house's sunny side in the afternoon (west), so its shadow falls on the house. */
const TREE_AT = [[95, 410], [385, 410]];
const PEOPLE_AT = [[280, 428], [555, 428]];
/** The lamp at the curb, as the barrio's: 55 screen px in front of the fronts. */
const LAMP_AT = [400, 455];
/** The editor draws a house DET px a world px (meta.detalle of its sheet); the game shows it at 1 / DET. */
const DET = 5 / 3;

export const stressSceneConfig = {
  requested: {
    hour: HOUR, side: SIDE || 'both', zoom: ZOOM, mapCast: MAP_CAST, mapNormals: MAP_NORMALS ? 1 : 0, resolution: RESOLUTION, backend: BACKEND,
    bench: BENCH || 'off', cols: BENCH_COLS, rows: BENCH_ROWS,
  },
};

const editorSheet = (name) => ({ json: `${BARRIO}img/${name}.json`, png: `${BARRIO}img/${name}.png` });
const SHEETS = {};
for (let sheet = 0; sheet < (META.hojasCaras | 0); sheet++) SHEETS[`caras${sheet}`] = editorSheet(`caras${sheet}`);
SHEETS.arboles = editorSheet('arboles');
SHEETS.ventanas = { ...editorSheet('ventanas'), unshaded: true };
SHEETS.civil1 = { json: '/demos/img/civil1.json', png: '/demos/img/civil1.png', heightMap: '/demos/img/civil1_h.png' };
SHEETS.casas_mapas = {
  json: `${HERE}casas_mapas.json`,
  png: `${HERE}casas_mapas.png`,
  heightMap: `${HERE}casas_mapas_h.png`,
  ...(MAP_NORMALS ? { normalMap: `${HERE}casas_mapas_n.png` } : {}),
};

/** The package's decoration classes these houses and trees use (buenosAiresScene.js's, the branches still). */
const DECORATION_CLASSES = {
  Cara: { anchorX: 0.5, anchorY: 0.5 },
  Accesorio: { anchorX: 0.5, anchorY: 0.5 },
  // The lit panes stay off on both sides: the map houses have none.
  Ventana: { sheet: 'ventanas', anchorX: 0.5, anchorY: 0.5, hidden: true },
  Rama: { sheet: 'arboles', anchorX: 0.5, anchorY: 1 },
};

/** A house as one sprite with maps; its volume the package's hull (or its height map, `?mapCast=heightMap`). */
class MapHouse extends GameObject {
  static components = [SpriteRenderer, ShadowCaster];

  onSpawned(config = {}) {
    this.setSprite('casas_mapas', config.frame);
    this.spriteRenderer.anchorX = config.anchor[0];
    this.spriteRenderer.anchorY = config.anchor[1];
    this.setScale(1 / DET, 1 / DET);
    if (MAP_CAST === 'hull' && Array.isArray(config.sp)) this.shadowCaster.setHull(config.sp, { floorScaleY: 1 });
  }
}

/** An LPC person facing the camera, as walkers.js draws one, casting. */
class Person extends GameObject {
  static components = [SpriteRenderer, ShadowCaster];

  onSpawned() {
    this.setSpritesheet('civil1');
    this.setAnimation('idle_down');
    this.spriteRenderer.animationSpeed = 0;
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 62 / 64;
    this.setScale(0.6 * 0.94, 0.6);
  }
}

/** The barrio's street lamp's light (townObjects.js's Prop), on by night. */
class Lamp extends GameObject {
  static components = [LightEmitter];

  onSpawned() {
    this.lightEmitter.color = 0xffd9a0;
    this.lightEmitter.radius = 10 * Math.sqrt(1800 * 2.2);
    this.lightEmitter.elevation = 50;
    this.lightEmitter.shadowRange = 260;
    this.lightEmitter.active = HOUR >= 19 || HOUR < 7 ? 1 : 0;
  }
}

export class HouseLightScene extends Scene {
  static config = {
    worldWidth: W,
    worldHeight: H,
    seed: 0x1a5,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 64, maxNeighbors: 8, maxEntitiesPerCell: 64 },
    // The barrio's Casa ticks every 30 frames (its post lamp's hours), as the barrio runs it.
    logic: { numberOfLogicWorkers: 1, staggeredUpdates: true },
    physics: { subStepCount: 1, gravity: { x: 0, y: 0 } },
    particle: { maxParticles: 0, decals: false },
    decoration: { maxDecorations: BENCH ? 65536 : 4096 },
    renderer: { backend: BACKEND, ySort: true },
    camera: { floorScaleY: META.SYN, heightScaleY: META.CZ },
    lighting: {
      enabled: true,
      lightGlow: 'sorted',
      baseAmbient: 0.04,
      maxLights: BENCH ? BENCH_LAMPS + 8 : 8,
      maxVolumes: BENCH ? BENCH_HOUSES + 8 : 16,
      shadowsEnabled: true,
      selfShadow: true,
      maxShadowCastingLights: BENCH ? 16 : 4,
      maxShadowsPerLight: 64,
      maxShadowsPerEntity: 2,
      resolution: RESOLUTION,
      shadowResolution: RESOLUTION,
      sun: {
        enabled: true, angle: 135, elevation: 40, intensity: 1, color: 0xfff4e0, shadowAlpha: 0.5, startHour: HOUR,
        shadowAngleOffset: 0, maxElevation: 60, skyLight: 0.5, dayCycle: { enabled: false },
        night: { intensity: 0, color: 0x5473f2, from: 0.4, to: 0.1 },
      },
    },
  };

  static assets = { spritesheets: SHEETS };

  static entities = BENCH
    ? [[Casa, BENCH === 'faces' ? BENCH_HOUSES : 1], [MapHouse, BENCH === 'maps' ? BENCH_HOUSES : 1], [Lamp, BENCH_LAMPS]]
    : [[Casa, 2], [Arbol, 4], [MapHouse, 2], [Person, 4], [Lamp, 2]];

  async preload() {
    const [doc, anchors] = await Promise.all([
      fetchBarrioScene(`${BARRIO}${META.escena}`),
      fetch(`${HERE}anclas.json`).then((response) => response.json()),
    ]);
    // A scene file of these houses and trees alone: their prefabs, an entity each on the left half (the package's own
    // decorations on a house, its graffiti, left out: the map houses have none).
    const prefabs = {};
    for (const name of [...HOUSES, ...TREES]) prefabs[name] = doc.prefabs[name];
    if (BENCH) return this.benchGrid(doc, prefabs, anchors);
    const entities = [
      ...HOUSES.map((prefab, i) => ({ name: `Casa${i}`, x: HOUSE_AT[i][0], y: HOUSE_AT[i][1], prefab })),
      ...TREES.map((prefab, i) => ({ name: `Arbol${i}`, x: TREE_AT[i][0], y: TREE_AT[i][1], prefab })),
      ...TREES.map((prefab, i) => ({ name: `ArbolM${i}`, x: HALF + TREE_AT[i][0], y: TREE_AT[i][1], prefab })),
    ];
    const indexOf = (entity) => (entity ? entity.index : -1);
    await loadBarrio({ format: doc.format, script: doc.script, export: doc.export, prefabs, entities, decorations: [] }, {
      where: 'houseLightScene',
      classes: { Casa: (config) => indexOf(Casa.spawn(config)), Arbol: (config) => indexOf(Arbol.spawn(config)) },
      decorations: DECORATION_CLASSES,
      spawnDecorations: (config) => Decoration.spawnMany(config),
      spawnDecoration: (config) => Decoration.spawn(config),
      random: () => 0.5,
    });
    HOUSES.forEach((name, i) => {
      MapHouse.spawn({ x: HALF + HOUSE_AT[i][0], y: HOUSE_AT[i][1], frame: name, anchor: anchors[name], sp: doc.prefabs[name].config.sp });
    });
  }

  /** `?bench=`: the grid of houses of one way, each cell's foot at its middle, 60 px above its bottom. */
  async benchGrid(doc, prefabs, anchors) {
    const cells = [];
    for (let row = 0; row < BENCH_ROWS; row++) {
      for (let col = 0; col < BENCH_COLS; col++) {
        cells.push({ x: (col + 0.5) * BENCH_CELL[0], y: 60 + (row + 1) * BENCH_CELL[1] - 60, house: HOUSES[(row + col) & 1] });
      }
    }
    if (BENCH === 'faces') {
      const entities = cells.map((c, i) => ({ name: `Casa${i}`, x: c.x, y: c.y, prefab: c.house }));
      await loadBarrio({ format: doc.format, script: doc.script, export: doc.export, prefabs, entities, decorations: [] }, {
        where: 'houseLightScene',
        classes: { Casa: (config) => (Casa.spawn(config)?.index ?? -1) },
        decorations: DECORATION_CLASSES,
        spawnDecorations: (config) => Decoration.spawnMany(config),
        spawnDecoration: (config) => Decoration.spawn(config),
        random: () => 0.5,
      });
    } else {
      for (const c of cells) MapHouse.spawn({ x: c.x, y: c.y, frame: c.house, anchor: anchors[c.house], sp: doc.prefabs[c.house].config.sp });
    }
    cells.forEach((c, i) => {
      if ((i & 1) === 0) Lamp.spawn({ x: c.x + 80, y: c.y + 30 });
    });
  }

  create() {
    Sun.setTimeOfDay(HOUR);
    // The floor: a grey sheet hung from the world's north edge, so its foot is behind everything.
    Decoration.spawn({ x: W / 2, y: 0, texture: '_white', scaleX: (W + 8) / 8, scaleY: (H + 8) / 8, anchorX: 0.5, anchorY: 0, tint: 0x8a8578 });
    for (const x0 of BENCH ? [] : [0, HALF]) {
      for (const [x, y] of PEOPLE_AT) Person.spawn({ x: x0 + x, y });
      Lamp.spawn({ x: x0 + LAMP_AT[0], y: LAMP_AT[1] });
    }
    Camera.setZoom(ZOOM);
    if (SIDE === 'faces') Camera.centerOn(HALF / 2, 330);
    else if (SIDE === 'maps') Camera.centerOn(HALF + HALF / 2, 330);
    else Camera.centerOn(W / 2, H / 2);
  }
}
