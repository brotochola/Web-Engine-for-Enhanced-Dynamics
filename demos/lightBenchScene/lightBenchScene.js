// The light bench (DX-LIGHT3D's showcase): what the light bench prototype tried, with the engine's API. A person you walk
// with WASD (DirectionalSprite: it faces where it goes, and its sun shadow is the frame the sun sees), ray-traced shapes
// with height and normal maps (lit as the surfaces they are), lamps that wander, the sun's shadow map and self-shadow.
// The panel's keys reload the scene with a part on or off, to compare.
//
//   ?maps=0       the shapes without their maps (lit as the floor, as before)
//   ?sun=sprite   the sun's shadows as skewed sprites (the default before), instead of its shadow map
//   ?self=0       no self-shadow
//   ?hour=        the sun's hour (default 16)

import WEED from '/src/index.js';
import { SunPanel } from '../sunStreetScene/sunPanel.js';

const { Scene, GameObject, Collider, SpriteRenderer, DirectionalSprite, ShadowCaster, LightEmitter, Camera, Sun, Keyboard,
  Decoration, enums } = WEED;
const { ShapeType } = enums;

const param = (k) => WEED.params?.get(k) ?? null;
const MAPS = param('maps') !== '0';
const SUN_MAP = param('sun') !== 'sprite';
const SELF = param('self') !== '0';
const HOUR = Number(param('hour')) || 16;
const HOURS = [10, 16, 18.5, 22];
const W = 1400;
const H = 900;
const SHAPES = ['sphere', 'pillar', 'crate'];
const IMG = '/demos/lightBenchScene/img/';

const shapes = { json: IMG + 'shapes.json', png: IMG + 'shapes.png' };
if (MAPS) Object.assign(shapes, { heightMap: IMG + 'shapes_h.png', normalMap: IMG + 'shapes_n.png' });

/** A ray-traced shape (makeShapes.mjs, pitch 45) standing on its foot. */
class Shape extends GameObject {
  static components = [SpriteRenderer, ShadowCaster];

  onSpawned({ shape = 0 } = {}) {
    this.setSpritesheet('shapes');
    this.setAnimation(SHAPES[shape % SHAPES.length]);
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.75;
  }
}

/** You: an LPC person that walks with WASD and faces where it walks. */
class Walker extends GameObject {
  static components = [DirectionalSprite, ShadowCaster];

  onSpawned() {
    this.setSpritesheet('civil1');
    this.directionalSprite.facingFrom = 'velocity';
    this.setAnimation('idle');
    this.setScale(1.4);
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
      const k = (2.2 * (dtRatio || 1)) / Math.sqrt(dx * dx + dy * dy);
      this.x = Math.min(W - 20, Math.max(20, this.x + dx * k));
      this.y = Math.min(H - 10, Math.max(40, this.y + dy * k * 0.7));
    }
    this.setAnimation(moving ? 'walk' : 'idle');
    this.setAnimationSpeed(moving ? 0.18 : 0.05);
  }
}

/** A lamp 40 px above the floor that walks a slow circle. */
class Lamp extends GameObject {
  static components = [Collider, LightEmitter];

  onSpawned({ cx = 0, cy = 0, r = 100, phase = 0, color = 0xffd9a0 } = {}) {
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 4;
    this.lightEmitter.color = color;
    this.lightEmitter.radius = 600;
    this.lightEmitter.elevation = 40;
    this.cx = cx;
    this.cy = cy;
    this.r = r;
    this.phase = phase;
  }

  tick(dtRatio, dt) {
    this.phase += (dt || 16.7) * 0.0003;
    this.setPosition(this.cx + Math.cos(this.phase) * this.r, this.cy + Math.sin(this.phase) * this.r * 0.7);
  }
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
    decoration: { maxDecorations: 4 },
    renderer: { backend: 'webgl', ySort: true, noLimitFPS: false },
    camera: { pitch: 45 },
    // The floor under the sprite shadows' layer (zIndex 2), so both kinds of sun shadow show on it.
    layers: { ground: { zIndex: 1.5, maxItems: 4, ySorting: false } },
    lighting: {
      enabled: true,
      baseAmbient: 0.07,
      maxLights: 16,
      resolution: 0.5,
      shadowsEnabled: true,
      sunShadows: SUN_MAP ? 'map' : 'sprite',
      selfShadow: SELF,
      sun: { enabled: true, angle: 135, elevation: 40, intensity: 1, startHour: HOUR, dayCycle: { enabled: false } },
    },
  };

  static assets = {
    spritesheets: {
      shapes,
      civil1: { json: '/demos/img/civil1.json', png: '/demos/img/civil1.png' },
    },
  };

  static entities = [[Shape, 40], [Walker, 1], [Lamp, 4]];

  _panel = null;
  _hour = HOUR;

  create() {
    Sun.setTimeOfDay(this._hour);
    Camera.setZoom(Math.min(innerWidth / W, innerHeight / H));
    Camera.centerOn(W / 2, H / 2);
    this._panel = new SunPanel([
      { key: 'm', keyName: 'M', label: 'Maps', note: "assets.spritesheets.shapes.heightMap / normalMap: lit as the surfaces they are (reloads)", press: () => this._reload('maps', MAPS ? '0' : '1') },
      { key: 'u', keyName: 'U', label: "Sun's shadows", note: "lighting.sunShadows: 'map' takes out the sun alone and falls on heights; 'sprite' is the old one (reloads)", press: () => this._reload('sun', SUN_MAP ? 'sprite' : 'map') },
      { key: 'o', keyName: 'O', label: 'Self-shadow', note: 'lighting.selfShadow: what has height shades itself from the sun (reloads)', press: () => this._reload('self', SELF ? '0' : '1') },
      { key: 'j', keyName: 'J', label: 'Hour', note: 'Sun.setTimeOfDay: 10, 16, 18:30 and 22 h (the lamps at night)', press: () => this._nextHour() },
    ]);
    this._showStates();
  }

  createNewGame() {
    Decoration.spawn({ x: W / 2, y: H / 2, texture: '_white', scaleX: (W + 8) / 8, scaleY: (H + 8) / 8, anchorX: 0.5, anchorY: 0.5, tint: 0x8e8a7c, layer: 'ground' });
    const rng = globalThis.rng;
    for (let k = 0; k < 40; k++) {
      Shape.spawn({ x: 80 + ((k % 8) * (W - 160)) / 7 + (rng() - 0.5) * 30, y: 120 + Math.floor(k / 8) * 170 + (rng() - 0.5) * 30, shape: k });
    }
    Walker.spawn({ x: W / 2, y: H / 2 + 40 });
    const colors = [0xffd9a0, 0xa8c8ff, 0xffa8c0, 0xc8ffa8];
    for (let k = 0; k < 4; k++) Lamp.spawn({ cx: 250 + k * 300, cy: 300 + (k % 2) * 300, r: 120, phase: k * 1.7, color: colors[k] });
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
    this._panel.readout.textContent = 'WASD: walk   (DirectionalSprite, its shadow the frame the sun sees)';
    this._panel.show('m', MAPS ? 'on' : 'off');
    this._panel.show('u', SUN_MAP ? 'shadow map' : 'sprites');
    this._panel.show('o', SELF ? 'on' : 'off');
    const h = Math.floor(this._hour);
    this._panel.show('j', `${h}:${String(Math.round((this._hour - h) * 60)).padStart(2, '0')}`);
  }
}
