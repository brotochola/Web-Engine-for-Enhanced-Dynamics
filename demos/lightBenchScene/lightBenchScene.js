// The light bench (DX-LIGHT3D's showcase): the light bench prototype's farm with the engine's API. Quaternius props
// rendered from 32 directions, MinZinn cars (half a turn, mirrored), two trees and an LPC person you walk with WASD, each
// with its height map and normal map (assets/: tools/fromLightBench.mjs converts the prototype's files). The props and
// cars are DirectionalSprites: they show the view they face, and each light's shadow shows the view that light sees.
// The panel's keys reload the scene with a part on or off, to compare.
//
//   ?maps=0       no height or normal maps (lit as the floor, as before)
//   ?sun=sprite   the sun's shadows as sprites on the shadows' layer, instead of its shadow map
//   ?self=0       no self-shadow
//   ?hour=        the sun's hour (default 16)
//   ?still=1      nothing moves (the lamps stay, the person stands without breathing): for captures
//   ?zoom= ?cx= ?cy=  the camera (default: the whole farm); ?panel=0 hides the panel (captures)
//   ?only=hatch,arboles,civil7  only those things (none: the grass alone); ?lamps=0 no lamps (captures, checks)
//   ?backend=webgpu
//   ?fullRows=1   the shadows from pre-render's full caster rows (lighting.shadowTextures: the keyed paths off), to compare
//   ?lampMap=0    the lamps' shadows as stamps, instead of the lamps' shadow map (one tile a lamp)
//   ?sweep=1      the heightmap casters' solids swept north to their footprints (being fixed)

import WEED from '/src/index.js';
import { SunPanel } from '../sunStreetScene/sunPanel.js';
import { BENCH_ASSETS } from './assets/index.js';

const { Scene, GameObject, Collider, DirectionalSprite, ShadowCaster, LightEmitter, Camera, Sun, Keyboard, SpriteRenderer,
  LAYER_KIND, enums } = WEED;
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
// ?sweep=1: lighting.footprintSolids, the heightmap casters' solids swept north to their footprints (being fixed).
const SWEEP = param('sweep') === '1';
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

const spritesheets = {};
for (const [name, a] of Object.entries(BENCH_ASSETS)) {
  spritesheets[name] = { json: `${DIR}${name}.json`, png: `${DIR}${name}.png` };
  if (MAPS && a.maps) Object.assign(spritesheets[name], { heightMap: `${DIR}${name}_h.png`, normalMap: `${DIR}${name}_n.png` });
}

/** Anchors each sheet's cells share (the converter put every frame's foot there). */
function anchorOn(go, sheet) {
  const a = BENCH_ASSETS[sheet];
  go.spriteRenderer.anchorX = a.anchorX;
  go.spriteRenderer.anchorY = a.anchorY;
}

/** A farm prop rendered from 32 directions, turned as it faces. */
class Prop extends GameObject {
  static components = [DirectionalSprite, ShadowCaster];

  onSpawned({ sheet = 'mesa', facing = 0 } = {}) {
    this.setSpritesheet(sheet);
    anchorOn(this, sheet);
    this.directionalSprite.facing = facing;
    this.setAnimation('stand');
  }
}

/** A car: half a turn drawn, the other half mirrored. */
class Car extends GameObject {
  static components = [DirectionalSprite, ShadowCaster];

  onSpawned({ sheet = 'hatch', facing = 0 } = {}) {
    this.setSpritesheet(sheet);
    anchorOn(this, sheet);
    this.directionalSprite.facing = facing;
    this.setAnimation('drive');
  }
}

/** One of the two trees: a single view. */
class Tree extends GameObject {
  static components = [SpriteRenderer, ShadowCaster];

  onSpawned({ kind = 'arbol_verde' } = {}) {
    this.setSpritesheet('arboles');
    anchorOn(this, 'arboles');
    this.setAnimation(kind);
  }
}

/** You: the LPC person, walking with WASD, facing where it walks. */
class Walker extends GameObject {
  static components = [DirectionalSprite, ShadowCaster];

  onSpawned() {
    this.setSpritesheet('civil7');
    anchorOn(this, 'civil7');
    this.directionalSprite.facingFrom = 'velocity';
    this.setAnimation('idle');
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

/** A lamp (a sphere of light) at a height, that walks a slow circle unless the scene is still. */
class Lamp extends GameObject {
  static components = [Collider, LightEmitter];

  onSpawned({ cx = 0, cy = 0, r = 0, phase = 0, color = 0xffcf8a, elevation = 75, radius = 330, brightness = 1.4, castShadows = true } = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 4;
    Object.assign(this.lightEmitter, { color, radius, elevation, brightness, castShadows });
    this.cx = cx;
    this.cy = cy;
    this.r = r;
    this.phase = phase;
    this.setPosition(cx + Math.cos(phase) * r, cy + Math.sin(phase) * r * FLOOR_SCALE_Y);
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
  ['pickup', 780, 770], ['hatch', 300, 790], ['colectivo', 1220, 820],
];
const TREES = [[600, 360, 0], [880, 380, 1], [1380, 600, 0], [140, 560, 1], [980, 900, 0]];

export class LightBenchScene extends Scene {
  static config = {
    worldWidth: W,
    worldHeight: H,
    seed: 0x1b,
    spatial: { numberOfSpatialWorkers: 1, cellSize: 128, maxNeighbors: 8, noLimitFPS: false },
    logic: { numberOfLogicWorkers: 1, noLimitFPS: false },
    physics: { subStepCount: 1, gravity: { x: 0, y: 0 }, noLimitFPS: false },
    particle: { maxParticles: 0, decals: false },
    renderer: { backend: BACKEND, ySort: true, noLimitFPS: false },
    camera: { pitch: 47, floorScaleY: FLOOR_SCALE_Y, heightScaleY: HEIGHT_SCALE_Y },
    // The grass under the sprite shadows' layer (zIndex 2), so both kinds of sun shadow show on it.
    layers: { ground: { kind: LAYER_KIND.TILING, texture: 'pasto', tileScale: 1, parallax: 1, zIndex: 0 } },
    lighting: {
      enabled: true,
      baseAmbient: 0.12,
      maxLights: 16,
      // The light pass, the shadows' layer and the sun's map at the canvas's own size: sharp shadow edges (the owner's
      // ask; their cost is measured later).
      resolution: 1,
      shadowResolution: 1,
      shadowsEnabled: true,
      sunShadows: SUN_MAP ? 'map' : 'sprite',
      footprintSolids: SWEEP,
      lampShadows: LAMP_MAP ? 'map' : 'sprite',
      selfShadow: SELF,
      shadowTextures: FULL_ROWS,
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

  static entities = [[Prop, 16], [Car, 4], [Tree, 8], [Walker, 1], [Lamp, 4]];

  _panel = null;
  _hour = HOUR;

  create() {
    Sun.setTimeOfDay(this._hour);
    Camera.setZoom(ZOOM || Math.min(innerWidth / W, innerHeight / H));
    Camera.centerOn(CX || W / 2, CY || H / 2);
    this._panel = new SunPanel([
      { key: 'm', keyName: 'M', label: 'Maps', note: 'assets.spritesheets.*.heightMap / normalMap: lit as the surfaces they are (reloads)', press: () => this._reload('maps', MAPS ? '0' : '1') },
      { key: 'u', keyName: 'U', label: "Sun's shadows", note: "lighting.sunShadows: 'map' takes out the sun alone and falls on heights; 'sprite' draws them on the shadows' layer (reloads)", press: () => this._reload('sun', SUN_MAP ? 'sprite' : 'map') },
      { key: 'o', keyName: 'O', label: 'Self-shadow', note: 'lighting.selfShadow: what has height shades itself from the sun (reloads)', press: () => this._reload('self', SELF ? '0' : '1') },
      { key: 'j', keyName: 'J', label: 'Hour', note: 'Sun.setTimeOfDay: 10, 16, 18:30 and 22 h (the lamps at night)', press: () => this._nextHour() },
    ]);
    if (!PANEL) this._panel.el.style.display = 'none';
    this._showStates();
  }

  createNewGame() {
    // The prototype turned each thing at random (its seed 7, Park-Miller): the same turns here.
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const [sheet, x, y] of FARM) {
      // The prototype's turn is counter-clockwise on the floor; a facing is the world's angle (clockwise, y down).
      const facing = -Math.floor(rnd() * 360) * DEG;
      if (!wanted(sheet)) continue;
      if (BENCH_ASSETS[sheet].kind === 'car') Car.spawn({ x, y, sheet, facing });
      else Prop.spawn({ x, y, sheet, facing });
    }
    if (wanted('arboles')) for (const [x, y, v] of TREES) Tree.spawn({ x, y, kind: v === 0 ? 'arbol_verde' : 'arbol_jacaranda' });
    if (wanted('civil7')) Walker.spawn({ x: 700, y: 620 });
    if (!LAMPS) return;
    Lamp.spawn({ cx: 640, cy: 470, r: STILL ? 0 : 60, color: 0xffcf8a, elevation: 75, radius: 330, brightness: 1.4, castShadows: true });
    Lamp.spawn({ cx: 1010, cy: 690, r: 0, color: 0x9ec3ff, elevation: 55, radius: 260, brightness: 1.2, castShadows: false });
  }

  update() {
    if (Keyboard.isPressed('m')) this._reload('maps', MAPS ? '0' : '1');
    if (Keyboard.isPressed('u')) this._reload('sun', SUN_MAP ? 'sprite' : 'map');
    if (Keyboard.isPressed('o')) this._reload('self', SELF ? '0' : '1');
    if (Keyboard.isPressed('j')) this._nextHour();
  }

  _nextHour() {
    const at = HOURS.indexOf(this._hour);
    this._hour = HOURS[(at + 1) % HOURS.length];
    Sun.setTimeOfDay(this._hour);
    this._showStates();
  }

  _reload(key, value) {
    const p = new URLSearchParams(location.search);
    p.set(key, value);
    p.set('hour', String(this._hour));
    location.search = p.toString();
  }

  _showStates() {
    if (!this._panel) return;
    this._panel.readout.textContent = 'WASD: walk   (DirectionalSprite: each light sees its own view of every thing)';
    this._panel.show('m', MAPS ? 'on' : 'off');
    this._panel.show('u', SUN_MAP ? 'shadow map' : 'sprites');
    this._panel.show('o', SELF ? 'on' : 'off');
    const h = Math.floor(this._hour);
    this._panel.show('j', `${h}:${String(Math.round((this._hour - h) * 60)).padStart(2, '0')}`);
  }
}
