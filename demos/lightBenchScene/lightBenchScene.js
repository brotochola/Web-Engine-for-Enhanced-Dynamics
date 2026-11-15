// The light bench (DX-LIGHT3D's showcase, DX_LIGHT3D_PLAN.md §11): the light bench prototype's farm with the engine's API.
// Quaternius props rendered from 32 directions, MinZiin cars (the repo's standard sheets, demos/img/autos: half a turn,
// mirrored, drawn at twice their size), two trees and an LPC person (demos/img/civil7) you walk
// with WASD, each with its height map and normal map (assets/: tools/fromLightBench.mjs converts the prototype's files).
// The props and cars are DirectionalSprites: they show the view they face, and each light's shadow shows the view that
// light sees.
//
// The panel on the right has the scene's switches (they reload), the sun, the lamps, the elements (add one; click one to
// select it, drag it to move it, Q/E to turn it, Delete to remove it) and the selected one's shadows and light. Each control
// says which part of the API it is; the code box shows the WeedJS code of what is selected (the scene's config when
// nothing is). The keys, listed in the panel, switch a part on and off to compare.
//
//   ?maps=0       no height or normal maps (lit as the floor, as before)
//   ?sun=sprite   the sun's shadows as sprites on the shadows' layer, instead of its shadow map
//   ?self=0       no self-shadow
//   ?hour=        the sun's hour (default 16)
//   ?still=1      nothing moves (the lamps stay, the person stands without breathing): for captures
//   ?zoom= ?cx= ?cy=  the camera (default: the whole farm); ?panel=0 hides the panel and the marks (captures)
//   ?only=hatch_rojo,arboles,civil7  only those things (none: the grass alone); ?lamps=0 no lamps (captures, checks)
//   ?backend=webgpu
//   ?fullRows=1   the shadows from pre-render's full caster rows (lighting.keyedCasters false: the keyed paths off), to compare
//   ?lampMap=0    the lamps' shadows as stamps, instead of the lamps' shadow map (one tile a lamp)
//   ?sweep=0      the heightmap casters' solids as columns down to the floor, not swept north to their footprints
//   ?pitch= ?floor= ?height=  camera.pitch, floorScaleY, heightScaleY (default 47, 0.736, 0.752, the art's; floor=auto
//                 and height=auto leave them to the pitch: sin and cos)
//   ?ambient=     lighting.baseAmbient (default 0.12)
//   ?depth=1|0    renderer.pixelDepth on or off (default: on by itself, an oblique camera with maps)
//   ?res=         lighting.resolution and shadowResolution (default 1: the canvas's own size)
//   ?cycle=       the day cycle, in hours a second (default 0: the hour stays)

import WEED from '/src/index.js';
import { BENCH_ASSETS, benchSheetSpec, nextCarFacing, sheetScale } from './benchAssets.js';
import { elementCode, lampCode, sceneCode } from './benchCode.js';
import {
  KIND_NAMES, LAMP_KINDS, NORMALS, ORIENTS, SELF_SHADOWS, SUN_KINDS,
  applyLook, boxOf, castsVolume, defaultLook, hullPoints, normalizeLook, volumeRotation,
} from './benchLook.js';
import { BenchOverlay, BenchPanel } from './benchPanel.js';

const { Scene, GameObject, Collider, DirectionalSprite, ShadowCaster, LightEmitter, Camera, Sun, Keyboard, Mouse, SpriteRenderer,
  Transform, LAYER_KIND, enums } = WEED;
const { ShapeType } = enums;

const param = (k) => WEED.params?.get(k) ?? null;
const MAPS = param('maps') !== '0';
const SUN_MAP = param('sun') !== 'sprite';
const SELF = param('self') !== '0';
const STILL = param('still') === '1';
const PANEL = param('panel') !== '0';
const ZOOM = Number(param('zoom')) || 0;
const CX = Number(param('cx')) || 0;
const CY = Number(param('cy')) || 0;
const ONLY = param('only') === null ? null : new Set(param('only').split(','));
const LAMPS = param('lamps') !== '0';
const BACKEND = param('backend') === 'webgpu' ? 'webgpu' : 'webgl';
const FULL_ROWS = param('fullRows') === '1';
// ?sweep=0: lighting.footprintSolids off, the heightmap casters' solids as columns down to the floor.
const SWEEP = param('sweep') !== '0';
// ?lampMap=0: the lamps' shadows as stamps on the shadows' layer, instead of the lamps' shadow map (lighting.lampShadows).
const LAMP_MAP = param('lampMap') !== '0';
const wanted = (sheet) => ONLY === null || ONLY.has(sheet);
const HOUR = Number(param('hour')) || 16;
const HOURS = [10, 16, 18.5, 22];
const W = 1500;
const H = 960;
const DIR = '/demos/lightBenchScene/assets/';
const DEG = Math.PI / 180;

// The prototype's camera: its art keeps the floor at 0.736 and a px of height at 0.752 px on the screen.
const FLOOR_SCALE_Y = 0.7364193217154872;
const HEIGHT_SCALE_Y = 0.7516549042792687;

/** A number knob in [min, max], else the fallback. */
function numberParam(k, fallback, min, max) {
  const q = param(k);
  const n = Number(q);
  return q !== null && q !== '' && n >= min && n <= max ? n : fallback;
}

/** A camera scale knob: 'auto' (null: the pitch's sine or cosine), a number in [min, 1], else the art's. */
function scaleParam(k, fallback, min) {
  return param(k) === 'auto' ? null : numberParam(k, fallback, min, 1);
}

const PITCH = numberParam('pitch', 47, 0, 90);
const FLOOR = scaleParam('floor', FLOOR_SCALE_Y, 0.05);
const HEIGHT = scaleParam('height', HEIGHT_SCALE_Y, 0);
const AMBIENT = numberParam('ambient', 0.12, 0, 1);
const DEPTH = param('depth') === '1' ? true : param('depth') === '0' ? false : null;
const RES = numberParam('res', 1, 0.1, 2);
const CYCLE = numberParam('cycle', 0, 0, 24);

const spritesheets = {};
for (const name of Object.keys(BENCH_ASSETS)) spritesheets[name] = benchSheetSpec(name, MAPS);

/** The anchor each sheet's cells share (every frame's foot there) and its scale next to the bench's art. */
function anchorOn(go, sheet) {
  const a = BENCH_ASSETS[sheet];
  go.spriteRenderer.anchorX = a.anchorX;
  go.spriteRenderer.anchorY = a.anchorY;
  const s = sheetScale(sheet);
  if (s !== 1) go.setScale(s, s);
}

/** The page's messages to an element: 'move' to a point, 'turn' to a facing (a volume turns with it). */
function onBenchMessage(go, name, a, b) {
  if (name === 'move') {
    go.x = a;
    go.y = b;
  } else if (name === 'turn' && go.directionalSprite) {
    go.directionalSprite.facing = a;
    if (go._volume) go.rotation = volumeRotation(go._sheet, a);
  }
}

/** A farm prop rendered from 32 directions, turned as it faces. */
class Prop extends GameObject {
  static components = [DirectionalSprite, ShadowCaster];
  _sheet = '';
  _volume = false;

  onSpawned({ sheet = 'mesa', facing = 0, look = null, hull = null } = {}) {
    const l = look ?? defaultLook(sheet);
    this._sheet = sheet;
    this._volume = castsVolume(l);
    this.setSpritesheet(sheet);
    anchorOn(this, sheet);
    this.directionalSprite.facing = facing;
    this.setAnimation('stand');
    // The prototype's fence casts a card along it, whatever the light (its default look).
    applyLook(this, sheet, l, hull, facing);
  }

  onMessage(name, from, a, b) {
    onBenchMessage(this, name, a, b);
  }
}

/** A car: half a turn drawn, the other half mirrored. */
class Car extends GameObject {
  static components = [DirectionalSprite, ShadowCaster];
  _sheet = '';
  _volume = false;

  onSpawned({ sheet = 'hatch_rojo', facing = 0, look = null, hull = null } = {}) {
    const l = look ?? defaultLook(sheet);
    this._sheet = sheet;
    this._volume = castsVolume(l);
    this.setSpritesheet(sheet);
    anchorOn(this, sheet);
    this.directionalSprite.facing = facing;
    this.setAnimation('drive');
    applyLook(this, sheet, l, hull, facing);
  }

  onMessage(name, from, a, b) {
    onBenchMessage(this, name, a, b);
  }
}

/** One of the two trees: a single view. */
class Tree extends GameObject {
  static components = [SpriteRenderer, ShadowCaster];
  _sheet = 'arboles';
  _volume = false;

  onSpawned({ anim = 'arbol_verde', look = null } = {}) {
    this.setSpritesheet('arboles');
    anchorOn(this, 'arboles');
    this.setAnimation(anim);
    applyLook(this, 'arboles', look ?? defaultLook('arboles'), null, 0);
  }

  onMessage(name, from, a, b) {
    onBenchMessage(this, name, a, b);
  }
}

/** You: the LPC person, walking with WASD, facing where it walks. */
class Walker extends GameObject {
  static components = [DirectionalSprite, ShadowCaster];
  _sheet = 'civil7';
  _volume = false;

  onSpawned({ facing = Math.PI / 2, look = null } = {}) {
    this.setSpritesheet('civil7');
    anchorOn(this, 'civil7');
    this.directionalSprite.facing = facing;
    this.directionalSprite.facingFrom = 'velocity';
    this.setAnimation('idle');
    applyLook(this, 'civil7', look ?? defaultLook('civil7'), null, facing);
  }

  onMessage(name, from, a, b) {
    onBenchMessage(this, name, a, b);
  }

  tick(dtRatio) {
    let dx = 0;
    let dy = 0;
    if (Keyboard.isDown('a') || Keyboard.isDown('arrowleft')) dx -= 1;
    if (Keyboard.isDown('d') || Keyboard.isDown('arrowright')) dx += 1;
    if (Keyboard.isDown('w') || Keyboard.isDown('arrowup')) dy -= 1;
    if (Keyboard.isDown('s') || Keyboard.isDown('arrowdown')) dy += 1;
    const moving = dx !== 0 || dy !== 0;
    if (moving) {
      const k = (1.6 * (dtRatio || 1)) / Math.sqrt(dx * dx + dy * dy);
      this.x = Math.min(W - 20, Math.max(20, this.x + dx * k));
      this.y = Math.min(H - 10, Math.max(40, this.y + dy * k * FLOOR_SCALE_Y));
    }
    this.setAnimation(moving ? 'walk' : 'idle');
    // Still: no breathing either, so two captures show the same frame.
    this.setAnimationSpeed(moving ? 0.18 : STILL ? 0 : 0.05);
  }
}

/** A lamp (a sphere of light) at a height, that walks a slow circle unless the scene is still or its circle is 0. */
class Lamp extends GameObject {
  static components = [Collider, LightEmitter];
  cx = 0;
  cy = 0;
  r = 0;
  phase = 0;

  onSpawned({ cx = 0, cy = 0, r = 0, phase = 0, color = 0xffcf8a, elevation = 75, reach = 330, brightness = 1.4, castShadows = true } = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 4;
    Object.assign(this.lightEmitter, { color, radius: reach, elevation, brightness, castShadows });
    this.cx = cx;
    this.cy = cy;
    this.r = r;
    this.phase = phase;
    this.setPosition(cx + Math.cos(phase) * r, cy + Math.sin(phase) * r * FLOOR_SCALE_Y);
  }

  onMessage(name, from, a, b) {
    if (name !== 'move') return;
    this.cx = a;
    this.cy = b;
    this.setPosition(a + Math.cos(this.phase) * this.r, b + Math.sin(this.phase) * this.r * FLOOR_SCALE_Y);
  }

  tick(dtRatio, dt) {
    if (STILL || this.r === 0) return;
    this.phase += (dt || 16.7) * 0.0003;
    this.setPosition(this.cx + Math.cos(this.phase) * this.r, this.cy + Math.sin(this.phase) * this.r * FLOOR_SCALE_Y);
  }
}

// The prototype's farm: where each thing stands (x, screen y) and the trees and lamps.
const FARM = [
  ['granero', 330, 360], ['gallinero', 1000, 300], ['aljibe', 700, 300], ['cerca', 560, 520], ['cerca', 760, 540],
  ['mesa', 900, 560], ['cama', 1110, 470], ['sillon', 1080, 640], ['biblioteca', 1250, 420], ['vaca', 470, 690],
  ['pickup_blanco', 780, 770], ['hatch_rojo', 300, 790], ['colectivo_amarillo', 1220, 820],
];
const TREES = [[600, 360, 0], [880, 380, 1], [1380, 600, 0], [140, 560, 1], [980, 900, 0]];

/** What the panel can add. */
const ADDABLE = [
  ['granero', 'barn (prop)'], ['gallinero', 'hen house (prop)'], ['aljibe', 'well (prop)'], ['cerca', 'fence (prop)'],
  ['mesa', 'table (prop)'], ['cama', 'bed (prop)'], ['sillon', 'sofa (prop)'], ['biblioteca', 'bookcase (prop)'],
  ['vaca', 'cow (prop)'], ['hatch_rojo', 'hatchback (car)'], ['pickup_blanco', 'pickup (car)'], ['colectivo_amarillo', 'bus (car)'],
  ['taxi', 'taxi (car)'], ['camion_rojo', 'truck (car)'],
  ['tree:arbol_verde', 'green tree'], ['tree:arbol_jacaranda', 'jacaranda'],
];

const LAMP_COLORS = [
  [0xffcf8a, 'warm'], [0x9ec3ff, 'cold'], [0xffffff, 'white'], [0xff6a3d, 'red-orange'], [0x8dff9a, 'green'],
];

const KEYS_TEXT = [
  'WASD      walk the person',
  'click     select a thing or a lamp\'s dot; drag: move it',
  'Q / E     turn the selected (a prop 32 views, a car 48)',
  'Delete    remove the selected   Esc  select nothing',
  'B         the selected\'s shadows off / back',
  'N         the selected\'s normals: auto, map, height, flat',
  'V         the selected\'s self-shadow: auto, on, off',
  'I         the selected glows (emissive) or not',
  'J         next hour (10, 16, 18:30, 22)   Z / X  hour -/+',
  'Space     the day cycle on / off',
  'K         lamps on / off',
  'M  U  O   maps, sun map / cards, self-shadow (reload)',
  'L  P  R   lamps\' map / stamps, pixel depth, resolution (reload)',
  'G         flat view (pitch 90) / oblique (reload)',
  'H         hide the panel   wheel: zoom   right drag: pan',
].join('\n');

const RESOLUTIONS = [1, 0.5, 0.25];

/** A turn of one view: a prop's sheet has 32, a car's 48 (TopDown Vehicles: 7.5° steps, half drawn, half mirrored). */
function turnStep(kind) {
  return (kind === 'car' ? 7.5 : 11.25) * DEG;
}

export class LightBenchScene extends Scene {
  static config = {
    worldWidth: W,
    worldHeight: H,
    seed: 0x1b,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 8, noLimitFPS: false },
    logic: { numberOfLogicWorkers: 1, noLimitFPS: false },
    physics: { subStepCount: 1, gravity: { x: 0, y: 0 }, noLimitFPS: false },
    particle: { maxParticles: 0, decals: false },
    // Pixel art: the atlas sampled nearest (a car drawn at twice its sheet stays crisp, sprites snap to the pixel).
    renderer: { backend: BACKEND, ySort: true, noLimitFPS: false, atlasScaleMode: 'nearest', ...(DEPTH !== null ? { pixelDepth: DEPTH } : {}) },
    camera: {
      pitch: PITCH,
      ...(FLOOR !== null ? { floorScaleY: FLOOR } : {}),
      ...(HEIGHT !== null ? { heightScaleY: HEIGHT } : {}),
    },
    // The grass under the sprite shadows' layer (zIndex 2), so both kinds of sun shadow show on it.
    layers: { ground: { kind: LAYER_KIND.TILING, texture: 'pasto', tileScale: 1, parallax: 1, zIndex: 0 } },
    lighting: {
      enabled: true,
      baseAmbient: AMBIENT,
      maxLights: 16,
      // Room for the box or hull looks the panel offers (every prop and car at once; a hull up to 24 points).
      maxVolumes: 64,
      maxVolumeVerts: 24,
      // The light pass, the shadows' layer and the sun's map at the canvas's own size: sharp shadow edges (the owner's
      // ask; their cost is measured later).
      resolution: RES,
      shadowResolution: RES,
      shadowsEnabled: true,
      sunShadows: SUN_MAP ? 'map' : 'sprite',
      footprintSolids: SWEEP,
      lampShadows: LAMP_MAP ? 'map' : 'sprite',
      selfShadow: SELF,
      keyedCasters: !FULL_ROWS,
      // Shadows as dark as the light bench prototype's (about 60 % darker than the sunlit floor at 16 h): a strong shadow
      // alpha, and no lightening of long shadows.
      sun: {
        enabled: true, angle: 215, elevation: 45, intensity: 1, startHour: HOUR, dayCycle: { enabled: false },
        shadowAlpha: 0.7, shadowStretchAlphaFactor: 0,
      },
    },
  };

  static assets = {
    spritesheets,
    textures: { pasto: `${DIR}pasto.png` },
  };

  // Room for what the panel adds, and for an element spawned again while the old one goes.
  static entities = [[Prop, 48], [Car, 16], [Tree, 24], [Walker, 2], [Lamp, 16]];

  static messages = ['move', 'turn'];

  _panel = null;
  _overlay = null;
  _hour = HOUR;
  _cycle = CYCLE;
  _sunHeight = 90;
  _sunTurn = 0;
  _intensity = 1;
  /** Elements: { kind: 'prop'|'car'|'tree'|'char', sheet, anim, index, x, y, facing, look, off } */
  _elements = [];
  /** Lamps: { lamp: true, index, cx, cy, r, phase, color, radius, elevation, brightness, castShadows } */
  _lamps = [];
  _lampsOn = true;
  _selected = null;
  _drag = null;
  _pan = null;
  /** Each sheet's cell (w, h), how its json says it casts, and its hull points: read from the jsons the engine loaded. */
  _meta = {};
  _ui = null;
  _selSection = null;
  _readoutText = '';

  async create() {
    this._applySun();
    Camera.setZoom(ZOOM || Math.min(innerWidth / W, innerHeight / H));
    Camera.centerOn(CX || W / 2, CY || H / 2);
    await this._loadMeta();
    if (PANEL) {
      this._overlay = new BenchOverlay();
      this._buildPanel();
    }
  }

  createNewGame() {
    // The prototype turned each thing at random (its seed 7, Park-Miller): the same turns here.
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const [sheet, x, y] of FARM) {
      // The prototype's turn is counter-clockwise on the floor; a facing is the world's angle (clockwise, y down). A car's
      // turn is its heading; a prop's frame k is its model turned k steps, frame 0 at facing 90° (its sheet's stand table).
      const turn = Math.floor(rnd() * 360);
      const facing = (BENCH_ASSETS[sheet].kind === 'car' ? -turn : 90 - turn) * DEG;
      if (!wanted(sheet)) continue;
      this._addElement(BENCH_ASSETS[sheet].kind === 'car' ? 'car' : 'prop', sheet, null, x, y, facing);
    }
    if (wanted('arboles')) {
      for (const [x, y, v] of TREES) this._addElement('tree', 'arboles', v === 0 ? 'arbol_verde' : 'arbol_jacaranda', x, y, 0);
    }
    if (wanted('civil7')) this._addElement('char', 'civil7', null, 700, 620, Math.PI / 2);
    if (LAMPS) {
      this._addLamp({ cx: 640, cy: 470, r: STILL ? 0 : 60, color: 0xffcf8a, elevation: 75, radius: 330, brightness: 1.4, castShadows: true });
      this._addLamp({ cx: 1010, cy: 690, r: 0, color: 0x9ec3ff, elevation: 55, radius: 260, brightness: 1.2, castShadows: false });
    }
    this._refreshAll();
  }

  update(dtRatio, dt) {
    if (Keyboard.isPressed('m')) this._reload('maps', MAPS ? '0' : '1');
    if (Keyboard.isPressed('u')) this._reload('sun', SUN_MAP ? 'sprite' : 'map');
    if (Keyboard.isPressed('o')) this._reload('self', SELF ? '0' : '1');
    if (Keyboard.isPressed('l')) this._reload('lampMap', LAMP_MAP ? '0' : '1');
    if (Keyboard.isPressed('p')) this._reload('depth', DEPTH === false ? '1' : '0');
    if (Keyboard.isPressed('r')) this._reload('res', RESOLUTIONS[(RESOLUTIONS.indexOf(RES) + 1) % RESOLUTIONS.length]);
    if (Keyboard.isPressed('g')) this._reload('pitch', PITCH === 90 ? '47' : '90');
    if (Keyboard.isPressed('j')) this._nextHour();
    if (Keyboard.isPressed(' ')) this._setCycle(this._cycle > 0 ? 0 : 0.5);
    if (Keyboard.isPressed('k')) this._switchLamps(!this._lampsOn);
    if (Keyboard.isPressed('h') && this._panel) this._panel.toggle();
    if (Keyboard.isDown('z') || Keyboard.isDown('x')) {
      this._setHour(this._hour + (Keyboard.isDown('x') ? 1 : -1) * (dt || 16.7) * 0.002);
    } else if (this._cycle > 0 && !STILL) {
      this._setHour(this._hour + (dt || 16.7) * this._cycle * 0.001);
    }
    this._selectionKeys();
    if (PANEL) {
      this._mouse();
      this._drawMarks();
      this._refreshReadout();
    }
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // The sun
  // ---------------------------------------------------------------------------------------------------------------------

  /** Sun.setTimeOfDay for the hour, on the path the panel turned and raised, its intensity scaled. */
  _applySun() {
    Sun.maxElevation = this._sunHeight;
    Sun.shadowAngleOffset = Math.PI + this._sunTurn * DEG;
    Sun.setTimeOfDay(this._hour);
    if (this._intensity !== 1) Sun.intensity = Sun.intensity * this._intensity;
  }

  _setHour(h) {
    this._hour = ((h % 24) + 24) % 24;
    this._applySun();
    this._ui?.hour.set(Math.round(this._hour * 4) / 4);
    if (this._selected === null) this._refreshCode();
  }

  _nextHour() {
    const at = HOURS.indexOf(this._hour);
    this._setHour(HOURS[(at + 1) % HOURS.length]);
  }

  _setCycle(hoursPerSecond) {
    this._cycle = hoursPerSecond;
    this._ui?.cycle.set(hoursPerSecond);
    if (this._selected === null) this._refreshCode();
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Elements and lamps
  // ---------------------------------------------------------------------------------------------------------------------

  _addElement(kind, sheet, anim, x, y, facing) {
    const el = { kind, sheet, anim, index: -1, x, y, facing, look: defaultLook(sheet), off: null };
    this._elements.push(el);
    this._spawnElement(el);
    return el;
  }

  _spawnElement(el) {
    const meta = this._meta[el.sheet];
    const hull = meta?.hull ?? null;
    const look = normalizeLook(el.look, el.sheet, hull !== null);
    const usesHull = look.sun === 'hull' || look.lamps === 'hull';
    const cfg = { x: el.x, y: el.y, sheet: el.sheet, facing: el.facing, look, hull: usesHull ? hull : null };
    let go = null;
    if (el.kind === 'car') go = Car.spawn(cfg);
    else if (el.kind === 'tree') go = Tree.spawn({ x: el.x, y: el.y, anim: el.anim, look });
    else if (el.kind === 'char') go = Walker.spawn({ x: el.x, y: el.y, facing: el.facing, look });
    else go = Prop.spawn(cfg);
    el.index = go ? go.index : -1;
  }

  /** Where it stands now (the person walks), and where it looks, read back before it is spawned again. */
  _readBack(el) {
    const i = el.index;
    if (i < 0) return;
    el.x = Transform.x[i];
    el.y = Transform.y[i];
    if (el.kind === 'char') {
      const ax = DirectionalSprite.aimX[i];
      const ay = DirectionalSprite.aimY[i];
      el.facing = ax !== 0 || ay !== 0 ? Math.atan2(ay, ax) : DirectionalSprite.facing[i];
    }
  }

  /** A new look: the element spawned again with it (no setter takes a caster back to its sheet's way). */
  _setLook(el, patch) {
    el.look = { ...el.look, ...patch };
    this._readBack(el);
    if (el.index >= 0) GameObject.despawn(el.index);
    this._spawnElement(el);
    this._refreshAll();
  }

  _removeElement(el) {
    if (el.index >= 0) GameObject.despawn(el.index);
    this._elements.splice(this._elements.indexOf(el), 1);
    if (this._selected === el) this._select(null);
  }

  _turn(el, by) {
    if (el.kind !== 'prop' && el.kind !== 'car') return;
    el.facing += by;
    if (el.index >= 0) this.sendToEntity(el.index, 'turn', el.facing);
    this._ui?.facing?.set(Math.round(((((el.facing / DEG) % 360) + 360) % 360) * 10) / 10);
    this._refreshCode();
  }

  _addLamp(l) {
    const lamp = { lamp: true, index: -1, phase: 0, ...l };
    this._lamps.push(lamp);
    if (this._lampsOn) this._spawnLamp(lamp);
    return lamp;
  }

  _spawnLamp(l) {
    // Its place on the page at once (the marks read it), as onSpawned puts it.
    const go = Lamp.spawn({
      x: l.cx + Math.cos(l.phase) * l.r, y: l.cy + Math.sin(l.phase) * l.r * FLOOR_SCALE_Y,
      cx: l.cx, cy: l.cy, r: l.r, phase: l.phase, color: l.color, elevation: l.elevation, reach: l.radius,
      brightness: l.brightness, castShadows: l.castShadows,
    });
    l.index = go ? go.index : -1;
  }

  _setLamp(l, patch) {
    Object.assign(l, patch);
    if (l.index >= 0) GameObject.despawn(l.index);
    l.index = -1;
    if (this._lampsOn) this._spawnLamp(l);
    this._refreshAll();
  }

  _removeLamp(l) {
    if (l.index >= 0) GameObject.despawn(l.index);
    this._lamps.splice(this._lamps.indexOf(l), 1);
    if (this._selected === l) this._select(null);
  }

  _switchLamps(on) {
    this._lampsOn = on;
    for (const l of this._lamps) {
      if (on && l.index < 0) this._spawnLamp(l);
      else if (!on && l.index >= 0) {
        GameObject.despawn(l.index);
        l.index = -1;
      }
    }
    this._ui?.lampsOn.set(on);
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Selection, the mouse and the selection's keys
  // ---------------------------------------------------------------------------------------------------------------------

  _select(target) {
    if (this._selected === target) return;
    this._selected = target;
    this._buildSelected();
    this._refreshCode();
  }

  /** A lamp's bulb, in world px: its floor point raised by its elevation. */
  _bulb(l) {
    const x = l.index >= 0 ? Transform.x[l.index] : l.cx;
    const y = l.index >= 0 ? Transform.y[l.index] : l.cy;
    return { x, y: y - l.elevation * (HEIGHT ?? Math.cos(PITCH * DEG)) };
  }

  /** The world box an element covers on the screen: its footprint's circle and its height, or its cell. */
  _bounds(el) {
    const a = BENCH_ASSETS[el.sheet];
    const x = el.index >= 0 ? Transform.x[el.index] : el.x;
    const y = el.index >= 0 ? Transform.y[el.index] : el.y;
    if (a.box) {
      const b = a.box;
      const rad = Math.max(-b[0], b[1], -b[2], b[3]);
      return { left: x - rad, right: x + rad, top: y - rad * FLOOR_SCALE_Y - a.zmax * HEIGHT_SCALE_Y, bottom: y + rad * FLOOR_SCALE_Y };
    }
    const cell = this._meta[el.sheet]?.cell ?? { w: 64, h: 128 };
    const narrow = el.kind === 'tree' ? 0.7 : 0.5;
    return {
      left: x - cell.w * a.anchorX * narrow,
      right: x + cell.w * (1 - a.anchorX) * narrow,
      top: y - cell.h * a.anchorY,
      bottom: y + cell.h * (1 - a.anchorY) + 4,
    };
  }

  /** What is under a world point: a lamp's bulb first, then the element whose foot is nearest the camera. */
  _pick(x, y) {
    const near = 12 / (Camera.zoom || 1);
    for (const l of this._lamps) {
      const b = this._bulb(l);
      if ((b.x - x) ** 2 + (b.y - y) ** 2 <= near * near) return l;
    }
    let best = null;
    let bestFoot = -Infinity;
    for (const el of this._elements) {
      if (el.index < 0) continue;
      const r = this._bounds(el);
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const foot = Transform.y[el.index];
      if (foot > bestFoot) {
        bestFoot = foot;
        best = el;
      }
    }
    return best;
  }

  _mouse() {
    const mx = Mouse.x;
    const my = Mouse.y;
    if (Mouse.isButton0Pressed) {
      const hit = this._pick(mx, my);
      this._select(hit);
      if (hit !== null) {
        const at = hit.lamp ? { x: hit.cx, y: hit.cy } : { x: Transform.x[hit.index], y: Transform.y[hit.index] };
        this._drag = { target: hit, dx: at.x - mx, dy: at.y - my, x: at.x, y: at.y };
      }
    }
    const d = this._drag;
    if (d !== null) {
      if (!Mouse.isButton0Down) {
        this._drag = null;
      } else {
        const nx = Math.min(W, Math.max(0, mx + d.dx));
        const ny = Math.min(H, Math.max(0, my + d.dy));
        if (nx !== d.x || ny !== d.y) {
          d.x = nx;
          d.y = ny;
          const t = d.target;
          if (t.lamp) {
            t.cx = nx;
            t.cy = ny;
          } else {
            t.x = nx;
            t.y = ny;
          }
          if (t.index >= 0) this.sendToEntity(t.index, 'move', nx, ny);
        }
      }
    }
    // Right drag pans, the wheel zooms about the cursor (the panel keeps its own wheel).
    if (Mouse.isButton2Down) {
      const px = Mouse.canvasXAt(0);
      const py = Mouse.canvasYAt(0);
      if (this._pan !== null) {
        const z = Camera.zoom || 1;
        Camera.centerOn(Camera.centerX - (px - this._pan.x) / z, Camera.centerY - (py - this._pan.y) / z);
      }
      this._pan = { x: px, y: py };
    } else {
      this._pan = null;
    }
    const wheel = Mouse.wheel;
    if (wheel !== 0) {
      const z0 = Camera.zoom || 1;
      const z1 = Math.min(4, Math.max(Camera.minZoom || 0.1, z0 * Math.exp(-wheel * 0.0015)));
      const cx = Camera.centerX;
      const cy = Camera.centerY;
      Camera.setZoom(z1);
      Camera.centerOn(mx + ((cx - mx) * z0) / z1, my + ((cy - my) * z0) / z1);
    }
  }

  _selectionKeys() {
    const s = this._selected;
    if (s === null) return;
    if (Keyboard.isPressed('escape')) {
      this._select(null);
      return;
    }
    if (Keyboard.isPressed('delete') || Keyboard.isPressed('backspace')) {
      if (s.lamp) this._removeLamp(s);
      else this._removeElement(s);
      this._refreshAll();
      return;
    }
    if (s.lamp) return;
    // One of its views a press: a prop's 32 even steps; a car to its next frame (its directions are the headings its
    // frames are drawn at, not even), so every frame drawn shows on a turn.
    const press = Keyboard.isPressed('q') ? -1 : Keyboard.isPressed('e') ? 1 : 0;
    if (press !== 0) this._turn(s, s.kind === 'car' ? nextCarFacing(s.sheet, s.facing, press) - s.facing : press * turnStep(s.kind));
    if (Keyboard.isPressed('b')) {
      // Off, and back to what it was.
      if (s.off !== null) {
        const back = s.off;
        s.off = null;
        this._setLook(s, back);
      } else {
        s.off = { sun: s.look.sun, lamps: s.look.lamps };
        this._setLook(s, { sun: 'none', lamps: 'none' });
      }
    }
    if (Keyboard.isPressed('n')) this._setLook(s, { normals: NORMALS[(NORMALS.indexOf(s.look.normals) + 1) % NORMALS.length] });
    if (Keyboard.isPressed('v')) this._setLook(s, { self: SELF_SHADOWS[(SELF_SHADOWS.indexOf(s.look.self) + 1) % SELF_SHADOWS.length] });
    if (Keyboard.isPressed('i')) this._setLook(s, { emissive: !s.look.emissive });
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // The panel
  // ---------------------------------------------------------------------------------------------------------------------

  _reload(key, value) {
    this._reloadWith({ [key]: value });
  }

  /** Reloads with these knobs (null deletes one), keeping the hour. */
  _reloadWith(changes) {
    const p = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) p.delete(k);
      else p.set(k, String(v));
    }
    p.set('hour', String(Math.round(this._hour * 1000) / 1000));
    location.search = p.toString();
  }

  /** The jsons the engine loaded (from the browser's cache): each sheet's cell, how it casts, its hull. */
  async _loadMeta() {
    await Promise.all(Object.keys(BENCH_ASSETS).map(async (name) => {
      try {
        const res = await fetch(BENCH_ASSETS[name].json);
        const json = await res.json();
        const first = Object.values(json.frames ?? {})[0];
        this._meta[name] = {
          cell: first ? { w: first.frame.w, h: first.frame.h } : { w: 64, h: 128 },
          cast: json.meta?.light3d?.cast ?? null,
          hull: hullPoints(json.meta),
        };
      } catch {
        this._meta[name] = { cell: { w: 64, h: 128 }, cast: null, hull: null };
      }
    }));
  }

  _settings() {
    return {
      pitch: PITCH,
      floorScaleY: FLOOR,
      heightScaleY: HEIGHT,
      backend: BACKEND,
      depth: DEPTH,
      ambient: AMBIENT,
      resolution: RES,
      sunMap: SUN_MAP,
      lampMap: LAMP_MAP,
      self: SELF,
      sweep: SWEEP,
      maps: MAPS,
      hour: Math.round(this._hour * 100) / 100,
      sunHeight: this._sunHeight,
      sunTurn: this._sunTurn,
      intensity: this._intensity,
      cycle: this._cycle,
    };
  }

  _buildPanel() {
    const p = new BenchPanel('Light bench · DX-LIGHT3D');
    this._panel = p;
    const ui = {};
    this._ui = ui;
    const pct = (v) => v.toFixed(2);

    const scene = p.section('Scene (each change reloads)', { open: false });
    scene.range({
      label: 'Camera pitch', min: 0, max: 90, step: 1, value: PITCH, format: (v) => `${v}°`,
      note: 'camera.pitch: degrees from the horizon. 90 or 0 is a flat view (the 2D sweep: walls stop the lamps); anything ' +
        'between is oblique, the 3D light of this plan.',
      onChange: (v) => this._reload('pitch', v),
    });
    scene.range({
      label: 'Floor scale', min: 0.3, max: 1, step: 0.01, value: FLOOR ?? Math.sin(PITCH * DEG), format: pct,
      note: 'camera.floorScaleY: how tall the floor is drawn against its width (the art: 0.736). Light pools are ellipses.',
      onChange: (v) => this._reload('floor', v),
    });
    scene.range({
      label: 'Height scale', min: 0, max: 1, step: 0.01, value: HEIGHT ?? Math.cos(PITCH * DEG), format: pct,
      note: 'camera.heightScaleY: screen px that a px of height rises (the art: 0.752).',
      onChange: (v) => this._reload('height', v),
    });
    scene.buttons([
      { label: 'From the pitch', onClick: () => this._reloadWith({ floor: 'auto', height: 'auto' }) },
      { label: "The art's", onClick: () => this._reloadWith({ pitch: null, floor: null, height: null }) },
    ], 'Leave floor and height to the pitch (sin and cos), for art that follows the trigonometry; or back to the art\'s.');
    scene.range({
      label: 'Ambient', min: 0, max: 0.6, step: 0.01, value: AMBIENT, format: pct,
      note: 'lighting.baseAmbient: the light where neither the sun nor a lamp reaches.',
      onChange: (v) => this._reload('ambient', v),
    });
    scene.select({
      label: 'Order', value: DEPTH === null ? 'auto' : DEPTH ? '1' : '0',
      options: [['auto', 'pixel depth by itself'], ['1', 'pixel depth'], ['0', 'painter alone']],
      note: 'renderer.pixelDepth: where a sprite has a height map, each pixel\'s place on the floor corrects the painter (a ' +
        'person walking around a table). The painter alone draws back to front by the foot. [P]',
      onChange: (v) => this._reload('depth', v === 'auto' ? null : v),
    });
    scene.select({
      label: 'Light resolution', value: String(RES),
      options: [...new Set([String(RES), '1', '0.75', '0.5', '0.25'])].map((v) => [v, `× ${v}`]),
      note: 'lighting.resolution and shadowResolution: the light pass and the shadow maps against the canvas. Lower is ' +
        'cheaper and softer. [R]',
      onChange: (v) => this._reload('res', v),
    });
    scene.select({
      label: "Sun's shadows", value: SUN_MAP ? 'map' : 'sprite',
      options: [['map', 'shadow map'], ['sprite', 'cards (sprites)']],
      note: "lighting.sunShadows: 'map' takes out the sun alone and falls on what has height; 'sprite' draws cards on the " +
        "shadows' layer, darkening every light. [U]",
      onChange: (v) => this._reload('sun', v),
    });
    scene.select({
      label: "Lamps' shadows", value: LAMP_MAP ? 'map' : 'sprite',
      options: [['map', 'shadow map a lamp'], ['sprite', 'stamps']],
      note: "lighting.lampShadows: 'map' gives each lamp that casts a tile of its own: two lamps light each other's " +
        "shadows, and the height of the lamp (elevation) is in the shadow's length. [L]",
      onChange: (v) => this._reload('lampMap', v === 'map' ? '1' : '0'),
    });
    scene.toggle({
      label: 'Self-shadow', value: SELF,
      note: 'lighting.selfShadow: what has height shades itself and its neighbours (a roof over a wall, an arm over a body). [O]',
      onChange: (v) => this._reload('self', v ? '1' : '0'),
    });
    scene.toggle({
      label: 'Height and normal maps', value: MAPS,
      note: 'assets.spritesheets.*.heightMap / normalMap: twins of each sheet. Without them a sprite is lit flat. [M]',
      onChange: (v) => this._reload('maps', v ? '1' : '0'),
    });
    scene.toggle({
      label: 'Solids swept to their footprints', value: SWEEP,
      note: 'lighting.footprintSolids: a render with footprints casts its solid at each cell\'s height (light under a ' +
        'table), not columns down to the floor.',
      onChange: (v) => this._reload('sweep', v ? '1' : '0'),
    });
    scene.toggle({
      label: 'Full caster rows', value: FULL_ROWS,
      note: 'lighting.keyedCasters false: the keyed caster rows off, to compare (the same picture, more work).',
      onChange: (v) => this._reload('fullRows', v ? '1' : '0'),
    });
    scene.select({
      label: 'Backend', value: BACKEND, options: [['webgl', 'WebGL'], ['webgpu', 'WebGPU']],
      note: 'renderer.backend.',
      onChange: (v) => this._reload('backend', v),
    });

    const sun = p.section('Sun');
    ui.hour = sun.range({
      label: 'Hour', min: 0, max: 24, step: 0.25, value: Math.round(this._hour * 4) / 4,
      format: (v) => `${Math.floor(v)}:${String(Math.round((v - Math.floor(v)) * 60)).padStart(2, '0')}`,
      note: "Sun.setTimeOfDay(hour): the sun's direction, height, intensity and colour as the day goes. [J] [Z/X]",
      onInput: (v) => this._setHour(v),
    });
    ui.cycle = sun.range({
      label: 'Day cycle', min: 0, max: 2, step: 0.05, value: this._cycle, format: (v) => (v === 0 ? 'stopped' : `${v} h/s`),
      note: 'Hours a second: the bench calls Sun.setTimeOfDay each frame (a scene can use lighting.sun.dayCycle). [Space]',
      onInput: (v) => this._setCycle(v),
    });
    sun.range({
      label: 'Direction', min: -180, max: 180, step: 5, value: this._sunTurn, format: (v) => `${v}°`,
      note: "Sun.shadowAngleOffset: the sun's path turned about the vertical; every shadow turns with it.",
      onInput: (v) => {
        this._sunTurn = v;
        this._applySun();
        this._refreshCode();
      },
    });
    sun.range({
      label: 'Height at noon', min: 10, max: 90, step: 1, value: this._sunHeight, format: (v) => `${v}°`,
      note: 'Sun.maxElevation: how high the sun climbs; lower, and every shadow is longer all day.',
      onInput: (v) => {
        this._sunHeight = v;
        this._applySun();
        this._refreshCode();
      },
    });
    sun.range({
      label: 'Intensity', min: 0, max: 1.5, step: 0.05, value: this._intensity, format: (v) => `× ${v.toFixed(2)}`,
      note: "Sun.intensity after setTimeOfDay, times this: the sunlight, and how dark its shadows are.",
      onInput: (v) => {
        this._intensity = v;
        this._applySun();
        this._refreshCode();
      },
    });

    const lamps = p.section('Lamps');
    lamps.buttons([
      {
        label: 'Add a lamp',
        onClick: () => {
          const l = this._addLamp({
            cx: Camera.centerX, cy: Camera.centerY, r: 0, color: 0xffcf8a, elevation: 80, radius: 300, brightness: 1.3,
            castShadows: true,
          });
          this._select(l);
        },
      },
    ], 'LightEmitter: a sphere of light at its elevation. Click a lamp\'s dot to select it, drag it to move it.');
    ui.lampsOn = lamps.toggle({
      label: 'Lamps on', value: this._lampsOn,
      note: 'All the lamps out and back, to compare. [K]',
      onChange: (v) => this._switchLamps(v),
    });

    const add = p.section('Elements');
    let pick = ADDABLE[0][0];
    add.select({
      label: 'Thing', value: pick, options: ADDABLE,
      note: 'The prototype\'s farm: props rendered from 32 directions, cars (half a turn, mirrored), trees of one view.',
      onChange: (v) => {
        pick = v;
      },
    });
    add.buttons([{ label: 'Add it', onClick: () => this._addPicked(pick) }],
      'At the middle of the view. Click a thing to select it, drag it to move it; Q/E turn it; Delete removes it.');

    this._selSection = p.section('Selected');
    const code = p.section('Code');
    p.codeBox(code);
    const keys = p.section('Keys', { open: false });
    keys.pre(KEYS_TEXT);
    this._buildSelected();
    this._refreshCode();
  }

  _addPicked(value) {
    let el;
    if (value.startsWith('tree:')) {
      el = this._addElement('tree', 'arboles', value.slice(5), Camera.centerX, Camera.centerY, 0);
    } else {
      const car = BENCH_ASSETS[value].kind === 'car';
      el = this._addElement(car ? 'car' : 'prop', value, null, Camera.centerX, Camera.centerY, car ? 0 : Math.PI / 2);
    }
    this._select(el);
    this._refreshAll();
  }

  /** The selected section: what the selection is, and its controls. */
  _buildSelected() {
    const s = this._selSection;
    if (!s) return;
    s.clear();
    const t = this._selected;
    if (t === null) {
      s.summary.textContent = 'Selected: nothing';
      s.text('Click a thing or a lamp\'s dot. With nothing selected, the code box shows the scene\'s config.');
      return;
    }
    if (t.lamp) {
      this._buildSelectedLamp(s, t);
      return;
    }
    const a = BENCH_ASSETS[t.sheet];
    const meta = this._meta[t.sheet];
    const what = { prop: 'prop, 32 views', car: 'car, 48 views: half a turn mirrored', tree: 'tree, one view', char: 'the person, 4 views' }[t.kind];
    s.summary.textContent = `Selected: ${t.anim ?? t.sheet} (${what})`;
    const ui = this._ui;
    if (t.kind === 'prop' || t.kind === 'car') {
      ui.facing = s.range({
        label: 'Facing', min: 0, max: 360, step: turnStep(t.kind) / DEG, value: Math.round(((((t.facing / DEG) % 360) + 360) % 360) * 10) / 10,
        format: (v) => `${v}°`,
        note: 'directionalSprite.facing: where it looks, world radians like rotation (90° looks at the camera). It draws ' +
          'the view it faces, and each light\'s shadow the view that light sees. [Q/E]',
        onInput: (v) => this._turn(t, v * DEG - t.facing),
      });
    } else {
      ui.facing = null;
    }
    const hasBox = boxOf(t.sheet) !== null;
    const hasHull = meta?.hull != null;
    const kindOptions = (list) => list.map((k) => [k, k === 'auto' ? `${KIND_NAMES.auto} (${this._autoName(t, list === SUN_KINDS ? 'sun' : 'lamp')})` : KIND_NAMES[k]]);
    const look = normalizeLook(t.look, t.sheet, hasHull);
    const sunSel = s.select({
      label: 'Shadow with the sun', value: look.sun, options: kindOptions(SUN_KINDS),
      note: 'shadowCaster.sun.setSprite() (its silhouette), .setHeightMap() (each pixel in 3D), .setBox / .setHull (a volume), ' +
        '.clear(). The last setter wins; the same for both kinds is shadowCaster.setX().',
      onChange: (v) => this._setLook(t, { sun: v }),
    });
    const lampSel = s.select({
      label: 'Shadow with lamps', value: look.lamps, options: kindOptions(LAMP_KINDS),
      note: 'shadowCaster.lamps.*: the same for the lamps and headlights. A wall (setWall) stops them in a flat view ' +
        '(pitch 90 or 0). One volume an entity: a box and a hull share it.',
      onChange: (v) => this._setLook(t, { lamps: v }),
    });
    for (const sel of [sunSel, lampSel]) {
      sel.enable('box', hasBox);
      sel.enable('hull', hasHull);
    }
    s.select({
      label: 'Card orientation', value: look.orient, options: ORIENTS.map((o) => [o, o === 'light' ? 'faces each light' : 'fixed, along it']),
      note: "setSprite({ orient: 'fixed' }): the silhouette's card stands along the object, face on, for every light (a fence, " +
        'a wall); by default it faces each light.',
      onChange: (v) => this._setLook(t, { orient: v }),
    });
    s.select({
      label: 'Self-shadow', value: look.self, options: SELF_SHADOWS.map((o) => [o, o === 'auto' ? "its sheet's way" : o]),
      note: 'shadowCaster.selfShadow: whether it shades itself (a render with a footprint does by default, one view does ' +
        'not). Needs lighting.selfShadow. [V]',
      onChange: (v) => this._setLook(t, { self: v }),
    });
    s.select({
      label: 'Normals', value: look.normals,
      options: NORMALS.map((o) => [o, { auto: 'auto (map, else height)', map: 'its normal map', height: 'from its height map', flat: 'flat' }[o]]),
      note: "spriteRenderer.normals: where its light comes from. 'auto' takes the normal map, else the height map's slopes; " +
        "LPC people look better with 'height'. [N]",
      onChange: (v) => this._setLook(t, { normals: v }),
    });
    s.range({
      label: 'Base radius', min: 0, max: 60, step: 1, value: look.base, format: (v) => (v === 0 ? 'measured' : `${v} px`),
      note: 'shadowCaster.baseRadius: corrects the base the engine measures from its frame (the trunk\'s circle, the feet\'s ' +
        'ellipse, the support nearest the light); 0 keeps the measured one.',
      onChange: (v) => this._setLook(t, { base: v }),
    });
    s.range({
      label: 'Opacity', min: 0, max: 1, step: 0.05, value: look.opacity, format: (v) => `${Math.round(v * 100)} %`,
      note: 'shadowCaster.opacity: how much light it takes out (was LightOccluder.block).',
      onChange: (v) => this._setLook(t, { opacity: v }),
    });
    s.toggle({
      label: 'Emissive', value: look.emissive,
      note: 'spriteRenderer.emissive: it glows, no night or shadow darkens it, and what stands in front still hides it. [I]',
      onChange: (v) => this._setLook(t, { emissive: v }),
    });
    s.buttons([
      { label: "Its sheet's way", onClick: () => this._setLook(t, defaultLook(t.sheet)) },
      {
        label: 'Delete',
        onClick: () => {
          this._removeElement(t);
          this._refreshAll();
        },
      },
    ], `A change spawns it again with the new look. Anchor ${a.anchorX}, ${a.anchorY}.`);
  }

  /** What its sheet's way casts for a kind of light, for the 'auto' option's name. */
  _autoName(el, light) {
    const asset = BENCH_ASSETS[el.sheet];
    if (!MAPS || !asset.maps || el.kind === 'tree' || el.kind === 'char') return 'silhouette';
    const cast = this._meta[el.sheet]?.cast?.[light];
    return cast === 'sprite' ? 'silhouette' : 'solid';
  }

  _buildSelectedLamp(s, l) {
    s.summary.textContent = 'Selected: a lamp';
    s.select({
      label: 'Colour', value: String(l.color),
      options: [...LAMP_COLORS.map(([c, n]) => [String(c), n]), ...(LAMP_COLORS.some(([c]) => c === l.color) ? [] : [[String(l.color), 'its own']])],
      note: 'lightEmitter.color.',
      onChange: (v) => this._setLamp(l, { color: Number(v) }),
    });
    s.range({
      label: 'Reach', min: 60, max: 900, step: 10, value: l.radius, format: (v) => `${v} px`,
      note: 'lightEmitter.radius: how far it reaches on the floor (full at its centre, about 1 % at the radius).',
      onChange: (v) => this._setLamp(l, { radius: v }),
    });
    s.range({
      label: 'Elevation', min: 0, max: 300, step: 5, value: l.elevation, format: (v) => `${v} px`,
      note: "lightEmitter.elevation: the bulb's real height. In an oblique scene it is in the shadows' geometry: high, short " +
        'shadows; low, long ones.',
      onChange: (v) => this._setLamp(l, { elevation: v }),
    });
    s.range({
      label: 'Brightness', min: 0, max: 3, step: 0.05, value: l.brightness, format: (v) => v.toFixed(2),
      note: 'lightEmitter.brightness: times its colour.',
      onChange: (v) => this._setLamp(l, { brightness: v }),
    });
    s.toggle({
      label: 'Casts shadows', value: l.castShadows,
      note: "lightEmitter.castShadows: its own shadow map with lampShadows: 'map' (or stamps); off, it lights and casts " +
        'nothing, which costs less.',
      onChange: (v) => this._setLamp(l, { castShadows: v }),
    });
    s.range({
      label: 'Circle', min: 0, max: 200, step: 5, value: l.r, format: (v) => (v === 0 ? 'still' : `${v} px`),
      note: 'The bench moves it on a slow circle of this radius (setPosition each tick), to watch its shadows turn.',
      onChange: (v) => this._setLamp(l, { r: v }),
    });
    s.buttons([
      {
        label: 'Delete',
        onClick: () => {
          this._removeLamp(l);
          this._refreshAll();
        },
      },
    ], 'A change spawns the lamp again with it.');
  }

  _refreshAll() {
    if (!this._panel) return;
    this._buildSelected();
    this._refreshCode();
  }

  _refreshCode() {
    if (!this._panel) return;
    const t = this._selected;
    let text;
    if (t === null) text = sceneCode(this._settings());
    else if (t.lamp) text = lampCode(t);
    else {
      const meta = this._meta[t.sheet];
      text = elementCode({ ...t, cast: meta?.cast ?? null, hull: meta?.hull ?? null }, { maps: MAPS });
    }
    this._panel.setCode(text);
  }

  _refreshReadout() {
    if (!this._panel || !this._panel.visible) return;
    const h = Math.floor(this._hour);
    const m = Math.floor((this._hour - h) * 60);
    // Where the shadows fall, on the floor (world degrees: 90 is towards the camera), from the sun's shadow direction.
    const toward = Math.round((((Math.atan2(Sun.shadowDirY, Sun.shadowDirX) / DEG) % 360) + 360) % 360);
    const text =
      `${h}:${String(m).padStart(2, '0')}   sun ${Math.round(Sun.elevation)}° high, intensity ${Sun.intensity.toFixed(2)}, ` +
      `shadows toward ${toward}°\nWASD walks the person; click a thing or a lamp's dot`;
    if (text !== this._readoutText) {
      this._readoutText = text;
      this._panel.readout.textContent = text;
    }
  }

  /** The marks: a dashed box on the selected element, a dot on each lamp's bulb. */
  _drawMarks() {
    const o = this._overlay;
    if (!o) return;
    if (!this._panel.visible) {
      o.showBox(null);
      o.showDots([]);
      return;
    }
    const canvas = this.game?.canvas;
    const rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
    const sx = rect.width / (Camera.canvasWidth || rect.width || 1);
    const sy = rect.height / (Camera.canvasHeight || rect.height || 1);
    const toPage = (x, y) => {
      const s = Camera.worldToScreen(x, y);
      return { x: rect.left + s.x * sx, y: rect.top + s.y * sy };
    };
    const t = this._selected;
    if (t !== null && !t.lamp && t.index >= 0) {
      const b = this._bounds(t);
      const p0 = toPage(b.left, b.top);
      const p1 = toPage(b.right, b.bottom);
      o.showBox({ left: p0.x, top: p0.y, right: p1.x, bottom: p1.y }, t.anim ?? t.sheet);
    } else {
      o.showBox(null);
    }
    const dots = [];
    for (const l of this._lamps) {
      const p = toPage(this._bulb(l).x, this._bulb(l).y);
      dots.push({ x: p.x, y: p.y, color: l.color, selected: l === t, on: l.index >= 0 && l.brightness > 0 });
    }
    o.showDots(dots);
  }

  async destroy() {
    this._panel?.remove();
    this._overlay?.remove();
    this._panel = null;
    this._overlay = null;
    await super.destroy();
  }
}
