// The town's still things, as buenos-aires draws them: houses, the props that stop a car (lamps, traffic lights, bins) and trees.
// The houses' walls and roofs are decorations the scene spawns; a house entity holds what a house is: its footprint, its volume
// for the sun, and a lamp when it is a wooden post.

import WEED from '/src/index.js';
import {
  META, RAYCAST, HEIGHT_PX, LAMP_COLOR, LIGHT_TICK, OFF, LightHours, lightBorn, lightTick,
} from './town.js';

const {
  GameObject, RigidBody, Collider, SpriteRenderer, ShadowCaster, LightEmitter, LightOccluder, VolumeShadowCaster, enums, rng,
} = WEED;
const { ShapeType } = enums;

/**
 * A house, a wall or a wooden post. Its footprint is its collider; its volume, the convex volume of the boxes the editor built it
 * from (`c.sp`: x, y of the floor under each point, already as the screen shows it, hence floorScaleY 1, and z in metres).
 */
export class House extends GameObject {
  static isStatic = true;
  static tickInterval = LIGHT_TICK;
  static components = [RigidBody, Collider, LightEmitter, LightHours, VolumeShadowCaster, ...(RAYCAST ? [LightOccluder] : [])];

  onSpawned(c = {}) {
    this.rigidBody.static = 1;
    // With ?raycast=1 a house's footprint stops lights; a post does not.
    if (RAYCAST) {
      this.lightOccluder.maskMode = 0;
      this.lightOccluder.block = c.col ? 1 : 0;
    }
    if (c.col) {
      let area = 0;
      for (let i = 0; i < c.col.length; i++) {
        const a = c.col[i];
        const b = c.col[(i + 1) % c.col.length];
        area += a[0] * b[1] - b[0] * a[1];
      }
      const ring = area >= 0 ? c.col : c.col.slice().reverse();
      const flat = [];
      for (const q of ring) flat.push(q[0], q[1]);
      if (!this.collider.makePolygon(flat)) {
        this.collider.shapeType = ShapeType.Circle;
        this.collider.radius = 6;
      }
    } else {
      this.collider.shapeType = ShapeType.Circle;
      this.collider.radius = c.r || 3;
    }
    if (c.sp && c.sp.length >= 12) {
      const points = Float32Array.from(c.sp);
      for (let q = 2; q < points.length; q += 3) points[q] *= HEIGHT_PX;
      this.volumeShadowCaster.setHull(points, { floorScaleY: 1 });
    }
    // Houses do not light; a wooden post with a lamp (dirt streets, the villa) does.
    const L = this.lightEmitter;
    const lamp = c.k === 'poste' && !!c.l;
    L.color = LAMP_COLOR;
    L.glowOffsetY = -7 * HEIGHT_PX;
    // Lit from halfway up the post (elevation), so it reaches further, or its foot would be dark.
    L.glow = lamp ? 0.066 : 0;
    L.elevation = lamp ? 50 : 0;
    L.radius = lamp ? 574 : 0;
    L.active = lamp ? 1 : 0;
    // Its shadows: 260 px of sprites in basic lighting (cheap); under raycast the houses stop all of it.
    L.shadowRange = RAYCAST ? 0 : 260;
    lightBorn(this, OFF.LAMPS, 0, 0, 0, c.x, c.y);
  }

  tick() {
    lightTick(this);
  }
}

/** Where a lamp's bulbs are, as fractions of its picture. */
const BULBS = { u_farola: [[0.65, 0.09]], u_farola_orn: [[0.5, 0.2]], u_farol_doble: [[0.17, 0.27], [0.77, 0.18]] };

/** A prop that stops a car: a lamp (a pool of light on the sidewalk and a glow on each bulb), a traffic light, a bin. */
export class StreetProp extends GameObject {
  static isStatic = true;
  static tickInterval = LIGHT_TICK;
  static components = [RigidBody, Collider, SpriteRenderer, ShadowCaster, LightEmitter, LightHours];

  onSpawned(c = {}) {
    this.rigidBody.static = 1;
    this.setSprite('props', c.f, 0);
    const anchor = META.anclas[c.f];
    this.spriteRenderer.anchorX = anchor[0];
    this.spriteRenderer.anchorY = anchor[1];
    const e = (META.escalas && META.escalas[c.f]) || 1; // HD props: drawn at 30 px/m, shown at 0.6
    this.setScale(c.fl ? -e : e, e);
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = Math.max(1.5, c.r);
    this.shadowCaster.heightMultiplier = 0.8;
    const L = this.lightEmitter;
    const top = this.spriteRenderer.originalHeight * anchor[1] * e;
    const kind = c.f.endsWith('_atras') ? c.f.slice(0, -6) : c.f; // seen from behind: the same thing
    if (kind.startsWith('u_farol')) {
      L.color = LAMP_COLOR;
      L.glowOffsetY = -top * (kind === 'u_farola' ? 0.97 : 0.88);
      // The light comes from halfway up the pole (elevation), so the pool is even, and it reaches further for it.
      L.elevation = top * 0.5;
      L.radius = kind === 'u_farol_doble' ? 756 : kind === 'u_farola' ? 696 : 629;
      L.glow = kind === 'u_farol_doble' ? 0.126 : kind === 'u_farola' ? 0.106 : 0.087;
      L.active = 1;
      // Its shadows: 260 px of sprites in basic lighting (cheap); under raycast the houses stop all of it.
      L.shadowRange = RAYCAST ? 0 : 260;
      // A glow on each bulb, in the additive lampGlows layer, above all: a lamp whose bulb is behind a house (c.hidden) has none,
      // since that layer does not sort with the houses.
      const bulbs = c.hidden ? null : BULBS[kind] || null;
      const sw = this.spriteRenderer.originalWidth * e;
      const sh = this.spriteRenderer.originalHeight * e;
      if (bulbs) {
        for (const [fx, fy] of bulbs) {
          const dx = (fx - anchor[0]) * sw * (c.fl ? -1 : 1);
          const dy = (fy - anchor[1]) * sh;
          this.addDecoration('_lightGradient', dx, dy, 0.26, 0.26, 1, { tint: 0xfff2d0, alpha: 1, anchorX: 0.5, anchorY: 0.5, layer: 'lampGlows' });
          this.addDecoration('_lightGradient', dx, dy, 0.8, 0.8, 1, { tint: LAMP_COLOR, alpha: 0.5, anchorX: 0.5, anchorY: 0.5, layer: 'lampGlows' });
        }
      }
      lightBorn(this, OFF.LAMPS, bulbs ? bulbs.length * 2 : 0, 1, 0.5, c.x, c.y);
    } else {
      L.radius = 0;
      L.active = 0;
      this.lightHours.base = 0;
      // A traffic light: a fixed red or green dot on its lamp, with no light on the floor. The game runs them by the law; this
      // demo has no traffic.
      if (c.f === 'u_semaforo') {
        const red = rng() < 0.5;
        this.addDecoration('_lightGradient', 0, -top * (red ? 0.87 : 0.7), 0.35, 0.35, 0, {
          tint: red ? 0xff3b30 : 0x36d96b, alpha: 0.85, anchorX: 0.5, anchorY: 0.5, layer: 'glows',
        });
      }
    }
  }

  tick() {
    lightTick(this);
  }
}

const TREE_SCALE = 0.6;
/** A tree's front branches sort 2.8 m of floor nearer the camera than its trunk, so its crown covers the bench under it. */
const CROWN_AHEAD = 2.8 * META.SYN * META.SF;

/**
 * A tree from the editor: its trunk is the sprite, each branch with its leaves an attached decoration that sways. Its shadow is
 * the whole tree's silhouette (ShadowCaster.setTexture): decorations cast none.
 */
export class Tree extends GameObject {
  static isStatic = true;
  static components = [RigidBody, Collider, SpriteRenderer, ShadowCaster];

  onSpawned(c = {}) {
    this.rigidBody.static = 1;
    const T = c.kind;
    const fl = c.fl ? -1 : 1;
    const E = T.escala || TREE_SCALE;
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = Math.max(2, c.r || 3);
    this.collider.visualRange = 200;
    const S = T.sil;
    this.shadowCaster.heightMultiplier = S ? 1 : 0;
    if (S) this.shadowCaster.setTexture('arboles_' + S[0], { anchorX: S[1], anchorY: S[2], scaleX: (E / S[3]) * fl, scaleY: E / S[3] });
    for (const p of T.piezas) {
      if (p[5] === 0) {
        this.setSprite('arboles', p[0], 0);
        this.spriteRenderer.anchorX = fl > 0 ? p[3] : 1 - p[3];
        this.spriteRenderer.anchorY = p[4];
        this.setScale(E * fl, E);
        continue;
      }
      this.addDecoration('arboles_' + p[0], p[1] * fl, p[2], E * fl, E, p[5], {
        anchorX: p[3], anchorY: p[4], sway: !!p[6], swayAmplitude: 0.006 + rng() * 0.006, swayFrequency: 0.35 + rng() * 0.3,
        sortOffsetY: p[5] > 0 ? CROWN_AHEAD : 0,
      });
    }
  }
}

// ---- The lamps whose bulb is behind a house: the bulb, at the lamp's height, falls inside the house's picture (the convex hull
// of its footprint and of its volume's points raised to their height), and the lamp's foot is behind the house's front there.
// The lamps do not move: this runs once, when the barrio loads.

function convexHull2D(points) {
  const P = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (P.length < 3) return P;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of P) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = P.length - 1; i >= 0; i--) {
    const p = P[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function insideConvex(H, x, y) {
  if (H.length < 3) return false;
  for (let i = 0; i < H.length; i++) {
    const a = H[i];
    const b = H[(i + 1) % H.length];
    if ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) return false;
  }
  return true;
}

/** The lowest y on the screen (the frontmost) of a polygon at x. */
function frontAt(H, x) {
  let m = -Infinity;
  for (let i = 0; i < H.length; i++) {
    const a = H[i];
    const b = H[(i + 1) % H.length];
    if ((a[0] - x) * (b[0] - x) > 0 || a[0] === b[0]) {
      if (a[0] === x) m = Math.max(m, a[1]);
      continue;
    }
    m = Math.max(m, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]));
  }
  return m;
}

/** @returns {Set<object>} the props of `world` whose bulb a house hides */
export function hiddenLamps(world) {
  const G = 256;
  const grid = new Map();
  const out = new Set();
  for (const h of world.casas || []) {
    if (!h.col || !h.sp) continue;
    const foot = h.col.map(([x, y]) => [h.x + x, h.y + y]);
    const P = foot.slice();
    for (let i = 0; i < h.sp.length; i += 3) P.push([h.x + h.sp[i], h.y + h.sp[i + 1] - h.sp[i + 2] * HEIGHT_PX]);
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const q of foot) {
      if (q[0] < x0) x0 = q[0];
      if (q[0] > x1) x1 = q[0];
    }
    const house = { foot, picture: convexHull2D(P), x0, x1 };
    for (let g = Math.floor(x0 / G); g <= Math.floor(x1 / G); g++) {
      let list = grid.get(g);
      if (!list) grid.set(g, (list = []));
      list.push(house);
    }
  }
  for (const p of world.props || []) {
    if (!(p.r > 0) || !p.f || !p.f.startsWith('u_farol')) continue;
    const metres = p.f.startsWith('u_farola_orn') ? 4 : p.f.startsWith('u_farola') ? 6.5 : 5.5;
    const bulbY = p.y - metres * HEIGHT_PX;
    const list = grid.get(Math.floor(p.x / G));
    if (!list) continue;
    for (const house of list) {
      if (p.x >= house.x0 && p.x <= house.x1 && insideConvex(house.picture, p.x, bulbY) && p.y < frontAt(house.foot, p.x)) {
        out.add(p);
        break;
      }
    }
  }
  return out;
}
