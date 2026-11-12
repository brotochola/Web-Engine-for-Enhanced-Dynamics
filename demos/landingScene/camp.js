// camp.js – chapter 4's night camp. A campfire of GPU-particle flames, smoke and sparks (fx.js) on three logs; crates
// and barrels stacked around it. A click blows up the spot
// (fx.js), throws what is near (Box2d.explode) and sets the nearest props on fire for a while; some seconds later
// every prop is put back where it stood, put out.

import { FIRE_HEAT } from '../burningBoxesScene/fireLayer.js';
import { FIRE_LAYER } from './bricksTitle.js';
import { Campfire, fxExplosion } from './fx.js';
import { groundY } from './terrain.js';
import { fall } from './water.js';

const { GameObject, Component, RigidBody, Collider, SpriteRenderer, LightEmitter, Box2d } = WEED;

const BURNING = ['entities', FIRE_LAYER];
const PLAIN = ['entities'];
/** Props are lit by the fire, not by the moon: darker than their pictures. */
const NIGHT_TINT = 0x8c8c9c;
/** How long a prop burns (ms), and how long after a blast the stack is rebuilt. */
const BURN_MS = [7000, 11000];
const REBUILD_MS = 15000;

/** Per prop, in shared memory: the page lights it, its tick puts it out. */
export class PropState extends Component {
  static ARRAY_SCHEMA = { burn: Float32Array };
}

/** A crate or a barrel. */
export class CampProp extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer, PropState];

  onSpawned({ kind = 'crate', size = 60 } = {}) {
    PropState.burn[this.index] = 0;
    const barrel = kind === 'barrel';
    const w = barrel ? size * (26 / 34) : size;
    this.setSprite(barrel ? 'campBarrel' : 'campCrate');
    this.setAnchor(0.5, 0.5);
    this.setDisplaySize(w, size);
    this.collider.width = w * 0.94;
    this.collider.height = size * 0.96;
    this.collider.friction = 0.7;
    this.collider.restitution = 0.15;
    this.rigidBody.linearDamping = 0.05;
    this.rigidBody.angularDamping = 0.1;
    this.setTint(NIGHT_TINT);
    this.setFeedBits(0);
    this.setLayers(PLAIN);
  }

  tick(dtRatio, deltaTimeMs) {
    fall(this);
    const i = this.index;
    if (PropState.burn[i] <= 0) return;
    if ((this.getFeedBits() & FIRE_HEAT) === 0) {
      this.setLayers(BURNING);
      this.setFeedBits(FIRE_HEAT);
      this.setTint(0x5a4a40); // charring
    }
    const left = PropState.burn[i] - deltaTimeMs;
    PropState.burn[i] = left > 0 ? left : 0;
    if (left <= 0) {
      this.setFeedBits(0);
      this.setLayers(PLAIN);
    }
  }

  onDespawned() {
    this.setFeedBits(0);
    this.setLayers(PLAIN);
  }
}

/** A log of the campfire: charred, glowing in the GPU flames over it. */
export class CampLog extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer];

  onSpawned({ w = 90, h = 14 } = {}) {
    this.collider.width = w;
    this.collider.height = h;
    this.collider.friction = 0.8;
    this.setSprite('_white');
    this.setAnchor(0.5, 0.5);
    this.setDisplaySize(w, h);
    this.setTint(0x3a2414);
  }

  tick() {
    fall(this);
  }
}

/** The campfire's light: a warm flicker on everything near, under the night's ambient. */
export class CampLight extends GameObject {
  static components = [Collider, LightEmitter];

  onSpawned({ range = 600 } = {}) {
    this.collider.radius = 4;
    this.collider.isTrigger = 1;
    this.collider.visualRange = range; // how far the light reaches
    const light = this.lightEmitter;
    light.active = 1;
    light.color = 0xff9a40;
    light.radius = 1265;
  }

  tick(dtRatio, deltaTimeMs, accTime) {
    const t = accTime * 0.001;
    const flick = 1 + Math.sin(t * 9) * 0.1 + Math.sin(t * 13.7 + 1.3) * 0.08 + Math.sin(t * 23.1) * 0.05;
    this.lightEmitter.radius = 1265 * Math.sqrt(flick);
  }
}

/** Page only: builds the camp in the chapter at [left, left + width), and runs it. */
export class Camp {
  constructor(left, width, height, unit) {
    this.left = left;
    this.width = width;
    this.height = height;
    this.unit = unit;
    this.size = Math.max(34, 62 * unit); // a crate's side
    this.fireX = left + width * 0.42;
    this.fireY = groundY(this.fireX, width, height);
    this.fire = new Campfire(this.fireX, this.fireY, Math.max(0.8, 1.25 * unit));
    this.rebuildMs = 0;
    this.props = []; // { prop, x, y }: each prop's page instance and its place in the stack
  }

  /** The logs and the props, once. */
  spawn() {
    // Three logs in a little pile: two on the ground, one on top.
    const w = 64 * this.unit + 16;
    const h = 13;
    CampLight.spawn({ x: this.fireX, y: this.fireY - 30 * this.unit, range: 640 * Math.max(0.7, this.unit) });
    for (const [dx, dy] of [[-0.52, 0.5], [0.52, 0.5], [0, 1.5]]) {
      const x = this.fireX + dx * w;
      const log = CampLog.spawn({ x, y: this.fireY - h * dy - 2, w, h });
      if (log) this.props.push({ prop: log, x, y: this.fireY - h * dy - 2 });
    }
    this.spawnProps();
  }

  spawnProps() {
    const s = this.size;
    // A pyramid of crates on the right, three barrels on the left.
    const baseX = this.left + this.width * 0.62;
    const ground = (x) => groundY(x, this.width, this.height);
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3 - row; col++) {
        const x = baseX + (col + row * 0.5) * s * 1.02;
        this.place(x, ground(x) - s * (row + 0.5) - 2, 'crate', s);
      }
    }
    for (let k = 0; k < 3; k++) {
      const x = this.left + this.width * (0.2 + k * 0.055);
      this.place(x, ground(x) - s * 0.6, 'barrel', s * 1.05);
    }
  }

  place(x, y, kind, size) {
    const prop = CampProp.spawn({ x, y, kind, size });
    if (prop) this.props.push({ prop, x, y });
  }

  /** The campfire burns while the camp is near the camera; the stack is rebuilt after a blast. */
  update(deltaMs, near) {
    if (near) this.fire.update(deltaMs);
    if (this.rebuildMs > 0) {
      this.rebuildMs -= deltaMs;
      if (this.rebuildMs <= 0) this.rebuild();
    }
  }

  /** Every prop back to its place, still, upright and put out (a last 1 ms of fire: its tick puts it out). */
  rebuild() {
    for (const { prop, x, y } of this.props) {
      if (prop.hasComponent(PropState) && PropState.burn[prop.index] > 0) PropState.burn[prop.index] = 1;
      prop.setPosition(x, y);
      prop.setVelocity(0, 0);
      prop.angularVelocity = 0;
      prop.rotation = 0;
      if (prop.hasComponent(PropState)) prop.setTint(NIGHT_TINT);
    }
  }

  /** A blast at (x, y): fire and smoke, everything near thrown, the nearest props alight. */
  blast(x, y) {
    const u = Math.max(0.6, this.unit);
    fxExplosion(x, y, u);
    Box2d.explode({ x, y, radius: 300 * u, impulsePerLength: 6000 * u });
    const reach = 170 * u;
    const list = CampProp.getAllActive();
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      const prop = CampProp.get(i);
      const dx = prop.x - x;
      const dy = prop.y - y;
      if (dx * dx + dy * dy < reach * reach) PropState.burn[i] = BURN_MS[0] + Math.random() * (BURN_MS[1] - BURN_MS[0]);
    }
    this.rebuildMs = REBUILD_MS;
  }
}
