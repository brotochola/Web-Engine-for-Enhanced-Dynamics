// The barrio's still things, as the Editor de Barrios exports them: houses, trees, the objects that stop a car (lamps,
// bins, traffic lights, the fountain) and the traffic lights' lamps. A house's walls and roofs are world decorations the
// loader places; the house entity holds what a house is: its footprint and the volume the sun and the lamps see.

import WEED from '/src/index.js';
import {
  META, HEIGHT_PX_PER_M, LAMP_COLOR, LIGHT_TICK, OFF, TRAFFIC, CROSSING_STRIDE, Traffic, LightHours, lightBorn, lightTick,
} from './town.js';
import { attachDecorations } from './barrioLoader.js';
import { lightPhase, LIGHT } from './traffic.js';
import {
  objectAt, objectIndex, objectNamed, objectScale, objectAnchor, heightAboveAnchor, solidRadiusPx,
} from './standardObjects.js';

const {
  Component, GameObject, RigidBody, Collider, SpriteRenderer, ShadowCaster, LightEmitter, ParticleEmitter, PARTICLE_EASE,
  enums, rng,
} = WEED;
const { ShapeType } = enums;

/** A frame of the editor's arboles sheet by its atlas name, whether the package wrote the sheet's prefix or not. */
function treeAtlasName(name) {
  return name.startsWith('arboles_') ? name : `arboles_${name}`;
}

// ---- houses ----

/**
 * A house, a wall or a wooden post. Its footprint is its collider (`col`: [x, y] world px from its position); its volume,
 * the convex volume of the points the editor built it from (`sp`: x, y world px from its position, as the screen shows
 * the floor, hence floorScaleY 1, and z in screen px of height, as setHull takes them). A wooden post with a lamp (`k`
 * 'poste' and `l`: dirt streets, the villas) lights its corner at night.
 */
export class Casa extends GameObject {
  static isStatic = true;
  static tickInterval = LIGHT_TICK;
  static components = [RigidBody, Collider, ShadowCaster, LightEmitter, LightHours];

  onSpawned(config = {}) {
    this.rigidBody.static = 1;
    this.setFootprint(config.col, config.r);
    if (Array.isArray(config.sp) && config.sp.length >= 12) this.shadowCaster.setHull(config.sp, { floorScaleY: 1 });
    else this.shadowCaster.clear();
    this.setPostLamp(config.k === 'poste' && !!config.l, config.x, config.y);
  }

  /** Its collider: the polygon of its footprint, turned counter-clockwise for Box2D; a small circle when it has none. */
  setFootprint(outline, radius) {
    if (Array.isArray(outline) && outline.length >= 3) {
      let doubleArea = 0;
      for (let corner = 0; corner < outline.length; corner++) {
        const a = outline[corner];
        const b = outline[(corner + 1) % outline.length];
        doubleArea += a[0] * b[1] - b[0] * a[1];
      }
      const ring = doubleArea >= 0 ? outline : outline.slice().reverse();
      const flat = [];
      for (const point of ring) flat.push(point[0], point[1]);
      if (this.collider.makePolygon(flat)) return;
    }
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = radius || 6;
  }

  /** A post's lamp: lit from 50 px up (an even pool on the floor), its halo 7 m up the post, on by the hour. */
  setPostLamp(hasLamp, x, y) {
    const light = this.lightEmitter;
    light.color = LAMP_COLOR;
    light.glowOffsetY = -7 * HEIGHT_PX_PER_M;
    // Its halo, as a street lamp's (LAMP_GLOW, LAMP_GLOW_RADIUS).
    light.glow = hasLamp ? LAMP_GLOW : 0;
    light.glowRadius = LAMP_GLOW_RADIUS;
    light.elevation = hasLamp ? 50 : 0;
    light.radius = hasLamp ? 574 : 0;
    light.shadowRange = 260;
    light.active = hasLamp ? 1 : 0;
    lightBorn(this, OFF.LAMPS, x ?? this.x, y ?? this.y);
  }

  tick() {
    lightTick(this);
  }
}

// ---- trees ----

/**
 * A tree: its trunk is its sprite (`trunk`, a frame of the editor's arboles sheet, with `trunkAnchor` [x, y] and
 * `trunkScale`), its branches with their leaves hang from it and sway (attached decorations of the scene file). Its shadow
 * is the whole tree's silhouette (`sil`, `silAnchor`, `silScale`): branches cast none of their own. A tree whose trunk is
 * one more attached piece shows its silhouette as its sprite, invisible, only to cast. `fl` mirrors it.
 */
export class Arbol extends GameObject {
  static isStatic = true;
  static components = [RigidBody, Collider, SpriteRenderer, ShadowCaster];

  onSpawned(config = {}) {
    this.rigidBody.static = 1;
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = Math.max(2, config.r || 3);
    const mirror = config.fl ? -1 : 1;
    // The package names the trunk and the silhouette by their atlas names (arboles_tronco, arboles_fresno_1_sil).
    const silhouette = config.sil ? treeAtlasName(config.sil) : '';
    const [silAnchorX, silAnchorY] = pair(config.silAnchor, 0.5, 1);
    const [silScaleX, silScaleY] = pair(config.silScale, 1, 1);
    if (config.trunk) {
      this.setSprite(treeAtlasName(config.trunk));
      const [anchorX, anchorY] = pair(config.trunkAnchor, 0.5, 1);
      const [scaleX, scaleY] = pair(config.trunkScale, 1, 1);
      this.spriteRenderer.anchorX = anchorX;
      this.spriteRenderer.anchorY = anchorY;
      this.setScale(scaleX * mirror, scaleY);
      if (silhouette) {
        this.shadowCaster.setSprite({ frame: silhouette, anchorX: silAnchorX, anchorY: silAnchorY, scaleX: silScaleX * mirror, scaleY: silScaleY });
      }
    } else if (silhouette) {
      this.setSprite(silhouette);
      this.spriteRenderer.anchorX = silAnchorX;
      this.spriteRenderer.anchorY = silAnchorY;
      this.setScale(silScaleX * mirror, silScaleY);
      this.alpha = 0;
    }
    attachDecorations(this, config.decor, rng, mirror);
  }
}

/** [x, y] from a config value: a pair, one number for both, or the fallbacks. */
function pair(value, fallbackX, fallbackY) {
  if (Array.isArray(value)) return [value[0] ?? fallbackX, value[1] ?? fallbackY];
  if (typeof value === 'number') return [value, value];
  return [fallbackX, fallbackY];
}

// ---- objects that stop a car ----

/** Which standard object a Prop shows, as a position in OBJECT_NAMES (any logic worker reads it). */
export class PropState extends Component {
  static ARRAY_SCHEMA = { object: Int16Array };
}

/** A street lamp reaches about 63 m: 10·√(1800·2.2) px, the game's pool from a raised bulb. */
const LAMP_RADIUS = 10 * Math.sqrt(1800 * 2.2);
/**
 * Its halo on the bulb (LightEmitter.glow and glowRadius). The scene's halos join the entities (lightGlow 'sprite'): each
 * is drawn right after its lamp, so it shines over the lamp and a tree or a house in front of the lamp covers it, and
 * it is unshaded, so the night does not darken it. glowRadius is the glow one sees round the glass (35 px: a bulb's glow,
 * not a haze over the street the lamp lights).
 */
const LAMP_GLOW = 0.6;
const LAMP_GLOW_RADIUS = 35;
/** A lamp's shadows (the lamps' shadow map) reach 260 px: cheaper than its whole pool. */
const LAMP_SHADOW_RANGE = 260;

/**
 * A standard object that stops a car (OBJECTS[f].solidRadiusM above 0): a lamp, a bin, a bench. A lamp lights by the
 * hour: its light, and its lit picture (OBJECTS[f].lit) drawn unshaded, so its glass keeps its colour at night.
 * `fl` mirrors it; a record's scaleX and scaleY, when it has them, replace the object's scale.
 */
export class Prop extends GameObject {
  static isStatic = true;
  static tickInterval = LIGHT_TICK;
  static components = [RigidBody, Collider, SpriteRenderer, ShadowCaster, LightEmitter, LightHours, PropState];

  onSpawned(config = {}) {
    this.rigidBody.static = 1;
    const object = objectNamed(config.f);
    this.propState.object = objectIndex(config.f);
    if (!object) return;
    this.showObject(object, config);
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = solidRadiusPx(object);
    this.setLamp(object, config.x ?? this.x, config.y ?? this.y);
  }

  /** Its picture: the object's frame, scale (mirrored for `fl`) and anchor (lifted to its collider's centre). */
  showObject(object, config) {
    this.setSprite(object.sheet, object.frame, 0);
    const anchor = objectAnchor(object);
    this.spriteRenderer.anchorX = anchor[0];
    this.spriteRenderer.anchorY = anchor[1];
    const scale = objectScale(object);
    const scaleX = typeof config.scaleX === 'number' ? config.scaleX : config.fl ? -scale : scale;
    const scaleY = typeof config.scaleY === 'number' ? config.scaleY : scale;
    this.setScale(scaleX, scaleY);
  }

  /**
   * A lamp's light, if the object has bulbs: from the bulbs' height as the picture draws them, so the light sits where
   * the bulb is; that is also where its halo shows, and what makes its shadows long or short.
   */
  setLamp(object, x, y) {
    const light = this.lightEmitter;
    const bulbHeight = Array.isArray(object.bulbs) && object.bulbs.length > 0 ? this.bulbHeightPx(object) : 0;
    if (!(bulbHeight > 0)) {
      light.radius = 0;
      light.active = 0;
      LightHours.radius[this.index] = 0; // not a light: lightTick leaves it alone
      return;
    }
    light.color = LAMP_COLOR;
    light.elevation = bulbHeight;
    light.glowOffsetY = -bulbHeight * META.CZ;
    light.radius = LAMP_RADIUS * (1 + 0.2 * (object.bulbs.length - 1));
    light.glow = LAMP_GLOW;
    light.glowRadius = LAMP_GLOW_RADIUS;
    light.shadowRange = LAMP_SHADOW_RANGE;
    light.active = 1;
    lightBorn(this, OFF.LAMPS, x, y);
    this.showLit(lightTick(this) > 0);
  }

  /**
   * The bulbs' height above the floor in world px of height (a metre is SF px), read off the picture with the scene's
   * camera: a bulb is [x, y] fractions of the frame; how far it is drawn above the entity's foot (its collider's centre
   * for a solid object), over CZ, the screen px a px of height rises. Several bulbs: their mean.
   */
  bulbHeightPx(object) {
    const frameHeight = Array.isArray(object.size) ? object.size[1] : 0;
    let sum = 0;
    for (const bulb of object.bulbs) sum += heightAboveAnchor(object, bulb[1] * frameHeight);
    return sum / object.bulbs.length / META.CZ;
  }

  /** The lamp's picture: lit (its glass glowing, unshaded) or not. */
  showLit(lit) {
    const object = objectAt(this.propState.object);
    if (!object || !object.lit) return;
    const litObject = objectNamed(object.lit);
    if (lit && litObject) this.setSprite(litObject.sheet, litObject.frame, 0);
    else if (lit) this.setSprite(object.sheet, object.lit, 0);
    else this.setSprite(object.sheet, object.frame, 0);
    this.spriteRenderer.unshaded = lit;
  }

  tick() {
    const change = lightTick(this);
    if (change !== 0) this.showLit(change > 0);
  }
}

// ---- traffic lights ----

/**
 * A traffic light's state: its crossing (an index into Traffic.crossings, -1 for none), which of the crossing's two
 * streets it shows (0 the first), the light it shows now (255 none yet) and its four lamps (SemaforoLuz entities:
 * index + 1).
 */
export class SemaforoState extends Component {
  static ARRAY_SCHEMA = {
    crossing: Int16Array, street: Uint8Array, shown: Uint8Array, red: Int32Array, amber: Int32Array, green: Int32Array, cover: Int32Array,
  };
}

/**
 * Where a traffic light's lamps are on its picture (the game's, measured on u_semaforo): fractions of its height above
 * its foot. The cover is a dark disc over the red lamp, which the drawing shows lit.
 */
const RED_AT = 0.862;
const AMBER_AT = 0.773;
const GREEN_AT = 0.684;
const LAMP_COLORS = { red: 0xff3b30, amber: 0xffb020, green: 0x36d96b, cover: 0x241e1e };
const LAMP_ALPHA = 0.95;

/**
 * A traffic light (the u_semaforo object, with `cr` its crossing and `ej` the street it shows): its lamps follow the
 * crossing's 40 s cycle on the same clock the cars read (traffic.js lightPhase), so what a driver sees is what it obeys.
 * The lamps are unshaded entities of their own (SemaforoLuz), drawn in the painter's order with the rest.
 */
export class Semaforo extends Prop {
  static tickInterval = 15; // four times a second: a light changes every few seconds
  static components = [RigidBody, Collider, SpriteRenderer, ShadowCaster, LightEmitter, LightHours, PropState, SemaforoState];

  onSpawned(config = {}) {
    super.onSpawned(config);
    const state = this.semaforoState;
    const crossing = typeof config.cr === 'number' && config.cr >= 0 && config.cr < (TRAFFIC.n | 0) ? config.cr : -1;
    state.crossing = crossing;
    state.street = config.ej ? 1 : 0;
    state.shown = 255;
    // The light's height on the screen: from its anchor up to its frame's top.
    const object = objectNamed(config.f);
    const top = object ? heightAboveAnchor(object, 0) : 0;
    const side = config.fl ? -0.9 : 0.9;
    state.red = this.spawnLamp(side, top * RED_AT, LAMP_COLORS.red, 0.42, true);
    state.amber = this.spawnLamp(side, top * AMBER_AT, LAMP_COLORS.amber, 0.42, true);
    state.green = this.spawnLamp(side, top * GREEN_AT, LAMP_COLORS.green, 0.42, true);
    state.cover = this.spawnLamp(side, top * RED_AT, LAMP_COLORS.cover, 0.56, false);
    this.tick();
  }

  /** One lamp: index + 1 of its SemaforoLuz, 0 when the pool is full. */
  spawnLamp(side, lift, color, size, unshaded) {
    const lamp = SemaforoLuz.spawn({ x: this.x + side, y: this.y + 0.5, lift, color, size, glows: unshaded ? 1 : 0 });
    return lamp ? lamp.index + 1 : 0;
  }

  tick() {
    const state = this.semaforoState;
    const crossing = state.crossing;
    // Without traffic data a light keeps one colour, red or green by where it stands.
    const phase = crossing < 0
      ? (this.x + this.y) % 2 < 1 ? LIGHT.RED : LIGHT.GREEN
      : lightPhase(Date.now() / 1000, Traffic.crossings[crossing * CROSSING_STRIDE + 5], state.street);
    if (phase === state.shown) return;
    state.shown = phase;
    showLamp(state.red, phase === LIGHT.RED);
    showLamp(state.amber, phase === LIGHT.AMBER);
    showLamp(state.green, phase === LIGHT.GREEN);
    showLamp(state.cover, phase !== LIGHT.RED);
  }
}

/** A traffic light's lamp on or off (its alpha). */
function showLamp(lampPlusOne, on) {
  if (lampPlusOne <= 0) return;
  const lamp = GameObject.get(lampPlusOne - 1);
  if (lamp) lamp.alpha = on ? LAMP_ALPHA : 0;
}

/**
 * One lamp of a traffic light: a coloured disc, unshaded so it keeps its colour at night. It stands at its pole's foot
 * (half a px in front, so it is drawn after the pole) and shows `lift` px up the screen: its anchor carries it there, so
 * it sorts with its pole and what passes in front of the pole hides it too.
 */
export class SemaforoLuz extends GameObject {
  static isStatic = true;
  static components = [SpriteRenderer];

  onSpawned(config = {}) {
    this.setSprite('_whiteCircle');
    const size = config.size || 0.42;
    this.setScale(size, size);
    this.tint = config.color ?? 0xffffff;
    const discHeight = Math.max(1, this.spriteRenderer.originalHeight * size);
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.5 + (config.lift || 0) / discHeight;
    this.spriteRenderer.unshaded = !!config.glows;
    this.alpha = 0;
  }
}

// ---- the fountain ----

/** Drops a second, whatever the frame rate, and a batch every 100 ms spread over that time (the game's Chorro). */
const DROPS_PER_SECOND = 45;
const BATCH_MS = 100;
/** Gravity in screen px per frame² (the GPU particles' unit): 9.8 m/s², a metre of height HEIGHT_PX_PER_M px, 60 frames a second. */
const WATER_GRAVITY = (9.8 * HEIGHT_PX_PER_M) / 3600;

/** The upward speed (px a frame, negative up) that lifts a drop `metres` above the spout. */
function riseSpeed(metres) {
  return -Math.sqrt(2 * WATER_GRAVITY * metres * HEIGHT_PX_PER_M);
}

/**
 * A fountain (an object with a spout: OBJECTS[f].spout, [x, y, cupY] in its frame's px: where the water leaves and the
 * height of the water in its cup). Its basin is a Prop; its jet, GPU particles that rise up to a metre above the spout
 * and fall back into the cup, a batch every 100 ms with one config it reuses (no garbage a batch). It runs on logic
 * worker 0, so that config (a plain field) is always there.
 */
export class Fuente extends Prop {
  static tickInterval = 1;
  static forceProcessOnLogicWorker = 0;
  static components = [RigidBody, Collider, SpriteRenderer, ShadowCaster, LightEmitter, LightHours, PropState];

  /** The emitGpu config of its batches, built in onSpawned. */
  batch = null;
  /** Whole ms since its last batch. */
  sinceBatchMs = 0;

  onSpawned(config = {}) {
    super.onSpawned(config);
    const object = objectNamed(config.f);
    this.batch = object && Array.isArray(object.spout) ? this.makeBatch(object, config) : null;
    this.sinceBatchMs = 0;
  }

  /**
   * Its jet's config: where the spout is on the picture (from its anchor, as the export measured it), how high it
   * throws, how long a drop takes to fall back to the cup's water.
   */
  makeBatch(object, config) {
    const [spoutX, spoutY, cupY] = object.spout;
    const scale = Math.abs(objectScale(object));
    const mirror = config.fl ? -1 : 1;
    const frameWidth = Array.isArray(object.size) ? object.size[0] : 0;
    const jetX = this.x + (spoutX - objectAnchor(object)[0] * frameWidth) * scale * mirror;
    const spoutHeight = heightAboveAnchor(object, spoutY); // screen px above the entity's point
    const cupHeight = heightAboveAnchor(object, cupY);
    const fall = Math.max(1, spoutHeight - cupHeight);
    const highest = riseSpeed(1.15);
    const lowest = riseSpeed(0.8);
    // A drop thrown up at speed v (negative) is back at the cup's height after (−v + √(v² + 2·g·fall)) / g frames.
    const lifeMs = (v) => ((-v + Math.sqrt(v * v + 2 * WATER_GRAVITY * fall)) / WATER_GRAVITY) * (1000 / 60);
    return {
      layer: 'water',
      heighted: true,
      count: 0,
      x: { min: jetX - 1, max: jetX + 1 },
      y: this.y,
      z: -spoutHeight,
      vx: { min: -0.12, max: 0.12 },
      vy: { min: -0.06, max: 0.06 },
      vz: { min: highest, max: lowest },
      gravity: WATER_GRAVITY,
      delay: { min: 0, max: 0 },
      lifespan: { min: lifeMs(lowest), max: lifeMs(highest) },
      texture: '_whiteCircle',
      scale: { from: 0.32, to: 0.26 },
      alpha: { from: 0.95, to: 0.55, ease: PARTICLE_EASE.QUAD_IN },
      tint: { from: 0xeef9ff, to: 0xa6daf0 },
    };
  }

  tick(dtRatio, deltaTime) {
    const batch = this.batch;
    if (batch === null) return;
    this.sinceBatchMs = (this.sinceBatchMs + Math.round(deltaTime || 16)) | 0;
    if (this.sinceBatchMs < BATCH_MS) return;
    batch.count = Math.round((this.sinceBatchMs * DROPS_PER_SECOND) / 1000);
    batch.delay.max = this.sinceBatchMs;
    this.sinceBatchMs = 0;
    ParticleEmitter.emitGpu(batch);
  }
}
