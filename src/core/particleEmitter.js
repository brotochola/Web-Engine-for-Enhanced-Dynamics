// ParticleEmitter.js - Static API for emitting particles
// Used by game entities to spawn visual particle effects
// Particles are NOT GameObjects - they use ParticleComponent directly
//
// EXTENDS SharedAtomicPool for thread-safe free list management
//
// ═══════════════════════════════════════════════════════════════════════════
// SPAWN MODES
// ═══════════════════════════════════════════════════════════════════════════
//
// emit(config)         — heighted; screenY = y + z (topdown / iso)
// emitZenithal(config) — heighted; XY on floor, scale/alpha from -z
// emitFlat(config)     — no ground; XY + optional vy gravity; screenY = y
//
// Zenithal projection curve (zenithalMaxHeight / ScaleFactor / AlphaFade) is
// scene-level only — not per-emit params.
//
// ═══════════════════════════════════════════════════════════════════════════
// PRESETS (E-538)
// ═══════════════════════════════════════════════════════════════════════════
//
// const SPARKS = ParticleEmitter.define(config)   — once, at module level (defineZenithal / defineFlat: the other modes)
// ParticleEmitter.emitPreset(SPARKS, x, y, z, count, dirX, dirY)   — per shot: only what varies per emit
// ParticleEmitter.withVz(vz).withScaleFactor(f).emitPreset(...)    — the few other keys a game changes per emit
//
// One core for both forms: a config is compiled into a row of numbers (each key a value, a range drawn per particle,
// or an over-life tween), and the emit writes the particles from that row. A literal emit(config) compiles its config
// into the emit's row on every call; a preset was compiled once by define, and its emit copies its row. The ranges are
// drawn inside the engine, from the seeded generator in batches (rngFill), in the order the literal form always drew
// them, so a preset emit writes the particles the same literal emit would. An emit from a preset allocates nothing: no
// config object, no range objects, no double passed across a call (E-85: a double crossing a call TurboFan leaves out
// is boxed), the per-emit values go through a module Float64Array.
//
// ═══════════════════════════════════════════════════════════════════════════
// TEXTURE SPECIFICATION
// ═══════════════════════════════════════════════════════════════════════════
//
// Particles and decals can use ANY texture from the bigAtlas:
//
// 1. Static textures (from assets.textures):
//    emit({ texture: "blood" })
//    emit({ texture: "smoke" })
//
// 2. Prefixed animation names (uses first frame):
//    emit({ texture: "civil1_hurt" })
//    emit({ texture: "fire_burn" })
//
// 3. Specific frame names:
//    emit({ texture: "civil1_hurt_5" })
//    Decal.stamp({ texture: "civil1_hurt_5" })
//
// 4. Helper syntax for animation frames (recommended):
//    emit({ spritesheet: "civil1", animation: "hurt", frame: -1 })
//    Decal.stamp({ spritesheet: "civil1", animation: "hurt", frame: -1 })
//
// 5. A choice of textures, one picked per particle (up to 8):
//    emit({ texture: ["muzzle1", "muzzle2", "muzzle3"] })
//
// The helper syntax resolves to the frame name automatically.
// ═══════════════════════════════════════════════════════════════════════════

import { ParticleComponent } from '../components/particleComponent.js';
import { SpriteSheetRegistry } from './spriteSheetRegistry.js';
import { SharedAtomicPool } from './sharedAtomicPool.js';
import { CAMERA_TYPES, PARTICLE_EASE } from '../util/configDefaults.js';
import { randomRange, rng, rngFill } from '../util/utils.js';
import { Layer } from './layer.js';
import { syncParticleFeed } from '../util/layerFeed.js';
import { GpuParticles } from './gpuParticles.js';
import { PARTICLE_EASE_SHIFT, PARTICLE_TWEEN, isFromToObject, resolveEaseId } from '../util/particleTween.js';
import { checkEmit } from './debug/devChecks.js';
/** The emit's batch of acquired slots: 16-bit, or 32-bit for a pool past 65 535 slots (E-129). */
const ACQUIRE_BATCH_U16 = new Uint16Array(256);

export const DECAL_STAMPS_BLEND_MODE = Object.freeze({
  normal: 0,
  multiply: 1,
});

/**
 * The keys an emit's config can have: every key the compile reads (particleEmitConfigKeys.test.js holds the two
 * together), `layer` and `layers` (read by Layer.resolveSubscriptions). A literal emit ignores any other key, as it
 * always did; define() refuses one, once, so a typo in a preset shows.
 */
export const PARTICLE_EMIT_KEYS = Object.freeze([
  'count', 'texture', 'spritesheet', 'animation', 'frame', 'anim',
  'x', 'y', 'z', 'dirX', 'dirY', 'speed', 'spread', 'angleXY',
  'vx', 'vy', 'vz', 'lifespan', 'gravity',
  'scale', 'scaleX', 'scaleY', 'alpha', 'tint',
  'rotC', 'rotS', 'rotation', 'angularVelocity', 'faceDirection', 'flipX', 'flipY',
  'fadeOnTheFloor', 'stayOnTheFloor', 'despawnOnGroundContact',
  'bounces', 'bounciness', 'bounceFriction',
  'blendMode', 'layer', 'layers', 'renderOnly', 'lightRadius',
]);
const EMIT_KEY_SET = new Set(PARTICLE_EMIT_KEYS);

/** The most textures a `texture` list (one picked per particle) and a `frame` list hold. */
const MAX_TEXTURE_CHOICES = 8;

// ---------------------------------------------------------------------------------------------------------------------
// The compiled config: one row of doubles. A sampler is three slots [kind, lo, hi]: kind 0 is the value lo, kind 1 a
// range drawn per particle as lo + r * (hi - lo) (randomRange's rule). An op (resolveParticleOp) is eight: [tween, ease,
// then the from sampler, then the to sampler]; without a tween, to is from. A color op has the same eight, its samplers
// [kind, min color, max color] (randomColor's per-channel lerp).
// ---------------------------------------------------------------------------------------------------------------------

const OP_TWEEN = 0;
const OP_EASE = 1;
const OP_FROM = 2;
const OP_TO = 5;
const OP_SLOTS = 8;

const ROW_NAMES = [
  'FLAT', 'VIEW',
  'COUNT', '', '',
  'X', '', '',
  'Y', '', '',
  'Z', '', '',
  'DIR_SET', 'DIR_X', 'DIR_Y',
  'SPEED_SET', 'SPEED', '', '',
  'SPREAD_MODE', 'SPREAD', '', '',
  'ANGLE_SET', 'ANGLE', '', '',
  'VX', '', '',
  'VY', '', '',
  'VZ', '', '',
  'LIFE', '', '',
  'GRAVITY',
  'SCALE_SPLIT',
  'SCALE_X', '', '', '', '', '', '', '',
  'SCALE_Y', '', '', '', '', '', '', '',
  'ALPHA', '', '', '', '', '', '', '',
  'TINT', '', '', '', '', '', '', '',
  'ROT_CS', 'ROT_C', 'ROT_S',
  'ROT', '', '', '', '', '', '', '',
  'SPIN_SET',
  'SPIN', '', '', '', '', '', '', '',
  'FACE', 'FLIP_X', 'FLIP_Y', 'FADE', 'STAY', 'DESPAWN',
  'BOUNCE_SET', 'BOUNCES', '', '', 'BOUNCINESS', '', '', 'FRICTION', '', '',
  'BLEND', 'RENDER_ONLY',
  'LIGHT_MODE', 'LIGHT_CONST', 'LIGHT_LO', 'LIGHT_HI',
];
/** Slots a define() row holds (and an emit from a preset copies). */
const ROW_SLOTS = ROW_NAMES.length;
/** What the emit derives from its row once, for the batches: after the row in EMIT_ROW. */
const DERIVED_NAMES = [
  'VEL_MODE', 'ROT_MODE', 'MASK', 'EASE_ID', 'EASE_IDS', 'TEXTURE_ID', 'CHOICES', 'FRAMES_ON', 'FRAMES_N',
  'FRAMES_CYCLE', 'SUB_MASK', 'LIGHT_DRAW', 'ANGLE_C', 'ANGLE_S', 'DRAWS',
];
/** Slot indices by name (the row's, then the derived ones). */
const R = Object.freeze(Object.fromEntries(
  [...ROW_NAMES, ...DERIVED_NAMES].map((name, i) => [name, i]).filter(([name]) => name !== ''),
));

/** emit / emitZenithal / emitFlat. */
const MODE_TOPDOWN = 0;
const MODE_ZENITHAL = 1;
const MODE_FLAT = 2;
/** How a particle's velocity is given: a direction and a speed, an angle and a speed, or vx and vy. */
const VEL_DIR = 0;
const VEL_ANGLE = 1;
const VEL_AXES = 2;
/** Where a particle's rotation comes from: the rotation op, rotC / rotS, or the emit's direction (faceDirection). */
const ROT_OP = 0;
const ROT_CS = 1;
const ROT_FACE = 2;
/** spread: none, a number (± that many radians, uniform), or a sampler. */
const SPREAD_NONE = 0;
const SPREAD_NUMBER = 1;
const SPREAD_SAMPLED = 2;

/** A Float64Array on a SharedArrayBuffer where there is one: TurboFan gives its elements an immediate address (E-473). */
function scratch64(length) {
  return new Float64Array(new (typeof SharedArrayBuffer === 'function' ? SharedArrayBuffer : ArrayBuffer)(length * 8));
}

/** The emit's row: a literal config compiled, or a preset's row copied; then the emit's arguments over it. */
const EMIT_ROW = scratch64(ROW_SLOTS + DERIVED_NAMES.length);

/**
 * emitPreset's arguments and the with* overrides, for the next emit on this thread. NaN is "not given" (the preset's
 * value stands); the factors are 1 when not given. The emit reads them first and clears them at once.
 */
const EMIT_ARGS = scratch64(12);
const ARG_X = 0;
const ARG_Y = 1;
const ARG_Z = 2;
const ARG_COUNT = 3;
const ARG_DIR_X = 4;
const ARG_DIR_Y = 5;
const ARG_VZ = 6;
const ARG_FLIP_X = 7;
const ARG_FLIP_Y = 8;
const ARG_SCALE_FACTOR = 9;
const ARG_ALPHA_FACTOR = 10;
const ARG_SPEED_FACTOR = 11;
/** emitAlongLine keeps the overrides for every sample of its line. */
const SAVED_OVERRIDES = scratch64(6);

function clearEmitArgs() {
  const a = EMIT_ARGS;
  a[ARG_X] = NaN;
  a[ARG_Y] = NaN;
  a[ARG_Z] = NaN;
  a[ARG_DIR_X] = NaN;
  a[ARG_DIR_Y] = NaN;
  a[ARG_COUNT] = NaN;
  a[ARG_VZ] = NaN;
  a[ARG_FLIP_X] = NaN;
  a[ARG_FLIP_Y] = NaN;
  a[ARG_SCALE_FACTOR] = 1;
  a[ARG_ALPHA_FACTOR] = 1;
  a[ARG_SPEED_FACTOR] = 1;
}
clearEmitArgs();

/** Particles per batch of generator numbers (the acquire batch's size), and the most numbers one particle draws. */
const BATCH = 256;
const MAX_DRAWS = 25;
const RND = scratch64(BATCH * MAX_DRAWS);
/** The texture list's ids and the frame list's ids, resolved once per emit. */
const CHOICE_IDS = new Int32Array(MAX_TEXTURE_CHOICES);
const FRAME_IDS = new Int32Array(MAX_TEXTURE_CHOICES);

/**
 * The next `n` numbers of the seeded generator into RND, as `n` rng() calls would return them. rngFill needs a
 * seededRandom generator (the engine's); another one (a test's function) is called once per number, as rng() does.
 */
function fillDraws(n) {
  try {
    rngFill(RND, 0, n);
  } catch {
    for (let k = 0; k < n; k++) RND[k] = rng();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The compile: a config into a row (define's table, or EMIT_ROW for a literal emit). It reads each key once, and decides
// what the old per-particle resolvers decided from the value's type (randomRange, resolveParticleOp,
// resolveParticleColorOp): the decision is the same for every particle of an emit.
// ---------------------------------------------------------------------------------------------------------------------

/** randomRange(value, def) as the sampler at T[at]. */
function compileSampler(T, at, value, def) {
  if (value === undefined || value === null) {
    T[at] = 0;
    T[at + 1] = def;
    T[at + 2] = def;
  } else if (typeof value === 'number') {
    T[at] = 0;
    T[at + 1] = value;
    T[at + 2] = value;
  } else {
    T[at] = 1;
    T[at + 1] = value.min ?? def;
    T[at + 2] = value.max ?? def;
  }
}

/** resolveParticleOp(value, def) as the op at T[at]. */
function compileOp(T, at, value, def) {
  if (value !== undefined && value !== null && typeof value !== 'number' && isFromToObject(value)) {
    T[at + OP_TWEEN] = 1;
    T[at + OP_EASE] = resolveEaseId(value.ease);
    compileSampler(T, at + OP_FROM, value.from ?? value.start ?? def, def);
    compileSampler(T, at + OP_TO, value.to ?? value.end ?? def, def);
    return;
  }
  T[at + OP_TWEEN] = 0;
  T[at + OP_EASE] = PARTICLE_EASE.LERP;
  compileSampler(T, at + OP_FROM, value, def);
  compileSampler(T, at + OP_TO, value, def);
}

/** randomColor(value, def) as the color sampler at T[at]: a number is itself, anything else a per-channel range. */
function compileColorSampler(T, at, value, def) {
  if (value === undefined || value === null) {
    T[at] = 0;
    T[at + 1] = def;
    T[at + 2] = def;
  } else if (typeof value === 'number') {
    T[at] = 0;
    T[at + 1] = value;
    T[at + 2] = value;
  } else {
    T[at] = 1;
    T[at + 1] = value.min ?? def;
    T[at + 2] = value.max ?? def;
  }
}

/** resolveParticleColorOp(value, def) as the color op at T[at]. */
function compileColorOp(T, at, value, def) {
  if (value !== undefined && value !== null && typeof value !== 'number' && isFromToObject(value)) {
    T[at + OP_TWEEN] = 1;
    T[at + OP_EASE] = resolveEaseId(value.ease);
    compileColorSampler(T, at + OP_FROM, value.from ?? value.start ?? def, def);
    compileColorSampler(T, at + OP_TO, value.to ?? value.end ?? def, def);
    return;
  }
  T[at + OP_TWEEN] = 0;
  T[at + OP_EASE] = PARTICLE_EASE.LERP;
  compileColorSampler(T, at + OP_FROM, value, def);
  compileColorSampler(T, at + OP_TO, value, def);
}

/** A `texture` list: 1 to 8 names. */
function checkTextureList(list, where) {
  if (list.length < 1 || list.length > MAX_TEXTURE_CHOICES) {
    throw new TypeError(`${where}: texture must be a name or a list of 1 to ${MAX_TEXTURE_CHOICES} names, not ${list.length}`);
  }
}

/**
 * The config `cfg` of an emit in `mode` into the row at T[o]. Its defaults are emit's: count 1, lifespan 1000,
 * gravity 0.15 (emitFlat's 0), scale and alpha 1, tint white, rotation 0, bounciness 0.5, bounceFriction 0.7.
 */
function compileEmit(T, o, cfg, mode) {
  const flat = mode === MODE_FLAT;
  T[o + R.FLAT] = flat ? 1 : 0;
  T[o + R.VIEW] = mode === MODE_ZENITHAL ? CAMERA_TYPES.ZENITHAL : CAMERA_TYPES.TOPDOWN;
  compileSampler(T, o + R.COUNT, cfg.count, 1);
  compileSampler(T, o + R.X, cfg.x, 0);
  compileSampler(T, o + R.Y, cfg.y, 0);
  compileSampler(T, o + R.Z, cfg.z, 0);

  const dirX = cfg.dirX;
  const dirY = cfg.dirY;
  const dirSet = dirX != null && dirY != null;
  T[o + R.DIR_SET] = dirSet ? 1 : 0;
  T[o + R.DIR_X] = dirSet ? dirX : 0;
  T[o + R.DIR_Y] = dirSet ? dirY : 0;
  const speed = cfg.speed;
  T[o + R.SPEED_SET] = speed !== undefined ? 1 : 0;
  compileSampler(T, o + R.SPEED, speed, 0);
  const spread = cfg.spread;
  if (spread == null) {
    T[o + R.SPREAD_MODE] = SPREAD_NONE;
    compileSampler(T, o + R.SPREAD, undefined, 0);
  } else if (typeof spread === 'number') {
    T[o + R.SPREAD_MODE] = SPREAD_NUMBER;
    compileSampler(T, o + R.SPREAD, spread, 0);
  } else {
    T[o + R.SPREAD_MODE] = SPREAD_SAMPLED;
    compileSampler(T, o + R.SPREAD, spread, 0);
  }
  const angleXY = cfg.angleXY;
  T[o + R.ANGLE_SET] = angleXY !== undefined ? 1 : 0;
  compileSampler(T, o + R.ANGLE, angleXY, 0);
  compileSampler(T, o + R.VX, cfg.vx, 0);
  compileSampler(T, o + R.VY, cfg.vy, 0);
  compileSampler(T, o + R.VZ, cfg.vz, 0);
  compileSampler(T, o + R.LIFE, cfg.lifespan, 1000);
  T[o + R.GRAVITY] = cfg.gravity ?? (flat ? 0 : 0.15);

  const scale = cfg.scale;
  const scaleX = cfg.scaleX;
  const scaleY = cfg.scaleY;
  const split = scale == null && scaleX != null && scaleY != null;
  T[o + R.SCALE_SPLIT] = split ? 1 : 0;
  if (split) {
    compileOp(T, o + R.SCALE_X, scaleX, 1);
    compileOp(T, o + R.SCALE_Y, scaleY, 1);
  } else {
    compileOp(T, o + R.SCALE_X, scale ?? scaleX ?? scaleY, 1);
    compileOp(T, o + R.SCALE_Y, undefined, 1);
  }
  compileOp(T, o + R.ALPHA, cfg.alpha, 1);
  compileColorOp(T, o + R.TINT, cfg.tint, 0xffffff);

  const rotC = cfg.rotC;
  const rotS = cfg.rotS;
  if (rotC != null && rotS != null) {
    T[o + R.ROT_CS] = 1;
    T[o + R.ROT_C] = rotC;
    T[o + R.ROT_S] = rotS;
    compileOp(T, o + R.ROT, undefined, 0);
  } else {
    T[o + R.ROT_CS] = 0;
    T[o + R.ROT_C] = 1;
    T[o + R.ROT_S] = 0;
    compileOp(T, o + R.ROT, cfg.rotation, 0);
  }
  const spin = cfg.angularVelocity;
  T[o + R.SPIN_SET] = spin != null ? 1 : 0;
  compileOp(T, o + R.SPIN, spin, 0);

  T[o + R.FACE] = cfg.faceDirection ? 1 : 0;
  T[o + R.FLIP_X] = cfg.flipX ? 1 : 0;
  T[o + R.FLIP_Y] = cfg.flipY ? 1 : 0;
  T[o + R.FADE] = flat ? 0 : cfg.fadeOnTheFloor ?? 0;
  T[o + R.STAY] = !flat && cfg.stayOnTheFloor ? 1 : 0;
  T[o + R.DESPAWN] = !flat && cfg.despawnOnGroundContact ? 1 : 0;
  // Floor bounces: heighted particles only (emitFlat has no floor).
  const bounces = cfg.bounces;
  T[o + R.BOUNCE_SET] = !flat && bounces != null ? 1 : 0;
  compileSampler(T, o + R.BOUNCES, bounces, 0);
  compileSampler(T, o + R.BOUNCINESS, cfg.bounciness, 0.5);
  compileSampler(T, o + R.FRICTION, cfg.bounceFriction, 0.7);
  T[o + R.BLEND] = cfg.blendMode ?? DECAL_STAMPS_BLEND_MODE.normal;
  T[o + R.RENDER_ONLY] = cfg.renderOnly ? 1 : 0;

  // lightRadius (px), stored as sqrt(I) = radius / 10, the splat's reach over 10: a number, or a {min, max} range of
  // finite radii >= 0 drawn per particle; anything else is unlit.
  const light = cfg.lightRadius;
  T[o + R.LIGHT_MODE] = 0;
  T[o + R.LIGHT_CONST] = 0;
  T[o + R.LIGHT_LO] = 0;
  T[o + R.LIGHT_HI] = 0;
  if (typeof light === 'number') {
    if (Number.isFinite(light) && light > 0) T[o + R.LIGHT_CONST] = light / 10;
  } else if (light && typeof light === 'object') {
    const lo = +light.min;
    const hi = +light.max;
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo >= 0 && hi >= 0) {
      T[o + R.LIGHT_MODE] = 1;
      T[o + R.LIGHT_LO] = lo;
      T[o + R.LIGHT_HI] = hi;
    }
  }

  const texture = cfg.texture;
  if (Array.isArray(texture)) checkTextureList(texture, 'ParticleEmitter');
}

// ---------------------------------------------------------------------------------------------------------------------
// Presets: rows compiled once, and what the emit reads by name (textures, layers) frozen beside them.
// ---------------------------------------------------------------------------------------------------------------------

let presetRows = new Float64Array(ROW_SLOTS * 16);
let presetCount = 0;
/** Per preset: { texture, spritesheet, animation, frame, anim, layer, layers } (copied, frozen). */
const presetSpecs = [];
/** Per preset: its config as defined (a copy), for the debug build's check on its first emit. */
const presetSources = [];
let presetChecked = new Uint8Array(16);
/**
 * A literal emit's config, from _emitConfig to the _emitRow it calls (its row is compiled in EMIT_ROW): null when the
 * emit is a preset's.
 */
let literalSpec = null;

function definePreset(config, mode, name) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError(`ParticleEmitter.${name}(config): config must be an object`);
  }
  for (const key of Object.keys(config)) {
    if (!EMIT_KEY_SET.has(key)) {
      throw new TypeError(`ParticleEmitter.${name}: "${key}" is not an emit key (${PARTICLE_EMIT_KEYS.join(', ')})`);
    }
  }
  const id = presetCount;
  if ((id + 1) * ROW_SLOTS > presetRows.length) {
    const grown = new Float64Array(presetRows.length * 2);
    grown.set(presetRows);
    presetRows = grown;
    const checked = new Uint8Array(presetChecked.length * 2);
    checked.set(presetChecked);
    presetChecked = checked;
  }
  compileEmit(presetRows, id * ROW_SLOTS, config, mode);
  const texture = config.texture;
  const frame = config.frame;
  const layers = config.layers;
  presetSpecs.push(Object.freeze({
    texture: Array.isArray(texture) ? Object.freeze(texture.slice()) : texture,
    spritesheet: config.spritesheet,
    animation: config.animation,
    frame: Array.isArray(frame) ? Object.freeze(frame.slice()) : frame,
    anim: config.anim,
    layer: config.layer,
    layers: Array.isArray(layers) ? Object.freeze(layers.slice()) : layers,
  }));
  presetSources.push(Object.freeze({ ...config }));
  presetChecked[id] = 0;
  presetCount = id + 1;
  return id;
}

/** The debug build's emit check, on a preset's first emit, with that emit's height and direction. */
function checkPresetOnce(id, flat, z, dirX, dirY) {
  presetChecked[id] = 1;
  const view = { ...presetSources[id] };
  if (z === z) view.z = z;
  if (dirX === dirX && dirY === dirY) {
    view.dirX = dirX;
    view.dirY = dirY;
  }
  checkEmit(view, flat);
}

// ---------------------------------------------------------------------------------------------------------------------
// The batch: the particles of one acquire batch, written from EMIT_ROW and RND (the batch's generator numbers, in the
// order each particle draws them). Everything it reads is hoisted once per batch; no call takes or returns a double.
// ---------------------------------------------------------------------------------------------------------------------

function writeBatch(batch, got) {
  const T = EMIT_ROW;
  const pc = ParticleComponent;
  const flatMode = T[R.FLAT];
  const viewMode = T[R.VIEW];
  const xK = T[R.X], xLo = T[R.X + 1], xSpan = T[R.X + 2] - xLo;
  const yK = T[R.Y], yLo = T[R.Y + 1], ySpan = T[R.Y + 2] - yLo;
  const zK = T[R.Z], zLo = T[R.Z + 1], zSpan = T[R.Z + 2] - zLo;
  const velMode = T[R.VEL_MODE];
  const dirX = T[R.DIR_X];
  const dirY = T[R.DIR_Y];
  const speedK = T[R.SPEED], speedLo = T[R.SPEED + 1], speedSpan = T[R.SPEED + 2] - speedLo;
  const spreadMode = T[R.SPREAD_MODE];
  const spreadK = T[R.SPREAD], spreadLo = T[R.SPREAD + 1], spreadSpan = T[R.SPREAD + 2] - spreadLo;
  const angleK = T[R.ANGLE], angleLo = T[R.ANGLE + 1], angleSpan = T[R.ANGLE + 2] - angleLo;
  const angleC = T[R.ANGLE_C];
  const angleS = T[R.ANGLE_S];
  const vxK = T[R.VX], vxLo = T[R.VX + 1], vxSpan = T[R.VX + 2] - vxLo;
  const vyK = T[R.VY], vyLo = T[R.VY + 1], vySpan = T[R.VY + 2] - vyLo;
  const vzK = T[R.VZ], vzLo = T[R.VZ + 1], vzSpan = T[R.VZ + 2] - vzLo;
  const lifeK = T[R.LIFE], lifeLo = T[R.LIFE + 1], lifeSpan = T[R.LIFE + 2] - lifeLo;
  const gravityValue = T[R.GRAVITY];
  const split = T[R.SCALE_SPLIT];
  const sx = R.SCALE_X;
  const sxTween = T[sx + OP_TWEEN];
  const sxFk = T[sx + OP_FROM], sxFlo = T[sx + OP_FROM + 1], sxFspan = T[sx + OP_FROM + 2] - sxFlo;
  const sxTk = T[sx + OP_TO], sxTlo = T[sx + OP_TO + 1], sxTspan = T[sx + OP_TO + 2] - sxTlo;
  const sy = R.SCALE_Y;
  const syTween = T[sy + OP_TWEEN];
  const syFk = T[sy + OP_FROM], syFlo = T[sy + OP_FROM + 1], syFspan = T[sy + OP_FROM + 2] - syFlo;
  const syTk = T[sy + OP_TO], syTlo = T[sy + OP_TO + 1], syTspan = T[sy + OP_TO + 2] - syTlo;
  const al = R.ALPHA;
  const alTween = T[al + OP_TWEEN];
  const alFk = T[al + OP_FROM], alFlo = T[al + OP_FROM + 1], alFspan = T[al + OP_FROM + 2] - alFlo;
  const alTk = T[al + OP_TO], alTlo = T[al + OP_TO + 1], alTspan = T[al + OP_TO + 2] - alTlo;
  // Tint: randomColor's lerp, per channel, of [min, max] by one number.
  const ti = R.TINT;
  const tiTween = T[ti + OP_TWEEN];
  const tiFk = T[ti + OP_FROM];
  const tiFmin = T[ti + OP_FROM + 1];
  const tiFmax = T[ti + OP_FROM + 2];
  const tiFr = (tiFmin >> 16) & 0xff, tiFg = (tiFmin >> 8) & 0xff, tiFb = tiFmin & 0xff;
  const tiFdr = ((tiFmax >> 16) & 0xff) - tiFr, tiFdg = ((tiFmax >> 8) & 0xff) - tiFg, tiFdb = (tiFmax & 0xff) - tiFb;
  const tiTk = T[ti + OP_TO];
  const tiTmin = T[ti + OP_TO + 1];
  const tiTmax = T[ti + OP_TO + 2];
  const tiTr = (tiTmin >> 16) & 0xff, tiTg = (tiTmin >> 8) & 0xff, tiTb = tiTmin & 0xff;
  const tiTdr = ((tiTmax >> 16) & 0xff) - tiTr, tiTdg = ((tiTmax >> 8) & 0xff) - tiTg, tiTdb = (tiTmax & 0xff) - tiTb;
  const rotMode = T[R.ROT_MODE];
  const csC = T[R.ROT_C];
  const csS = T[R.ROT_S];
  const ro = R.ROT;
  const roTween = T[ro + OP_TWEEN];
  const roFk = T[ro + OP_FROM], roFlo = T[ro + OP_FROM + 1], roFspan = T[ro + OP_FROM + 2] - roFlo;
  const roTk = T[ro + OP_TO], roTlo = T[ro + OP_TO + 1], roTspan = T[ro + OP_TO + 2] - roTlo;
  // A rotation that draws nothing is the same for every particle: its radians, cos and sin once.
  const roFixed = roFk === 0 && (roTween === 0 || roTk === 0);
  const roFromRad = (roFlo * Math.PI) / 180;
  const roToRad = ((roTween !== 0 ? roTlo : roFlo) * Math.PI) / 180;
  const roC = roFixed ? Math.cos(roFromRad) : 1;
  const roS = roFixed ? Math.sin(roFromRad) : 0;
  const spinSet = T[R.SPIN_SET];
  const sp = R.SPIN;
  const spTween = T[sp + OP_TWEEN];
  const spFk = T[sp + OP_FROM], spFlo = T[sp + OP_FROM + 1], spFspan = T[sp + OP_FROM + 2] - spFlo;
  const spTk = T[sp + OP_TO], spTlo = T[sp + OP_TO + 1], spTspan = T[sp + OP_TO + 2] - spTlo;
  const flipXValue = T[R.FLIP_X];
  const flipYValue = T[R.FLIP_Y];
  const fadeValue = T[R.FADE];
  const stayValue = T[R.STAY];
  const despawnValue = T[R.DESPAWN];
  const bouncing = T[R.BOUNCE_SET];
  const bnK = T[R.BOUNCES], bnLo = T[R.BOUNCES + 1], bnSpan = T[R.BOUNCES + 2] - bnLo;
  const bsK = T[R.BOUNCINESS], bsLo = T[R.BOUNCINESS + 1], bsSpan = T[R.BOUNCINESS + 2] - bsLo;
  const bfK = T[R.FRICTION], bfLo = T[R.FRICTION + 1], bfSpan = T[R.FRICTION + 2] - bfLo;
  const blendValue = T[R.BLEND];
  const renderOnlyValue = T[R.RENDER_ONLY];
  const lightConst = T[R.LIGHT_CONST];
  const lightDraw = T[R.LIGHT_DRAW];
  const lightLo = T[R.LIGHT_LO];
  const lightSpan = T[R.LIGHT_HI] - lightLo;
  const maskValue = T[R.MASK];
  const easeIdValue = T[R.EASE_ID];
  const easeIdsValue = T[R.EASE_IDS];
  const textureId = T[R.TEXTURE_ID];
  const choices = T[R.CHOICES];
  const framesOn = T[R.FRAMES_ON];
  const framesN = T[R.FRAMES_N];
  const framesCycle = T[R.FRAMES_CYCLE];
  const subMask = T[R.SUB_MASK];

  const active = pc.active;
  const x = pc.x;
  const y = pc.y;
  const z = pc.z;
  const vx = pc.vx;
  const vy = pc.vy;
  const vz = pc.vz;
  const lifespan = pc.lifespan;
  const currentLife = pc.currentLife;
  const gravity = pc.gravity;
  const scaleX = pc.scaleX;
  const scaleY = pc.scaleY;
  const alpha = pc.alpha;
  const tint = pc.tint;
  const baseTint = pc.baseTint;
  const particleTextureId = pc.textureId;
  const fadeOnTheFloor = pc.fadeOnTheFloor;
  const timeOnFloor = pc.timeOnFloor;
  const initialAlpha = pc.initialAlpha;
  const stayOnTheFloor = pc.stayOnTheFloor;
  const despawnOnGroundContact = pc.despawnOnGroundContact;
  const bounces = pc.bounces;
  const bounciness = pc.bounciness;
  const bounceFriction = pc.bounceFriction;
  const tweenMask = pc.tweenMask;
  const easeIdArr = pc.easeId;
  const easeIdsArr = pc.easeIds;
  const alphaFrom = pc.alphaFrom;
  const alphaTo = pc.alphaTo;
  const scaleXFrom = pc.scaleXFrom;
  const scaleXTo = pc.scaleXTo;
  const scaleYFrom = pc.scaleYFrom;
  const scaleYTo = pc.scaleYTo;
  const tintFrom = pc.tintFrom;
  const tintTo = pc.tintTo;
  const rotFrom = pc.rotFrom;
  const rotTo = pc.rotTo;
  const angularVelFrom = pc.angularVelFrom;
  const angularVelTo = pc.angularVelTo;
  const hasAngularVel = pc.hasAngularVel;
  const animCountArr = pc.animCount;
  const animModeArr = pc.animMode;
  const animFrames = pc.animFrames;
  const rotCArr = pc.rotC;
  const rotSArr = pc.rotS;
  const flipX = pc.flipX;
  const flipY = pc.flipY;
  const blendMode = pc.blendMode;
  const layerMask = pc.layerMask;
  const flat = pc.flat;
  const viewModeArr = pc.viewMode;
  const renderOnly = pc.renderOnly;
  const renderOnlyLive = pc.renderOnlyLive;
  const lightSqrt = pc.lightSqrt;

  let r = 0;
  for (let b = 0; b < got; b++) {
    const i = batch[b];
    // A texture list: one picked per particle, its first number (a list is new in E-538, so it draws before the rest).
    let texId = textureId;
    if (choices > 1) texId = CHOICE_IDS[(RND[r++] * choices) | 0];

    x[i] = xK !== 0 ? xLo + RND[r++] * xSpan : xLo;
    y[i] = yK !== 0 ? yLo + RND[r++] * ySpan : yLo;
    // P5: flat particles never read z (see particleIntegrate.js's flat branch): no write, no draw.
    if (flatMode === 0) z[i] = zK !== 0 ? zLo + RND[r++] * zSpan : zLo;

    // The velocity; and the direction a facing particle turns to.
    let pvx;
    let pvy;
    let faceC = dirX;
    let faceS = dirY;
    if (velMode === VEL_DIR) {
      // Unit dir + speed (+ optional spread radians) — no deg/atan2
      const speed = speedK !== 0 ? speedLo + RND[r++] * speedSpan : speedLo;
      let dx = dirX;
      let dy = dirY;
      if (spreadMode !== SPREAD_NONE) {
        const ang =
          spreadMode === SPREAD_NUMBER
            ? (RND[r++] * 2 - 1) * spreadLo
            : spreadK !== 0 ? spreadLo + RND[r++] * spreadSpan : spreadLo;
        if (ang !== 0) {
          const sc = Math.cos(ang);
          const ss = Math.sin(ang);
          const rdx = dx * sc - dy * ss;
          const rdy = dx * ss + dy * sc;
          dx = rdx;
          dy = rdy;
        }
      }
      pvx = dx * speed;
      pvy = dy * speed;
      faceC = dx;
      faceS = dy;
    } else if (velMode === VEL_ANGLE) {
      let c = angleC;
      let s = angleS;
      if (angleK !== 0) {
        const angleRad = ((angleLo + RND[r++] * angleSpan) * Math.PI) / 180;
        c = Math.cos(angleRad);
        s = Math.sin(angleRad);
      }
      const speed = speedK !== 0 ? speedLo + RND[r++] * speedSpan : speedLo;
      pvx = speed * c;
      pvy = speed * s;
      faceC = c;
      faceS = s;
    } else {
      pvx = vxK !== 0 ? vxLo + RND[r++] * vxSpan : vxLo;
      pvy = vyK !== 0 ? vyLo + RND[r++] * vySpan : vyLo;
    }
    vx[i] = pvx;
    vy[i] = pvy;
    // P5: flat particles never read vz either — skip the write.
    if (flatMode === 0) vz[i] = vzK !== 0 ? vzLo + RND[r++] * vzSpan : vzLo;

    lifespan[i] = lifeK !== 0 ? lifeLo + RND[r++] * lifeSpan : lifeLo;
    currentLife[i] = 0;
    gravity[i] = gravityValue;

    // Visual ops: number | {min,max} | {from,to[,ease]} (endpoints may nest {min,max}), each drawn from, then to.
    if (split !== 0) {
      const fromX = sxFk !== 0 ? sxFlo + RND[r++] * sxFspan : sxFlo;
      const toX = sxTween !== 0 ? (sxTk !== 0 ? sxTlo + RND[r++] * sxTspan : sxTlo) : fromX;
      const fromY = syFk !== 0 ? syFlo + RND[r++] * syFspan : syFlo;
      const toY = syTween !== 0 ? (syTk !== 0 ? syTlo + RND[r++] * syTspan : syTlo) : fromY;
      scaleX[i] = fromX;
      scaleY[i] = fromY;
      scaleXFrom[i] = fromX;
      scaleXTo[i] = toX;
      scaleYFrom[i] = fromY;
      scaleYTo[i] = toY;
    } else {
      const from = sxFk !== 0 ? sxFlo + RND[r++] * sxFspan : sxFlo;
      const to = sxTween !== 0 ? (sxTk !== 0 ? sxTlo + RND[r++] * sxTspan : sxTlo) : from;
      scaleX[i] = from;
      scaleY[i] = from;
      scaleXFrom[i] = from;
      scaleXTo[i] = to;
      scaleYFrom[i] = from;
      scaleYTo[i] = to;
    }

    const aFrom = alFk !== 0 ? alFlo + RND[r++] * alFspan : alFlo;
    const aTo = alTween !== 0 ? (alTk !== 0 ? alTlo + RND[r++] * alTspan : alTlo) : aFrom;
    alpha[i] = aFrom;
    alphaFrom[i] = aFrom;
    alphaTo[i] = aTo;

    let cFrom = tiFmin;
    if (tiFk !== 0) {
      const t = RND[r++];
      cFrom = (Math.round(tiFr + t * tiFdr) << 16) | (Math.round(tiFg + t * tiFdg) << 8) | Math.round(tiFb + t * tiFdb);
    }
    let cTo = cFrom;
    if (tiTween !== 0) {
      cTo = tiTmin;
      if (tiTk !== 0) {
        const t = RND[r++];
        cTo = (Math.round(tiTr + t * tiTdr) << 16) | (Math.round(tiTg + t * tiTdg) << 8) | Math.round(tiTb + t * tiTdb);
      }
    }
    tint[i] = cFrom;
    baseTint[i] = cFrom;
    tintFrom[i] = cFrom;
    tintTo[i] = cTo;

    if (rotMode === ROT_CS) {
      rotCArr[i] = csC;
      rotSArr[i] = csS;
      rotFrom[i] = 0;
      rotTo[i] = 0;
    } else if (rotMode === ROT_FACE) {
      rotCArr[i] = faceC;
      rotSArr[i] = faceS;
      rotFrom[i] = 0;
      rotTo[i] = 0;
    } else if (roFixed) {
      rotFrom[i] = roFromRad;
      rotTo[i] = roToRad;
      rotCArr[i] = roC;
      rotSArr[i] = roS;
    } else {
      const from = roFk !== 0 ? roFlo + RND[r++] * roFspan : roFlo;
      const to = roTween !== 0 ? (roTk !== 0 ? roTlo + RND[r++] * roTspan : roTlo) : from;
      const fromRad = (from * Math.PI) / 180;
      const toRad = (to * Math.PI) / 180;
      rotFrom[i] = fromRad;
      rotTo[i] = toRad;
      rotCArr[i] = Math.cos(fromRad);
      rotSArr[i] = Math.sin(fromRad);
    }

    if (spinSet !== 0) {
      const from = spFk !== 0 ? spFlo + RND[r++] * spFspan : spFlo;
      const fromRad = (from * Math.PI) / 180;
      angularVelFrom[i] = fromRad;
      if (spTween !== 0) {
        const to = spTk !== 0 ? spTlo + RND[r++] * spTspan : spTlo;
        angularVelTo[i] = (to * Math.PI) / 180;
      } else {
        angularVelTo[i] = fromRad;
      }
      hasAngularVel[i] = 1;
    } else {
      angularVelFrom[i] = 0;
      angularVelTo[i] = 0;
      hasAngularVel[i] = 0;
    }

    flipX[i] = flipXValue;
    flipY[i] = flipYValue;
    fadeOnTheFloor[i] = fadeValue;
    timeOnFloor[i] = 0;
    initialAlpha[i] = 0;
    easeIdsArr[i] = easeIdsValue;
    tweenMask[i] = maskValue;
    easeIdArr[i] = easeIdValue;

    animCountArr[i] = 0;
    animModeArr[i] = 0;
    if (framesOn !== 0) {
      const animBase = i * 8;
      for (let f = 0; f < framesN; f++) animFrames[animBase + f] = FRAME_IDS[f];
      if (framesCycle !== 0) {
        animCountArr[i] = framesN;
        animModeArr[i] = 1;
        particleTextureId[i] = animFrames[animBase];
      } else if (framesN > 0) {
        const pick = framesN === 1 ? 0 : (RND[r++] * framesN) | 0;
        particleTextureId[i] = animFrames[animBase + pick];
      } else {
        particleTextureId[i] = texId;
      }
    } else {
      particleTextureId[i] = texId;
    }

    stayOnTheFloor[i] = stayValue;
    despawnOnGroundContact[i] = despawnValue;
    if (bouncing !== 0) {
      const n = Math.round(bnK !== 0 ? bnLo + RND[r++] * bnSpan : bnLo);
      bounces[i] = n > 255 ? 255 : n > 0 ? n : 0;
      bounciness[i] = bsK !== 0 ? bsLo + RND[r++] * bsSpan : bsLo;
      bounceFriction[i] = bfK !== 0 ? bfLo + RND[r++] * bfSpan : bfLo;
    } else {
      bounces[i] = 0;
    }

    blendMode[i] = blendValue;
    if (layerMask) {
      layerMask[i] = subMask;
      syncParticleFeed(i, 0, subMask);
    }

    flat[i] = flatMode;
    viewModeArr[i] = viewMode;
    if (renderOnly) {
      renderOnly[i] = renderOnlyValue;
      if (renderOnlyValue !== 0 && renderOnlyLive) Atomics.add(renderOnlyLive, 0, 1);
    }

    if (lightSqrt) {
      let s = lightConst;
      if (lightDraw !== 0) {
        const v = lightLo + RND[r++] * lightSpan;
        s = v > 0 ? v / 10 : 0;
      }
      lightSqrt[i] = s;
    }

    active[i] = 1;
  }
}

/** The numbers a sampler draws per particle. */
function samplerDraws(T, at) {
  return T[at] !== 0 ? 1 : 0;
}

/** The numbers an op draws per particle: from, and to when it tweens. */
function opDraws(T, at) {
  return samplerDraws(T, at + OP_FROM) + (T[at + OP_TWEEN] !== 0 ? samplerDraws(T, at + OP_TO) : 0);
}

export class ParticleEmitter extends SharedAtomicPool {
  // Pool name for logging (used by base class)
  static poolName = 'ParticleEmitter';
  // E-129: 32-bit slot ids past 65 535 particles.
  static slotIdsFromMax = true;
  static _warnedPoolExhausted = false;
  static _acquireBatch = ACQUIRE_BATCH_U16;
  /** emitPreset's arguments and the with* overrides (EMIT_ARGS): read through the class, not the module's binding,
   * whose load and hole check would take emitPreset past V8's 75-byte inline size (particlePresetFronts.test.js). */
  static _emitArgs = EMIT_ARGS;

  /**
   * Initialize the emitter with particle pool size
   * Called during Scene buffer setup and again when workers bind SABs
   * @param {number} maxParticles - Number of particles in pool
   */
  static initialize(maxParticles) {
    // Call base class initialize with the count
    super.initialize(maxParticles);
    this._warnedPoolExhausted = false;
  }

  static initializeFreeList(freeListBuffer, freeListTopBuffer) {
    super.initializeFreeList(freeListBuffer, freeListTopBuffer);
    this._acquireBatch = this.freeList instanceof Uint32Array ? new Uint32Array(256) : ACQUIRE_BATCH_U16;
  }

  static returnToPool(index) {
    const i = index | 0;
    if (ParticleComponent.lightSqrt && ParticleComponent.lightSqrt[i]) {
      ParticleComponent.lightSqrt[i] = 0;
    }
    if (ParticleComponent.layerMask) {
      const old = ParticleComponent.layerMask[i] | 0;
      if (old) {
        ParticleComponent.layerMask[i] = 0;
        syncParticleFeed(i, old, 0);
      }
    }
    if (ParticleComponent.renderOnly && ParticleComponent.renderOnly[i]) {
      ParticleComponent.renderOnly[i] = 0;
      if (ParticleComponent.renderOnlyLive) Atomics.add(ParticleComponent.renderOnlyLive, 0, -1);
    }
    super.returnToPool(index);
  }

  /**
   * Heighted particles: drawn at screenY = y + z (topdown / side / iso), y-sorted by their ground row y.
   * The one-off form: the config is read on every call. A burst a game fires again and again is a preset (define).
   * @param {Object} config - Particle emission configuration
   * @returns {number} - Number of particles actually spawned
   */
  static emit(config) {
    return this._emitConfig(config, MODE_TOPDOWN);
  }

  /**
   * Heighted particles with zenithal presentation: XY on floor, scale/alpha from -z.
   * Projection curve comes from scene particle.zenithal* knobs.
   * @param {Object} config - Same shape as emit()
   * @returns {number} - Number of particles actually spawned
   */
  static emitZenithal(config) {
    return this._emitConfig(config, MODE_ZENITHAL);
  }

  /**
   * Flat (screen-plane) particles: no ground plane, always integrate XY.
   * Gravity (px/frame², dtRatio ≈ 1 at 60fps) applies to vy. Floor flags ignored.
   * @param {Object} config - Same shape as emit(); floor flags are ignored by the worker
   * @returns {number} - Number of particles actually spawned
   */
  static emitFlat(config) {
    return this._emitConfig(config, MODE_FLAT);
  }

  /**
   * GPU particles: written once into a LAYER_KIND.GPU_PARTICLES layer and computed in the vertex shader from then
   * on. No CPU cost per frame, and no 65 535 ceiling; in exchange nothing reads them back (no collisions, no
   * decals, no floor), and they are not saved. `layer` names the GPU layer. The keys of emit / emitFlat where the
   * motion has a closed form, plus `heighted` (emit's height model; default flat), `drag` (1/s), `delay` (ms) and
   * `sortY` (the group's ground y among the entities, with the layer's `sortWithEntities`). Any thread that runs
   * game code can call it: the main thread, a logic worker, the particle worker. It has its own config path: the
   * with* overrides are not read by it.
   * @param {Object} config
   * @returns {number} particles written
   */
  static emitGpu(config) {
    return GpuParticles._emit(config);
  }

  /**
   * Flat particles sampled uniformly along segment (x0,y0)→(x1,y1).
   * Remaining fields match emitFlat(); each sample uses count: 1 at the lerped position.
   * @param {Object} config
   * @param {number} config.x0
   * @param {number} config.y0
   * @param {number} config.x1
   * @param {number} config.y1
   * @param {number|{min:number,max:number}} [config.count=8] - sample count along line
   * @returns {number}
   */
  static emitAlongLine(config) {
    const x0 = config.x0;
    const y0 = config.y0;
    const x1 = config.x1;
    const y1 = config.y1;
    const n = Math.max(1, Math.round(randomRange(config.count ?? 8, 8)));
    const dx = x1 - x0;
    const dy = y1 - y0;
    // The with* overrides hold for every sample of the line: each sample's emit clears them.
    const a = EMIT_ARGS;
    const saved = SAVED_OVERRIDES;
    for (let k = 0; k < 6; k++) saved[k] = a[ARG_VZ + k];
    let spawned = 0;
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 1);
      for (let k = 0; k < 6; k++) a[ARG_VZ + k] = saved[k];
      a[ARG_X] = x0 + dx * t;
      a[ARG_Y] = y0 + dy * t;
      a[ARG_COUNT] = 1;
      spawned += this._emitConfig(config, MODE_FLAT);
    }
    return spawned;
  }

  /**
   * A heighted preset (emit's mode): the config compiled once, for emitPreset. Define presets once, at module level:
   * a preset lives as long as its module (a scene change keeps it), and each thread that imports the module has its
   * own. The keys are emit's (PARTICLE_EMIT_KEYS), each a value, a {min, max} range drawn per particle, or an
   * over-life {from, to, ease}; `texture` may be a list of names, one picked per particle. A key emit does not know
   * throws a TypeError.
   * @param {Object} config
   * @returns {number} the preset's id
   */
  static define(config) {
    return definePreset(config, MODE_TOPDOWN, 'define');
  }

  /**
   * A zenithal preset (emitZenithal's mode).
   * @param {Object} config
   * @returns {number} the preset's id
   */
  static defineZenithal(config) {
    return definePreset(config, MODE_ZENITHAL, 'defineZenithal');
  }

  /**
   * A flat preset (emitFlat's mode: no floor; gravity defaults to 0 and pulls on vy).
   * @param {Object} config
   * @returns {number} the preset's id
   */
  static defineFlat(config) {
    return definePreset(config, MODE_FLAT, 'defineFlat');
  }

  /**
   * Particles from a preset, with what varies per emit. Each argument left undefined keeps the preset's value; given,
   * it replaces it for this emit (a value, not a range). The same particles as emit() with the preset's config and
   * these keys, the same numbers drawn from the generator; and nothing allocated.
   *
   * A front small enough to be inlined whatever its caller's budget (V8 inlines a callee of 75 bytes of bytecode or
   * less when it is passed a heap number): the doubles go through a Float64Array, and the core it calls takes the
   * preset's id and is too big for TurboFan to inline, so a caller spends no more of its inlining budget than the
   * front's own bytes.
   * @param {number} preset - define()'s id
   * @param {number} [x]
   * @param {number} [y]
   * @param {number} [z] - Heighted modes only (z < 0 is up)
   * @param {number} [count] - Rounded, as emit's count
   * @param {number} [dirX] - With dirY: the direction of a preset with `speed` (turned by its `spread`), and where a
   *   `faceDirection` preset's particles face
   * @param {number} [dirY]
   * @returns {number} particles spawned
   */
  static emitPreset(preset, x, y, z, count, dirX, dirY) {
    const a = this._emitArgs;
    a[0] = x;
    a[1] = y;
    a[2] = z;
    a[3] = count;
    a[4] = dirX;
    a[5] = dirY;
    return this._emitRow(preset);
  }

  /**
   * The next emit on this thread (emitPreset, emit, emitZenithal, emitFlat, emitAlongLine) launches every particle
   * at this vz, whatever its preset or config says. Returns ParticleEmitter, to chain into the emit.
   * @param {number} vz
   */
  static withVz(vz) {
    EMIT_ARGS[ARG_VZ] = vz;
    return this;
  }

  /**
   * The next emit on this thread flips every particle so (true / false each), whatever its preset or config says.
   * @param {boolean} flipX
   * @param {boolean} flipY
   */
  static withFlip(flipX, flipY) {
    EMIT_ARGS[ARG_FLIP_X] = flipX ? 1 : 0;
    EMIT_ARGS[ARG_FLIP_Y] = flipY ? 1 : 0;
    return this;
  }

  /**
   * The next emit on this thread multiplies its scale by `factor`: every value and range end of scale (or scaleX and
   * scaleY), from and to alike, before the draws.
   * @param {number} factor
   */
  static withScaleFactor(factor) {
    EMIT_ARGS[ARG_SCALE_FACTOR] = factor;
    return this;
  }

  /**
   * The next emit on this thread multiplies its alpha by `factor` (every value and range end, from and to).
   * @param {number} factor
   */
  static withAlphaFactor(factor) {
    EMIT_ARGS[ARG_ALPHA_FACTOR] = factor;
    return this;
  }

  /**
   * The next emit on this thread multiplies its `speed` by `factor` (both range ends): the launch speed along a
   * direction or an angleXY, not vx, vy or vz.
   * @param {number} factor
   */
  static withSpeedFactor(factor) {
    EMIT_ARGS[ARG_SPEED_FACTOR] = factor;
    return this;
  }

  /** A literal config's emit: compiled into the emit's row, then the emit. */
  static _emitConfig(config, mode) {
    if (!this.initialized) {
      clearEmitArgs();
      return 0;
    }
    try {
      compileEmit(EMIT_ROW, 0, config, mode);
    } catch (error) {
      clearEmitArgs();
      throw error;
    }
    literalSpec = config;
    return this._emitRow(-1);
  }

  /**
   * The emit: a preset's row copied into EMIT_ROW (a literal emit compiled its config there), the emit's arguments and
   * overrides over it, what every particle shares worked out once, then the particles a batch at a time.
   * @param {number} preset - emitPreset's preset; ignored for a literal emit (literalSpec set)
   * @returns {number}
   */
  static _emitRow(preset) {
    const T = EMIT_ROW;
    const a = EMIT_ARGS;
    // What the emit reads by name (texture, spritesheet, animation, frame, anim, layer, layers): the literal config, or
    // the preset's frozen copy of it.
    let spec = literalSpec;
    if (spec !== null) {
      literalSpec = null;
      preset = -1;
    } else {
      if (!(preset >= 0 && preset < presetCount) || (preset | 0) !== preset) {
        clearEmitArgs();
        throw new TypeError(`ParticleEmitter.emitPreset: ${preset} is not a preset (ParticleEmitter.define's id)`);
      }
      if (!this.initialized) {
        clearEmitArgs();
        return 0;
      }
      const rows = presetRows;
      const o = preset * ROW_SLOTS;
      for (let k = 0; k < ROW_SLOTS; k++) T[k] = rows[o + k];
      spec = presetSpecs[preset];
    }
    const argX = a[ARG_X];
    const argY = a[ARG_Y];
    const argZ = a[ARG_Z];
    const argDirX = a[ARG_DIR_X];
    const argDirY = a[ARG_DIR_Y];
    const argCount = a[ARG_COUNT];
    const argVz = a[ARG_VZ];
    const argFlipX = a[ARG_FLIP_X];
    const argFlipY = a[ARG_FLIP_Y];
    const scaleFactor = a[ARG_SCALE_FACTOR];
    const alphaFactor = a[ARG_ALPHA_FACTOR];
    const speedFactor = a[ARG_SPEED_FACTOR];
    clearEmitArgs();

    // This emit's values over the row: each a value (kind 0).
    if (argX === argX) {
      T[R.X] = 0;
      T[R.X + 1] = argX;
    }
    if (argY === argY) {
      T[R.Y] = 0;
      T[R.Y + 1] = argY;
    }
    if (argZ === argZ) {
      T[R.Z] = 0;
      T[R.Z + 1] = argZ;
    }
    if (argDirX === argDirX && argDirY === argDirY) {
      T[R.DIR_SET] = 1;
      T[R.DIR_X] = argDirX;
      T[R.DIR_Y] = argDirY;
    }
    if (argCount === argCount) {
      T[R.COUNT] = 0;
      T[R.COUNT + 1] = argCount;
    }
    if (argVz === argVz) {
      T[R.VZ] = 0;
      T[R.VZ + 1] = argVz;
    }
    if (argFlipX === argFlipX) T[R.FLIP_X] = argFlipX;
    if (argFlipY === argFlipY) T[R.FLIP_Y] = argFlipY;
    if (speedFactor !== 1) {
      T[R.SPEED + 1] *= speedFactor;
      T[R.SPEED + 2] *= speedFactor;
    }
    if (scaleFactor !== 1) {
      // scale (or scaleX), and scaleY: it holds a value only when scaleX and scaleY are apart.
      const sx = R.SCALE_X;
      T[sx + OP_FROM + 1] *= scaleFactor;
      T[sx + OP_FROM + 2] *= scaleFactor;
      T[sx + OP_TO + 1] *= scaleFactor;
      T[sx + OP_TO + 2] *= scaleFactor;
      const sy = R.SCALE_Y;
      T[sy + OP_FROM + 1] *= scaleFactor;
      T[sy + OP_FROM + 2] *= scaleFactor;
      T[sy + OP_TO + 1] *= scaleFactor;
      T[sy + OP_TO + 2] *= scaleFactor;
    }
    if (alphaFactor !== 1) {
      const op = R.ALPHA;
      T[op + OP_FROM + 1] *= alphaFactor;
      T[op + OP_FROM + 2] *= alphaFactor;
      T[op + OP_TO + 1] *= alphaFactor;
      T[op + OP_TO + 2] *= alphaFactor;
    }

    const flatMode = T[R.FLAT];
    // DX-GUARDS E5 (debug build): an emit whose particles would stop on their first step.
    if (preset < 0) checkEmit(spec, flatMode === 1);
    else if (presetChecked[preset] === 0) checkPresetOnce(preset, flatMode === 1, argZ, argDirX, argDirY);

    let count;
    if (T[R.COUNT] !== 0) {
      fillDraws(1);
      count = Math.round(T[R.COUNT + 1] + RND[0] * (T[R.COUNT + 2] - T[R.COUNT + 1]));
    } else {
      count = Math.round(T[R.COUNT + 1]);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TEXTURE RESOLUTION (by name, once per emit)
    // ═══════════════════════════════════════════════════════════════════════
    let textureId = 0;
    let choices = 0;
    const texture = spec.texture;
    const sheet = spec.spritesheet;
    const animation = spec.animation;
    const frame = spec.frame;
    const frameList = Array.isArray(frame);
    if (sheet && animation !== undefined && !frameList) {
      const frameName = SpriteSheetRegistry.getFrameName(sheet, animation, frame ?? 0);
      if (!frameName) {
        console.warn(
          `ParticleEmitter.emit: Could not resolve frame for ` +
          `spritesheet="${sheet}", animation="${animation}", frame=${frame ?? 0}`
        );
      } else {
        textureId = SpriteSheetRegistry.getTextureId(frameName);
      }
    } else if (Array.isArray(texture)) {
      choices = texture.length;
      for (let k = 0; k < choices; k++) {
        const name = texture[k];
        CHOICE_IDS[k] = name ? SpriteSheetRegistry.getTextureId(name) : 0;
      }
      textureId = CHOICE_IDS[0];
    } else if (texture) {
      textureId = SpriteSheetRegistry.getTextureId(texture);
    }
    // A frame list (cycled over life, or one picked): its frames' ids.
    const framesOn = frameList && sheet && animation !== undefined;
    let framesN = 0;
    if (framesOn) {
      const n = Math.min(MAX_TEXTURE_CHOICES, frame.length);
      for (let f = 0; f < n; f++) {
        const frameName = SpriteSheetRegistry.getFrameName(sheet, animation, frame[f]);
        if (!frameName) continue;
        FRAME_IDS[framesN] = SpriteSheetRegistry.getTextureId(frameName);
        framesN++;
      }
    }
    const framesCycle = framesN > 1 && spec.anim !== 'random';
    const framesRandom = framesN > 1 && spec.anim === 'random';

    const subMask = Layer.resolveSubscriptions(spec);
    if (!ParticleComponent.flat || !ParticleComponent.viewMode) {
      console.error(
        'ParticleEmitter._emitRow: ParticleComponent schema missing — hard-reload after schema change'
      );
      return 0;
    }

    // What every particle of the emit shares.
    const dirSet = T[R.DIR_SET] !== 0;
    const speedSet = T[R.SPEED_SET] !== 0;
    const velMode = dirSet && speedSet ? VEL_DIR : T[R.ANGLE_SET] !== 0 && speedSet ? VEL_ANGLE : VEL_AXES;
    const facing = T[R.FACE] !== 0 && (dirSet || velMode === VEL_ANGLE);
    const rotMode = T[R.ROT_CS] !== 0 ? ROT_CS : facing ? ROT_FACE : ROT_OP;
    if (velMode === VEL_ANGLE && T[R.ANGLE] === 0) {
      const angleRad = (T[R.ANGLE + 1] * Math.PI) / 180;
      T[R.ANGLE_C] = Math.cos(angleRad);
      T[R.ANGLE_S] = Math.sin(angleRad);
    } else {
      T[R.ANGLE_C] = 1;
      T[R.ANGLE_S] = 0;
    }

    // One ease for every tweened property when they agree (the usual case: the kernel eases once);
    // otherwise MIXED_EASE, and easeIds holds each property's.
    const split = T[R.SCALE_SPLIT] !== 0;
    let mask = 0;
    let easeAlpha = 0;
    let easeScaleX = 0;
    let easeScaleY = 0;
    let easeTint = 0;
    let easeRot = 0;
    let easeAngVel = -1; // -1: angular velocity is not tweened
    if (split) {
      if (T[R.SCALE_X + OP_TWEEN] !== 0) { mask |= PARTICLE_TWEEN.SCALEX; easeScaleX = T[R.SCALE_X + OP_EASE]; }
      if (T[R.SCALE_Y + OP_TWEEN] !== 0) { mask |= PARTICLE_TWEEN.SCALEY; easeScaleY = T[R.SCALE_Y + OP_EASE]; }
    } else if (T[R.SCALE_X + OP_TWEEN] !== 0) {
      mask |= PARTICLE_TWEEN.SCALEX | PARTICLE_TWEEN.SCALEY;
      easeScaleX = T[R.SCALE_X + OP_EASE];
      easeScaleY = easeScaleX;
    }
    if (T[R.ALPHA + OP_TWEEN] !== 0) { mask |= PARTICLE_TWEEN.ALPHA; easeAlpha = T[R.ALPHA + OP_EASE]; }
    if (T[R.TINT + OP_TWEEN] !== 0) { mask |= PARTICLE_TWEEN.TINT; easeTint = T[R.TINT + OP_EASE]; }
    if (rotMode === ROT_OP && T[R.ROT + OP_TWEEN] !== 0) { mask |= PARTICLE_TWEEN.ROT; easeRot = T[R.ROT + OP_EASE]; }
    if (T[R.SPIN_SET] !== 0 && T[R.SPIN + OP_TWEEN] !== 0) easeAngVel = T[R.SPIN + OP_EASE];
    let ease = -1;
    let mixed = false;
    if (mask & PARTICLE_TWEEN.ALPHA) ease = easeAlpha;
    if (mask & PARTICLE_TWEEN.SCALEX) { if (ease < 0) ease = easeScaleX; else if (easeScaleX !== ease) mixed = true; }
    if (mask & PARTICLE_TWEEN.SCALEY) { if (ease < 0) ease = easeScaleY; else if (easeScaleY !== ease) mixed = true; }
    if (mask & PARTICLE_TWEEN.TINT) { if (ease < 0) ease = easeTint; else if (easeTint !== ease) mixed = true; }
    if (mask & PARTICLE_TWEEN.ROT) { if (ease < 0) ease = easeRot; else if (easeRot !== ease) mixed = true; }
    if (easeAngVel >= 0) { if (ease < 0) ease = easeAngVel; else if (easeAngVel !== ease) mixed = true; }
    let easeIds = 0;
    if (mixed) {
      mask |= PARTICLE_TWEEN.MIXED_EASE;
      easeIds =
        ((easeAlpha << PARTICLE_EASE_SHIFT.ALPHA) |
          (easeScaleX << PARTICLE_EASE_SHIFT.SCALEX) |
          (easeScaleY << PARTICLE_EASE_SHIFT.SCALEY) |
          (easeTint << PARTICLE_EASE_SHIFT.TINT) |
          (easeRot << PARTICLE_EASE_SHIFT.ROT) |
          ((easeAngVel < 0 ? 0 : easeAngVel) << PARTICLE_EASE_SHIFT.ANGULAR_VELOCITY)) >>> 0;
    }
    const lightDraw = T[R.LIGHT_MODE] !== 0 && ParticleComponent.lightSqrt ? 1 : 0;

    // The numbers each particle draws, in the order writeBatch draws them.
    const heighted = flatMode === 0;
    let draws = choices > 1 ? 1 : 0;
    draws += samplerDraws(T, R.X) + samplerDraws(T, R.Y);
    if (heighted) draws += samplerDraws(T, R.Z);
    if (velMode === VEL_DIR) {
      draws += samplerDraws(T, R.SPEED);
      if (T[R.SPREAD_MODE] === SPREAD_NUMBER) draws += 1;
      else if (T[R.SPREAD_MODE] === SPREAD_SAMPLED) draws += samplerDraws(T, R.SPREAD);
    } else if (velMode === VEL_ANGLE) {
      draws += samplerDraws(T, R.ANGLE) + samplerDraws(T, R.SPEED);
    } else {
      draws += samplerDraws(T, R.VX) + samplerDraws(T, R.VY);
    }
    if (heighted) draws += samplerDraws(T, R.VZ);
    draws += samplerDraws(T, R.LIFE);
    draws += opDraws(T, R.SCALE_X);
    if (split) draws += opDraws(T, R.SCALE_Y);
    draws += opDraws(T, R.ALPHA) + opDraws(T, R.TINT);
    if (rotMode === ROT_OP) draws += opDraws(T, R.ROT);
    if (T[R.SPIN_SET] !== 0) draws += opDraws(T, R.SPIN);
    if (framesRandom) draws += 1;
    if (T[R.BOUNCE_SET] !== 0) {
      draws += samplerDraws(T, R.BOUNCES) + samplerDraws(T, R.BOUNCINESS) + samplerDraws(T, R.FRICTION);
    }
    draws += lightDraw;

    T[R.VEL_MODE] = velMode;
    T[R.ROT_MODE] = rotMode;
    T[R.MASK] = mask;
    T[R.EASE_ID] = ease < 0 ? PARTICLE_EASE.LERP : ease;
    T[R.EASE_IDS] = easeIds;
    T[R.TEXTURE_ID] = textureId;
    T[R.CHOICES] = choices;
    T[R.FRAMES_ON] = framesOn ? 1 : 0;
    T[R.FRAMES_N] = framesN;
    T[R.FRAMES_CYCLE] = framesCycle ? 1 : 0;
    T[R.SUB_MASK] = subMask;
    T[R.LIGHT_DRAW] = lightDraw;
    T[R.DRAWS] = draws;

    let spawned = 0;
    while (spawned < count) {
      const want = Math.min(count - spawned, this._acquireBatch.length);
      const got = this.acquireIndices(want, this._acquireBatch, 0);
      if (got <= 0) {
        break;
      }
      if (draws > 0) fillDraws(got * draws);
      writeBatch(this._acquireBatch, got);
      spawned += got;
    }

    if (spawned < count && !this._warnedPoolExhausted) {
      this._warnedPoolExhausted = true;
      console.warn(
        `ParticleEmitter.emit: pool exhausted; spawned ${spawned}/${count}. ` +
        'Increase particle.maxParticles.'
      );
    }

    return spawned;
  }

  /**
   * Reset all particle emitter state (extends parent reset)
   * Called when switching scenes to clear stale static state. Presets are definitions, not state: they stay.
   */
  static reset() {
    super.reset();
    this._warnedPoolExhausted = false;
    this._acquireBatch = ACQUIRE_BATCH_U16;
    clearEmitArgs();
  }
}

