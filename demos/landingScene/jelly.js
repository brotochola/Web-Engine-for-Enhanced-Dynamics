// jelly.js – chapter 2: LiquidFun soft bodies, and the blade that cuts them.
//
// A jelly is one elastic particle group (LIQUIDFUN_FLAGS.ELASTIC): every step LiquidFun pulls each particle back to
// where it sits in the group's rest shape, turned and moved with the group, so the jelly wobbles and keeps its form.
// SOLID keeps jellies apart (and out of the water). A swipe across one cuts it: the Blade, pinned to logic worker 0,
// asks LiquidFun which particles lie along the swipe (rayCast, a sync query only logic workers make), destroys them,
// and extracts the particles on one side of the swipe into a group of their own in the same step: each half rebuilds
// its rest shape from where its particles are and wobbles on as a jelly of its own. A tap pokes the jellies under it.

import { WORD_COLORS } from './bricksTitle.js';
import { groundY } from './terrain.js';

const {
  GameObject,
  Mouse,
  LiquidFun,
  LIQUIDFUN_FLAGS,
  LIQUIDFUN_GROUP_FLAGS,
  ParticleEmitter,
  PARTICLE_EASE,
  BLEND_MODES,
  LAYER_DENSITY_SOURCE,
  LAYER_SPLAT_FALLOFF,
  LAYER_SCALE_MODE,
} = WEED;

export const JELLY_LAYER = 'jelly';
const ELASTIC = LIQUIDFUN_FLAGS.ELASTIC;
const SOLID = LIQUIDFUN_GROUP_FLAGS.SOLID;
/** A half smaller than this many particles is not cut off: it would be crumbs. */
const MIN_HALF = 12;
const HITS = new Int32Array(4096);
const SIDE = new Int32Array(4096);
/** Marks the stroke's hits by particle index (LiquidFun's indices are below 65,536). */
const CUT = new Uint8Array(65536);
const EXTRACT_OPTS = { groupFlags: SOLID };
/** How fast the halves of a cut part (px/s). */
const PART_SPEED = 160;

/** The jelly layer, for a scene's static config.layers. */
export function jellyLayer(radius) {
  return {
    zIndex: 3.35,
    blendMode: BLEND_MODES.NORMAL,
    resolution: 1,
    scaleMode: LAYER_SCALE_MODE.LINEAR,
    maxItems: 0,
    ySorting: false,
    shader: {
      fragment: 'landingJelly',
      containerBlend: BLEND_MODES.ADD,
      densitySource: LAYER_DENSITY_SOURCE.LIQUID_FUN,
      splat: { radius: radius * 3.2, falloff: LAYER_SPLAT_FALLOFF.QUADRATIC, useParticleTint: true, intensity: 0.2 },
      uniforms: { uThreshold: { value: 0.32, type: 'f32', min: 0, max: 1, step: 0.01, label: 'Threshold' } },
    },
  };
}

export const jellyAssets = {
  shaders: { landingJelly: new URL('./shaders/jelly.wgsl', import.meta.url).href },
};

/** Page only: the chapter's jellies, dropped onto the valley. */
export function spawnJellies(left, width, height, unit) {
  const u = Math.max(0.7, unit);
  const ground = (x) => groundY(x, width, height);
  const blob = (fx, r, color, lift = 1.4) => {
    const x = left + width * fx;
    LiquidFun.emit({
      shape: 'circle', posX: x, posY: ground(x) - r * lift, radius: r,
      flags: ELASTIC, groupFlags: SOLID, strength: 0.9, trackGroup: true, tint: color, layers: [JELLY_LAYER],
    });
  };
  const cube = (fx, w, h, color, y) => {
    const x = left + width * fx;
    LiquidFun.emit({
      shape: 'box', posX: x, posY: y ?? ground(x) - h * 1.2, halfWidth: w, halfHeight: h,
      flags: ELASTIC, groupFlags: SOLID, strength: 0.9, trackGroup: true, tint: color, layers: [JELLY_LAYER],
    });
  };
  // Left of the chapter's card, spaced so they wobble without crowding.
  blob(0.13, 58 * u, WORD_COLORS[0]);
  blob(0.25, 40 * u, 0xff5ab4);
  // A tower of jelly cubes.
  const t = 0.37;
  const tx = left + width * t;
  const g = ground(tx);
  cube(t, 48 * u, 28 * u, WORD_COLORS[2], g - 32 * u);
  cube(t, 38 * u, 24 * u, 0xff7a3c, g - 92 * u);
  cube(t, 28 * u, 20 * u, 0x5ac8ff, g - 142 * u);
  blob(0.51, 66 * u, WORD_COLORS[1]);
  blob(0.63, 32 * u, 0xb48cff, 2.5);
}

/**
 * The blade, one per scene, pinned to logic worker 0 (`forceProcessOnLogicWorker: 0`): while the pointer is held in
 * [x0, x1) it cuts jellies along each frame's stroke (and leaves a glint along it).
 */
export class Blade extends GameObject {
  static components = [];

  onSpawned({ x0 = 0, x1 = 0, particleMass = 1 } = {}) {
    this.x0 = x0;
    this.x1 = x1;
    this.particleMass = particleMass; // LiquidFun's: density × diameter²
    this.cutIds = new Set(); // groups cut during this stroke: each is cut once per stroke
    this.trail = {
      layer: 'trails', count: 0, x: 0, y: 0, angleXY: { min: 0, max: 360 }, speed: { min: 0, max: 0.4 },
      lifespan: { min: 180, max: 320 }, texture: '_whiteCircle',
      scale: { from: 0.55, to: 0 }, alpha: { from: 0.85, to: 0, ease: PARTICLE_EASE.QUAD_IN }, tint: 0xffffff,
    };
  }

  tick() {
    if (!Mouse.isButton0Down) {
      if (this.cutIds.size) this.cutIds.clear();
      return;
    }
    const x2 = Mouse.x;
    const y2 = Mouse.y;
    const x1 = Mouse.prevX;
    const y1 = Mouse.prevY;
    if (x2 < this.x0 || x2 >= this.x1) return;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 < 9) return;
    this.glint(x1, y1, dx, dy, Math.sqrt(len2));
    const n = LiquidFun.rayCast(x1, y1, x2, y2, HITS);
    if (n > 0) this.cut(x1, y1, dx, dy, n);
  }

  /** A few bright dots along the stroke. */
  glint(x1, y1, dx, dy, len) {
    const steps = Math.min(12, Math.ceil(len / 10));
    const t = this.trail;
    t.count = 1;
    for (let k = 0; k < steps; k++) {
      const f = (k + Math.random()) / steps;
      t.x = x1 + dx * f;
      t.y = y1 + dy * f;
      ParticleEmitter.emitGpu(t);
    }
  }

  cut(x1, y1, dx, dy, n) {
    const views = LiquidFun.getViews();
    const groups = LiquidFun.getGroups();
    if (!views || !views.x) return;
    const px = views.x;
    const py = views.y;
    const flags = views.flags;
    for (let k = 0; k < n; k++) CUT[HITS[k]] = 1;
    for (let g = 0; g < groups.length; g++) {
      const group = groups[g];
      if (this.cutIds.has(group.id)) continue;
      const first = group.firstIndex;
      const last = group.lastIndex;
      if (!(last > first)) continue;
      // The hits in this group, if it is a jelly.
      let hits = 0;
      for (let k = 0; k < n; k++) {
        const i = HITS[k];
        if (i >= first && i < last && (!flags || flags[i] & ELASTIC)) hits++;
      }
      if (hits === 0) continue;
      // Its particles on each side of the stroke's line, the cut ones aside (they are destroyed).
      let pos = 0;
      let neg = 0;
      for (let i = first; i < last; i++) {
        if (CUT[i]) continue;
        if (dx * (py[i] - y1) - dy * (px[i] - x1) > 0) SIDE[pos++] = i;
        else neg++;
      }
      if (pos < MIN_HALF || neg < MIN_HALF) continue;
      for (let k = 0; k < n; k++) {
        const i = HITS[k];
        if (i >= first && i < last) LiquidFun.destroyParticle(i);
      }
      const newId = LiquidFun.extract(group.id, SIDE, pos, EXTRACT_OPTS);
      this.cutIds.add(group.id);
      if (newId >= 0) {
        this.cutIds.add(newId);
        // The halves part at PART_SPEED: the extracted side is the stroke's left (side > 0), so it goes that way.
        // LiquidFun spreads a group's impulse over its particles' mass (count × density × diameter²).
        const len = Math.sqrt(dx * dx + dy * dy);
        const nx = -dy / len;
        const ny = dx / len;
        const k = PART_SPEED * this.particleMass;
        LiquidFun.groupApplyLinearImpulse(newId, nx * k * pos, ny * k * pos);
        LiquidFun.groupApplyLinearImpulse(group.id, -nx * k * neg, -ny * k * neg);
      }
    }
    for (let k = 0; k < n; k++) CUT[HITS[k]] = 0;
  }
}

/** Page only: a tap pokes the jellies within reach of it upward. */
export function pokeJellies(x, y, reach) {
  const groups = LiquidFun.getGroups();
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    const dx = group.x - x;
    const dy = group.y - y;
    if (dx * dx + dy * dy < reach * reach) LiquidFun.groupApplyLinearImpulse(group.id, dx * 0.5, -260);
  }
}
