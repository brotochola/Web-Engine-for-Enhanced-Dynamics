// explosions.js – pixel-art explosions for Weed.js, ported from Blastforge (a standalone PixiJS explosion lab).
//
// explode(x, y, preset) sets off three kinds of particles:
//
//   Field puffs: fire, smoke and dust. GPU particles (ParticleEmitter.emitGpu) in the explosionField layer, which
//   adds them up into a low-resolution texture. The layer's look shader (shaders/explosionField.frag) turns that sum
//   into banded, dithered, lit pixel art. A puff's tint is data, not a color: red adds heat, green adds smoke, blue
//   adds dust. The layer sorts with the entities, so a tree standing in front of a blast hides it.
//
//   Embers: GPU particles too, in explosionEmbers, drawn as hard pixels.
//
//   Pieces: sparks and debris. CPU particles (ParticleEmitter.emit) in explosionPieces, also hard pixels. They have
//   height: they fly up, fall, bounce and land. Debris leaves a decal where it lands. They stay on the CPU because
//   GPU particles have no floor.
//
//   The ground (blastGround.js): each blast lights it, bends it with a shockwave, makes it shimmer with heat and
//   scorches it. The field takes the same lights and shockwaves.
//
// A GPU emit is one call for many particles, each drawn from ranges, so a blast is a few dozen calls: one per
// fireball lobe, smoke billow, dust-ring sector... The CPU emits are one call per particle. GPU particles slow down
// with `drag`, start later with `delay`, and rise through `gravity` (with drag, a negative gravity gives a steady
// rise speed of gravity / drag), all in the vertex shader: nothing is scheduled on the CPU but follow-up blasts,
// which updateExplosions(deltaMs) sets off, so the worker that calls explode() must also call updateExplosions()
// every tick. Everything follows game time and pauses when the game does.
//
// Units: presets use px, px/s and seconds. Particles move in px per frame at 60 fps, gravity is px/frame², drag is
// 1/s, delays and lifespans are milliseconds.
//
// What the engine does not have yet, worked around where it matters:
//   - CPU particles have no drag: a spark or a chunk of debris gets the steady speed that covers the distance a
//     dragged one would (draggedDistance).
//   - GPU particles have no sideways acceleration: wind is a push at launch that their drag slows, so smoke and
//     embers use a low drag and get the push that covers the drift.
//   - Shader layers render into 8-bit textures, so puffs are written at half strength and never below 4/255.
//   - The palette is 16 separate vec3 uniforms: layer uniforms have no arrays.
//   - A look layer among the entities is drawn in regions, one per cloud of overlapping groups, sorted at the
//     cloud's furthest-back group: a chain reaction's blasts all sort at the first one's ground y.

import WEED from '/src/index.js';
import { addBlastEffects, effectUniforms, scorchGround, setBlastLightColor, updateBlastEffects } from './blastGround.js';

const { ParticleEmitter, Camera, Layer, BLEND_MODES, LAYER_KIND, LAYER_SCALE_MODE, PARTICLE_EASE } = WEED;

export const FIELD_LAYER = 'explosionField';
export const EMBERS_LAYER = 'explosionEmbers';
export const PIECES_LAYER = 'explosionPieces';

const GLOW_TEXTURE = 'explosionGlow'; // textures/softCircle.png, 64×64
const GLOW_RADIUS = 32;
const PIECE_TEXTURE = '_whiteCircle'; // built-in, 8×8
const PIECE_SIZE = 8;

const FPS = 60;
/** A 3/4 top-down view sees the ground squashed vertically. */
const SQUASH = 0.85;
const TAU = Math.PI * 2;

// The field layer renders into an 8-bit texture, so values above 1 would clip. Puffs write 1/FIELD_SCALE of their
// strength and the look shader multiplies it back. A puff fainter than MIN_PUFF_ALPHA would round down to nothing.
const FIELD_SCALE = 2;
const MIN_PUFF_ALPHA = 4 / 255;

/** Smoke expands, rises and drifts on one drag, low enough that the wind keeps pushing for most of its life. */
const SMOKE_DRAG = 0.9;
const DUST_RING_SECTORS = 12;
const EMBER_SECTORS = 6;
const GROUND_FIRE_SLICES = 6;
/** The ground fire's patch: a centre and four sides, roughly a disc. */
const GROUND_FIRE_CELLS = [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]];

const here = (path) => `/demos/blastforgeScene/${path}`;

// ---------------------------------------------------------------------------
// Scene setup
// ---------------------------------------------------------------------------

/**
 * The layers explode() draws into, for a scene's static config.layers.
 * @param {object} options
 * @param {number} options.pixelZoom - The camera zoom. One layer texel covers one world pixel.
 * @param {object} options.palette - Starting colors, one of the PALETTES in explosionPresets.js.
 */
export function explosionLayers({ pixelZoom, palette }) {
  const resolution = 1 / pixelZoom;
  // Explosions are set off from a logic worker: its rings get nearly all the records.
  const gpuRings = { main: 0.02, logic: 1, particle: 0.02 };
  return {
    [FIELD_LAYER]: {
      kind: LAYER_KIND.GPU_PARTICLES,
      zIndex: 3.5, // where it draws while the entities do not y-sort
      maxParticles: 140000,
      gpuRings,
      sortWithEntities: true, // each blast among the entities, at its ground y
      resolution,
      scaleMode: LAYER_SCALE_MODE.NEAREST,
      blendMode: BLEND_MODES.NORMAL,
      shader: {
        fragment: 'explosionField',
        containerBlend: BLEND_MODES.ADD, // overlapping puffs add up into the field
        uniforms: {
          uLayerResolution: { value: resolution, type: 'f32' },
          uFieldScale: { value: FIELD_SCALE, type: 'f32' },
          uDither: { value: 0.6, type: 'f32', min: 0, max: 1, step: 0.05, label: 'Dither' },
          uOutline: { value: 1, type: 'f32', widget: 'check', label: 'Dark smoke outline' },
          uLightDirection: { value: [-0.55, -0.83], type: 'vec2<f32>', min: -1, max: 1, step: 0.05, label: 'Light direction' },
          uShowField: { value: 0, type: 'f32', widget: 'check', label: 'Show the raw field' },
          ...paletteUniforms(palette),
          ...effectUniforms(), // the ground's lights and shockwaves (blastGround.js)
        },
      },
    },
    [EMBERS_LAYER]: {
      kind: LAYER_KIND.GPU_PARTICLES,
      zIndex: 3.55,
      maxParticles: 16384,
      gpuRings,
      resolution,
      scaleMode: LAYER_SCALE_MODE.NEAREST,
      blendMode: BLEND_MODES.NORMAL,
      shader: { fragment: 'crispPixels', containerBlend: BLEND_MODES.NORMAL },
    },
    [PIECES_LAYER]: {
      zIndex: 3.6,
      resolution,
      scaleMode: LAYER_SCALE_MODE.NEAREST,
      blendMode: BLEND_MODES.NORMAL,
      maxItems: 20000,
      ySorting: false,
      shader: { fragment: 'crispPixels', containerBlend: BLEND_MODES.NORMAL },
    },
  };
}

/** Textures and shaders the layers need, for a scene's static assets. */
export const explosionAssets = {
  textures: {
    [GLOW_TEXTURE]: here('textures/softCircle.png'),
  },
  shaders: {
    explosionField: here('shaders/explosionField.frag'),
    crispPixels: here('shaders/crispPixels.frag'),
  },
};

/**
 * The explosion layers at a new camera zoom: one layer texel per world pixel again. Blasts already on screen
 * change too. Any thread.
 */
export function setExplosionPixelZoom(pixelZoom) {
  const resolution = 1 / pixelZoom;
  for (const name of [FIELD_LAYER, EMBERS_LAYER, PIECES_LAYER]) Layer.get(name).resolution = resolution;
  Layer.get(FIELD_LAYER).setUniform('uLayerResolution', resolution);
}

/** Recolors the field layer. Blasts already on screen change too. Any thread. */
export function setExplosionPalette(palette) {
  const layer = Layer.get(FIELD_LAYER);
  for (const [name, uniform] of Object.entries(paletteUniforms(palette))) {
    layer.setUniform(name, uniform.value);
  }
  setBlastLightColor(palette.light);
}

function paletteUniforms(palette) {
  const uniforms = {};
  for (const part of ['fire', 'smoke', 'dust']) {
    const prefix = 'u' + part[0].toUpperCase() + part.slice(1); // uFire0, uSmoke0, uDust0…
    palette[part].forEach((color, i) => {
      uniforms[prefix + i] = { value: colorToRgb(color), type: 'vec3<f32>' };
    });
  }
  return uniforms;
}

// ---------------------------------------------------------------------------
// Follow-up blasts, in game time
// ---------------------------------------------------------------------------

let clockMs = 0;
let scheduled = []; // { atMs, run }

/** Sets off follow-up blasts that are due. Call it every tick, on the worker that calls explode(). */
export function updateExplosions(deltaMs) {
  clockMs += deltaMs;
  updateBlastEffects(deltaMs);
  if (scheduled.length === 0) return;
  const due = scheduled.filter((task) => task.atMs <= clockMs);
  if (due.length === 0) return;
  scheduled = scheduled.filter((task) => task.atMs > clockMs);
  for (const task of due) task.run();
}

// ---------------------------------------------------------------------------
// explode()
// ---------------------------------------------------------------------------

/**
 * Sets off an explosion at world (x, y).
 * @param {number} x
 * @param {number} y
 * @param {object} preset - One of the PRESETS in explosionPresets.js.
 * @param {object} [options]
 * @param {number} [options.size=1] - Scales the whole blast.
 * @param {number} [options.amount=1] - Scales the number of puffs.
 * @param {number} [options.wind=0] - Sideways push on fire, smoke, dust and embers, px/s.
 * @param {number} [options.sortY=y] - The ground y the blast's fire and smoke sort at among the entities.
 */
export function explode(x, y, preset, { size = 1, amount = 1, wind = 0, sortY = y } = {}) {
  const blast = { x, y, sortY, preset, size, amount, wind, palette: preset.palette, radius: Math.max(2, preset.radius * size) };

  emitFlash(blast);
  emitFireball(blast);
  emitSmoke(blast);
  emitDustRing(blast);
  emitEmbers(blast);
  emitGroundFire(blast);
  emitSparks(blast);
  emitDebris(blast);
  stampScorch(blast);
  scheduleFollowUps(blast);
  addBlastEffects(blast);

  if (preset.shake > 0) Camera.shake(preset.shake * Math.sqrt(size), 450);
}

/** A short hot disc at the center: seven puffs, 12 ms apart. */
function emitFlash({ x, y, sortY, preset, radius }) {
  if (preset.flash <= 0) return;
  emitField({
    count: 7,
    x: around(x, radius * 0.15),
    y: around(y, radius * 0.12),
    delay: { min: 0, max: 72 },
    lifespan: ms(0.07, 0.13),
    scale: {
      from: (radius * 0.35 * preset.flash) / GLOW_RADIUS,
      to: { min: (radius * 0.9 * preset.flash) / GLOW_RADIUS, max: (radius * 1.25 * preset.flash) / GLOW_RADIUS },
      ease: PARTICLE_EASE.QUAD_OUT,
    },
    alpha: { from: 0.55 / FIELD_SCALE, to: 0, ease: PARTICLE_EASE.QUAD_OUT },
    tint: fieldColor(1, 0, 0),
    sortY,
  });
}

/**
 * The fireball: puffs grouped into lobes for a cauliflower silhouette, one emit per lobe for its far puffs and one
 * for its core. Each puff is thrown out at distance × drag and coasts to a stop there, as in Blastforge. It starts
 * as heat and ends as smoke: its tint goes from red to green while its alpha fades, on one ease, so heat adds (1-e)²
 * of the puff's strength and smoke adds e(1-e), which peaks at a quarter.
 */
function emitFireball(blast) {
  const { x, y, preset: p, size, radius, wind } = blast;
  const puffRadius = p.fireSize * size;
  const { count, strength } = fieldStrength(Math.round(p.fire * blast.amount * size * size), puffRadius * 1.35, radius * radius, p.fireHeat * 0.48);
  if (count === 0) return;

  const drag = p.drag ?? 5; // 1/s
  const smokeShare = 4 * clamp((p.smokeDensity * 0.6) / (p.fireHeat * 0.48), 0, 4);
  const lifespan = ms(p.fireLife * 0.55, p.fireLife * 1.15);
  const lobes = makeLobes(p);
  const perLobe = splitCount(count, lobes.length);
  // depth: 0 = core, 1 = lobe tip. Far puffs take 88 %, the core 12 %.
  const parts = [{ share: 0.88, depth: [0.4, 1] }, { share: 0.12, depth: [0, 0.35] }];
  lobes.forEach((lobe, k) => {
    for (const part of parts) {
      const n = Math.round(perLobe[k] * part.share);
      if (n === 0) continue;
      const depth = (part.depth[0] + part.depth[1]) / 2;
      const heat = 0.8 + 0.2 * (1 - depth);
      const peak = Math.max(heat, smokeShare * 0.9);
      const reach = radius * 1.15 * lobe.length;
      const speed = { min: perFrame(reach * part.depth[0] * drag), max: perFrame(reach * part.depth[1] * drag) };
      // Wind leans the lobe: the push is a share of the lobe's own speed.
      const lean = (wind * 0.5) / Math.max(1, reach * depth * drag);
      emitField({
        count: n,
        x: around(x, puffRadius * 0.3),
        y: around(y, puffRadius * 0.3),
        dirX: Math.cos(lobe.angle) + lean,
        dirY: Math.sin(lobe.angle) * SQUASH,
        spread: lobe.width,
        speed,
        drag: { min: drag * 0.8, max: drag * 1.2 },
        gravity: riseGravity(p.rise * 0.45, drag),
        delay: { min: 0, max: 60 },
        lifespan,
        scale: {
          from: { min: (puffRadius * 0.5) / GLOW_RADIUS, max: (puffRadius * 1.1) / GLOW_RADIUS },
          to: { min: (puffRadius * 1.0) / GLOW_RADIUS, max: (puffRadius * 2.6) / GLOW_RADIUS },
          ease: PARTICLE_EASE.QUAD_IN,
        },
        tint: {
          from: fieldColor(heat / peak, 0, 0),
          to: { min: fieldColor(0, (smokeShare * 0.6) / peak, 0), max: fieldColor(0, (smokeShare * 1.2) / peak, 0) },
          ease: PARTICLE_EASE.QUAD_IN,
        },
        alpha: { from: { min: strength * peak * 0.85, max: strength * peak * 1.15 }, to: 0, ease: PARTICLE_EASE.QUAD_IN },
        sortY: blast.sortY,
      });
    }
  });
}

function makeLobes(p) {
  const count = Math.max(1, Math.round(p.lobes));
  const start = Math.random() * TAU;
  const lobes = [];
  for (let k = 0; k < count; k++) {
    lobes.push({
      angle: start + (k / count) * TAU + (gauss() * 0.35 * Math.PI) / count,
      length: 1 - p.lobeVar * 0.5 + p.lobeVar * Math.random(),
      width: (p.lobeSpread * Math.PI) / count,
    });
  }
  return lobes;
}

/**
 * Smoke billows: one emit per billow, released while the fire cools (delay). Its puffs start 30 % of the way out
 * and drift to the billow, rising faster as they go, with the wind.
 */
function emitSmoke(blast) {
  const { x, y, preset: p, size, radius, wind } = blast;
  const puffRadius = p.smokeSize * size;
  const cloudArea = (radius * p.smokeSpread * 1.1 + puffRadius) ** 2 / 0.55;
  const { count, strength } = fieldStrength(Math.round(p.smoke * blast.amount * size * size), puffRadius * 1.25, cloudArea, p.smokeDensity * 0.7);
  if (count === 0) return;

  const billows = Math.max(3, Math.round(5 + radius / 4));
  const perBillow = splitCount(count, billows);
  const lifeS = p.smokeLife * 0.85; // the middle of 0.5-1.2 × smokeLife
  // With drag d a puff covers v0 (1 - e^(-d T)) / d by the end of its life T: speeds that cover a distance.
  const cover = SMOKE_DRAG / (1 - Math.exp(-SMOKE_DRAG * lifeS));
  for (let b = 0; b < billows; b++) {
    if (perBillow[b] === 0) continue;
    const angle = Math.random() * TAU;
    const distance = radius * p.smokeSpread * Math.pow(Math.random(), 0.6);
    const centerX = x + Math.cos(angle) * distance;
    const centerY = y + Math.sin(angle) * distance * SQUASH;
    const billowRadius = puffRadius * random(0.8, 2);
    const travelX = (centerX - x) * 0.7;
    const travelY = (centerY - y) * 0.7;
    const spreadX = billowRadius * 0.6 * 0.7 + p.turbulence * 0.6;
    const spreadY = billowRadius * 0.5 * 0.7 + p.turbulence * 0.4;
    const startMs = p.fireLife * random(0.12, 0.6) * 1000;
    emitField({
      count: perBillow[b],
      x: around(x + (centerX - x) * 0.3, billowRadius * 0.18),
      y: around(y + (centerY - y) * 0.3, billowRadius * 0.15),
      vx: around(perFrame((travelX + wind * lifeS * 0.8) * cover), perFrame(spreadX * cover)),
      vy: around(perFrame(travelY * cover), perFrame(spreadY * cover)),
      drag: SMOKE_DRAG,
      gravity: riseGravity(p.rise * random(0.7, 1.4), SMOKE_DRAG),
      delay: { min: startMs, max: startMs + 150 },
      lifespan: ms(p.smokeLife * 0.5, p.smokeLife * 1.2),
      scale: {
        from: { min: (puffRadius * 0.4) / GLOW_RADIUS, max: (puffRadius * 0.8) / GLOW_RADIUS },
        to: { min: (puffRadius * 1.4) / GLOW_RADIUS, max: (puffRadius * 2.5) / GLOW_RADIUS },
        ease: PARTICLE_EASE.QUAD_OUT,
      },
      tint: fieldColor(0, 1, 0),
      alpha: { from: { min: strength * 0.7, max: strength * 1.3 }, to: 0, ease: PARTICLE_EASE.QUAD_OUT },
      sortY: blast.sortY,
    });
  }
}

/** A ring of dust thrown along the ground: one emit per sector. */
function emitDustRing(blast) {
  const { x, y, preset: p, size, radius, wind } = blast;
  const puffRadius = 3.2 * Math.sqrt(size) + radius * 0.05;
  const ringRadius = radius * 0.35 + ((p.ringSpeed * size) / 3.1) * 0.8;
  const ringArea = (2 * ringRadius * (ringRadius * 0.5 + 2 * puffRadius)) / 0.6;
  const { count, strength } = fieldStrength(Math.round(p.dust * blast.amount * size * size), puffRadius * 1.7, ringArea, 0.14);
  if (count === 0) return;

  const perSector = splitCount(count, DUST_RING_SECTORS);
  const speed = p.ringSpeed * size;
  const start = Math.random() * TAU;
  for (let k = 0; k < DUST_RING_SECTORS; k++) {
    if (perSector[k] === 0) continue;
    const angle = start + ((k + 0.5) / DUST_RING_SECTORS) * TAU;
    emitField({
      count: perSector[k],
      x: around(x + Math.cos(angle) * radius * 0.3, radius * 0.15),
      y: around(y + Math.sin(angle) * radius * 0.3 * SQUASH, radius * 0.15 * SQUASH),
      dirX: Math.cos(angle) + (wind * 0.35) / Math.max(1, speed),
      dirY: Math.sin(angle) * SQUASH,
      spread: Math.PI / DUST_RING_SECTORS,
      speed: { min: perFrame(speed * 0.55), max: perFrame(speed * 1.15) },
      drag: { min: 2.6, max: 3.6 },
      gravity: riseGravity(p.rise * 0.15, 3.1),
      delay: { min: 0, max: 50 },
      lifespan: ms(0.7 * Math.sqrt(size), 1.8 * Math.sqrt(size)),
      scale: {
        from: { min: (puffRadius * 0.6) / GLOW_RADIUS, max: (puffRadius * 1.3) / GLOW_RADIUS },
        to: { min: (puffRadius * 1.6) / GLOW_RADIUS, max: (puffRadius * 3.6) / GLOW_RADIUS },
        ease: PARTICLE_EASE.QUAD_OUT,
      },
      tint: fieldColor(0, 0, 1),
      alpha: { from: { min: strength * 0.7, max: strength * 1.3 }, to: 0, ease: PARTICLE_EASE.QUAD_OUT },
      sortY: blast.sortY,
    });
  }
}

/** Embers: glowing pixels drifting up with the smoke, released while the fire burns. One emit per sector. */
function emitEmbers(blast) {
  const { x, y, preset: p, size, radius, palette, wind } = blast;
  const count = Math.round(p.embers * Math.sqrt(blast.amount) * size);
  if (count === 0) return;
  const perSector = splitCount(count, EMBER_SECTORS);
  const start = Math.random() * TAU;
  for (let k = 0; k < EMBER_SECTORS; k++) {
    if (perSector[k] === 0) continue;
    const angle = start + ((k + 0.5) / EMBER_SECTORS) * TAU;
    const out = 35 * size; // px/s
    const rise = p.rise * 1.2 + 6;
    emitEmber({
      count: perSector[k],
      x: around(x + Math.cos(angle) * radius * 0.55, radius * 0.35),
      y: around(y + Math.sin(angle) * radius * 0.55 * SQUASH, radius * 0.35 * SQUASH),
      vx: around(perFrame(Math.cos(angle) * out + wind), perFrame(25 * size + 14)),
      vy: around(perFrame(Math.sin(angle) * out * SQUASH), perFrame(25 * size * SQUASH + 10)),
      gravity: riseGravity(rise, 1),
      delay: { min: p.fireLife * 100, max: p.fireLife * 900 },
      lifespan: ms(1.2, 3.5),
      from: palette.fire[5],
      to: palette.fire[1],
    });
  }
}

/**
 * Presets with flames leave the ground burning for flameTime seconds, fewer and cooler flames as it dies down.
 * All of it is emitted at once: each slice of that time is a few emits whose delays fall in the slice.
 */
function emitGroundFire(blast) {
  const { x, y, preset: p, size, radius, wind, palette } = blast;
  if (p.flames <= 0 || p.flameTime <= 0) return;
  const startS = p.fireLife * 0.35;
  const sliceS = p.flameTime / GROUND_FIRE_SLICES;
  const rate = p.flames * blast.amount * size; // flames per second at the start
  const rise = p.rise * 2.2 + 18;
  const cell = radius * 0.3;
  const gFl = 0.42 + 0.1 * p.fireHeat;
  for (let j = 0; j < GROUND_FIRE_SLICES; j++) {
    const left = 1 - (j + 0.5) / GROUND_FIRE_SLICES; // 1 when it starts, 0 when it dies
    const n = Math.round(rate * sliceS * left);
    if (n === 0) continue;
    const delay = { min: (startS + j * sliceS) * 1000, max: (startS + (j + 1) * sliceS) * 1000 };
    const heat = 0.55 + 0.45 * left;
    const smoke = p.smokeDensity; // the middle of 0 to 2 × smokeDensity
    const peak = Math.max(heat, smoke);
    const perCell = splitCount(n, GROUND_FIRE_CELLS.length);
    GROUND_FIRE_CELLS.forEach(([cx, cy], c) => {
      if (perCell[c] === 0) return;
      emitField({
        count: perCell[c],
        x: around(x + cx * radius, cell),
        y: around(y + cy * radius * SQUASH, cell * SQUASH),
        vx: around(perFrame(wind), perFrame(6)),
        vy: -perFrame(rise), // already at its rise speed
        drag: 2,
        gravity: riseGravity(rise, 2),
        delay,
        lifespan: ms(0.35, 0.9),
        scale: {
          from: { min: (1.5 * Math.sqrt(size)) / GLOW_RADIUS, max: (3.4 * Math.sqrt(size)) / GLOW_RADIUS },
          to: { min: (2.5 * Math.sqrt(size)) / GLOW_RADIUS, max: (6 * Math.sqrt(size)) / GLOW_RADIUS },
          ease: PARTICLE_EASE.QUAD_IN,
        },
        tint: {
          from: { min: fieldColor((heat * 0.7) / peak, 0, 0), max: fieldColor(Math.min(1, (heat * 1.2) / peak), 0, 0) },
          to: { min: fieldColor(0, 0, 0), max: fieldColor(0, (2 * smoke) / peak, 0) },
          ease: PARTICLE_EASE.QUAD_IN,
        },
        alpha: { from: (gFl / FIELD_SCALE) * peak, to: 0, ease: PARTICLE_EASE.QUAD_IN },
        sortY: blast.sortY,
      });
    });
    // Now and then a flame leaves smoke, or an ember.
    const smokeN = Math.round(n * 0.08);
    if (smokeN > 0) {
      const ss = 6 * Math.sqrt(size);
      emitField({
        count: smokeN,
        x: around(x, radius * 0.6),
        y: around(y - 4, radius * 0.6 * SQUASH),
        vx: around(perFrame(wind), perFrame(8)),
        vy: 0,
        drag: 1.5,
        gravity: riseGravity(p.rise * 1.3 + 8, 1.5),
        delay,
        lifespan: ms(1.2, 2.6),
        scale: { from: (ss * 0.5) / GLOW_RADIUS, to: { min: (ss * 1.2) / GLOW_RADIUS, max: (ss * 2.4) / GLOW_RADIUS }, ease: PARTICLE_EASE.QUAD_OUT },
        tint: fieldColor(0, 1, 0),
        alpha: { from: (0.42 * p.smokeDensity) / FIELD_SCALE, to: 0, ease: PARTICLE_EASE.QUAD_OUT },
        sortY: blast.sortY,
      });
    }
    const emberN = Math.round(n * 0.02);
    if (emberN > 0) {
      emitEmber({
        count: emberN,
        x: around(x, radius * 0.6),
        y: around(y, radius * 0.6 * SQUASH),
        vx: around(perFrame(wind), perFrame(15)),
        vy: around(0, perFrame(10)),
        gravity: riseGravity(p.rise + 14, 1),
        delay,
        lifespan: ms(1, 2.4),
        from: palette.fire[5],
        to: palette.fire[1],
      });
    }
  }
}

/** Sparks: thrown up and out, they bounce once and fade on the floor. */
function emitSparks(blast) {
  const { x, y, preset: p, size, radius, palette } = blast;
  const count = Math.round(p.sparks * Math.sqrt(blast.amount) * size);
  for (let i = 0; i < count; i++) {
    const seconds = random(0.25, 0.9);
    const angle = Math.random() * TAU;
    const launchSpeed = p.sparkSpeed * size * (0.25 + 0.95 * Math.pow(Math.random(), 0.7));
    // A Blastforge spark slows down with drag; CPU particles have none, so this one keeps the speed that covers
    // the same distance.
    const speed = draggedDistance(launchSpeed, random(1.8, 3), seconds) / seconds;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed * SQUASH;
    const up = random(20, 150) * size;
    const length = clamp(Math.sqrt(launchSpeed * launchSpeed + up * up) * 0.03, 1.2, 7);
    emitPiece({
      x: x + gauss() * radius * 0.2,
      y: y + gauss() * radius * 0.15,
      z: -Math.max(1, random(0, radius * 0.3)),
      vx: perFrame(vx),
      vy: perFrame(vy),
      vz: -perFrame(up),
      gravity: perFrameSquared(260 * Math.sqrt(size)),
      seconds,
      startLength: length,
      endLength: Math.max(1.2, length * 0.4),
      thickness: Math.random() < 0.3 ? 2 : 1.4,
      angle: (Math.atan2(vy - up, vx) * 180) / Math.PI,
      from: palette.fire[6 - ((Math.random() * 2) | 0)],
      to: palette.fire[1],
      ease: PARTICLE_EASE.LERP,
      bounces: 1,
      bounciness: 0.3,
      bounceFriction: 0.6,
      fadeOnTheFloor: 150,
    });
  }
}

/** Debris: chunks that leave hot, cool to rock, bounce, and stay on the ground as decals. */
function emitDebris(blast) {
  const { x, y, preset: p, size, radius, palette } = blast;
  const count = Math.round(p.debris * size);
  const rock = palette.smoke[1];
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * TAU;
    const speed = draggedDistance(random(50, 230) * size, random(0.4, 1), 1); // about one second in the air
    const chunk = Math.max(1, Math.round(random(1, 3.2) * Math.min(1.4, Math.sqrt(size)))) + 0.2;
    emitPiece({
      x: x + gauss() * radius * 0.2,
      y: y + gauss() * radius * 0.15,
      z: -Math.max(1, random(0, radius * 0.2)),
      vx: perFrame(Math.cos(angle) * speed),
      vy: perFrame(Math.sin(angle) * speed * SQUASH),
      vz: -perFrame(random(90, 280) * Math.sqrt(size)),
      gravity: perFrameSquared(520 * Math.sqrt(size)),
      seconds: random(1.8, 2.6), // lands in about 1.5 s; the last landing stamps and removes it
      startLength: chunk,
      endLength: chunk,
      thickness: chunk,
      angle: 0,
      from: p.fire > 0 ? palette.fire[5] : rock,
      to: rock,
      ease: PARTICLE_EASE.CUBIC_OUT, // mostly rock by the time it lands
      bounces: { min: 1, max: 2 },
      bounciness: 0.35,
      bounceFriction: 0.55,
      stayOnTheFloor: true, // stamps a decal on the last landing
    });
  }
}

/** The blast's scorch, on the ground's scorch picture (blastGround.js), which the ground bands into dark steps. */
function stampScorch({ x, y, preset: p, size, radius }) {
  scorchGround(x, y, radius, p.scorch * Math.min(1, size * 1.2));
}

/**
 * Chain-reaction presets set off smaller blasts around the first one. Their smoke merges with the first one's into
 * one cloud, and a merged cloud sorts as one item, so they all sort at the first blast's ground y.
 */
function scheduleFollowUps(blast) {
  const p = blast.preset;
  const count = Math.round(p.secondary);
  for (let i = 0; i < count; i++) {
    const delay = p.secondaryDelay * (i + 1) * random(0.6, 1.4);
    const angle = Math.random() * TAU;
    const distance = blast.radius * random(0.9, 2.4);
    const followUp = { ...p, secondary: 0, shake: p.shake * 0.6 };
    const size = blast.size * p.secondaryScale * random(0.75, 1.15);
    scheduled.push({
      atMs: clockMs + delay * 1000,
      run: () =>
        explode(blast.x + Math.cos(angle) * distance, blast.y + Math.sin(angle) * distance * SQUASH, followUp, {
          size,
          amount: blast.amount,
          wind: blast.wind,
          sortY: blast.sortY,
        }),
    });
  }
}

// ---------------------------------------------------------------------------
// Emitting
// ---------------------------------------------------------------------------

/** One emit of field puffs: flat glow sprites that fade out over their life. */
function emitField(cfg) {
  cfg.layer = FIELD_LAYER;
  cfg.texture = GLOW_TEXTURE;
  ParticleEmitter.emitGpu(cfg);
}

/** One emit of embers: 1.2 px dots, hot to cool. */
function emitEmber({ from, to, ...cfg }) {
  cfg.layer = EMBERS_LAYER;
  cfg.texture = PIECE_TEXTURE;
  cfg.drag = 1;
  cfg.scale = 1.2 / PIECE_SIZE;
  cfg.tint = { from, to, ease: PARTICLE_EASE.QUAD_IN };
  ParticleEmitter.emitGpu(cfg);
}

// emit() copies the fields it reads, so one config object is reused for every piece.
const pieceConfig = {
  count: 1,
  x: 0,
  y: 0,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  gravity: 0,
  lifespan: 1000,
  texture: PIECE_TEXTURE,
  layer: PIECES_LAYER,
  alpha: 1,
  rotation: 0,
  tint: { from: 0, to: 0, ease: 0 },
  scaleX: { from: 1, to: 1, ease: 0 },
  scaleY: 1,
  bounces: undefined,
  bounciness: undefined,
  bounceFriction: undefined,
  fadeOnTheFloor: 0,
  stayOnTheFloor: false,
};

/** One piece: a hard-edged dot or streak with height (z < 0 is up) that lands. Sizes in px. */
function emitPiece(piece) {
  const c = pieceConfig;
  c.x = piece.x;
  c.y = piece.y;
  c.z = piece.z ?? 0;
  c.vx = piece.vx;
  c.vy = piece.vy;
  c.vz = piece.vz ?? 0;
  c.gravity = piece.gravity;
  c.lifespan = lifespanMs(piece.seconds);
  c.scaleX.from = piece.startLength / PIECE_SIZE;
  c.scaleX.to = piece.endLength / PIECE_SIZE;
  c.scaleX.ease = piece.ease;
  c.scaleY = piece.thickness / PIECE_SIZE;
  c.rotation = piece.angle;
  c.tint.from = piece.from;
  c.tint.to = piece.to;
  c.tint.ease = piece.ease;
  c.bounces = piece.bounces;
  c.bounciness = piece.bounciness;
  c.bounceFriction = piece.bounceFriction;
  c.fadeOnTheFloor = piece.fadeOnTheFloor ?? 0;
  c.stayOnTheFloor = piece.stayOnTheFloor ?? false;
  ParticleEmitter.emit(c);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * How strong each of `count` overlapping puffs must be for their sum to reach `target`, given their radius and the
 * area they share. If each puff would be too faint for the 8-bit texture, fewer, stronger puffs are used instead.
 */
function fieldStrength(count, puffRadius, area, target) {
  if (count <= 0) return { count: 0, strength: 0 };
  const coverage = (count * puffRadius * puffRadius) / Math.max(1, area);
  let strength = target / (coverage * 0.33) / FIELD_SCALE;
  if (strength < MIN_PUFF_ALPHA) {
    count = Math.max(1, Math.round((count * strength) / MIN_PUFF_ALPHA));
    strength = MIN_PUFF_ALPHA;
  }
  return { count, strength: Math.min(strength, 1) };
}

/**
 * The gravity that, with `drag` (1/s), settles to rising at `pxPerSecond`: a particle with drag d under gravity g
 * reaches the speed g / d. px/frame².
 */
function riseGravity(pxPerSecond, drag) {
  return -perFrame(pxPerSecond) * (drag / FPS);
}

/** `count` split into `parts` whole numbers that add up to it, at random. */
function splitCount(count, parts) {
  const out = new Array(parts).fill(Math.floor(count / parts));
  for (let r = count - out[0] * parts; r > 0; r--) out[(Math.random() * parts) | 0]++;
  return out;
}

/** Packs field amounts (0-1) into a tint: red = heat, green = smoke, blue = dust. */
function fieldColor(heat, smoke, dust) {
  return (toByte(heat) << 16) | (toByte(smoke) << 8) | toByte(dust);
}

/** Distance, px, that a particle launched at `speed` px/s covers in `seconds` with `drag` per second. */
function draggedDistance(speed, drag, seconds) {
  return (speed * (1 - Math.exp(-drag * seconds))) / drag;
}

/** A range of `half` either side of `center`. */
const around = (center, half) => ({ min: center - half, max: center + half });
/** A lifespan range in ms, from seconds. Lifespans are stored as Uint16 milliseconds on the CPU, floats on the GPU. */
const ms = (minSeconds, maxSeconds) => ({ min: minSeconds * 1000, max: maxSeconds * 1000 });
const perFrame = (pxPerSecond) => pxPerSecond / FPS;
const perFrameSquared = (pxPerSecondSquared) => pxPerSecondSquared / (FPS * FPS);
const lifespanMs = (seconds) => clamp(Math.round(seconds * 1000), 1, 65535);

const random = (min, max) => min + (max - min) * Math.random();
/** Roughly normal, mean 0, spread about 1. */
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;
const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
const toByte = (v) => clamp(Math.round(v * 255), 0, 255);
const colorToRgb = (color) => [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255];
