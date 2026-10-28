// blastGround.js – Blastforge's ground: the lab's four grounds, painted per world pixel (shaders/blastGround.frag), and
// what blasts do to it: the light they cast, the shockwave that bends it, the haze over a hot fireball, and the scorch
// they leave. The field layer (explosionField.frag) takes the same lights and waves, so smoke and dust are lit and bent
// with the ground under them.
//
// Lights, waves and haze are slots, as Blastforge draws them: the 8 strongest lights (blasts first, then burning
// ground), the 6 newest waves, the 4 newest fireballs. The worker that calls explode() keeps them (addBlastEffects)
// and writes their values every tick (updateBlastEffects), so they follow game time, Speed and pause.
//
// The scorch is a picture of the whole ground in ScorchMap's shared memory, one texel per scorchCell() world px:
// blasts add Blastforge's soft gray circles to it, and the ground shader bands it into three dark steps. The panel's
// Clear asks the worker to empty it (ScorchMap.clear), so the worker stays its one writer.

import WEED from '/src/index.js';

const { Layer, SharedResource } = WEED;

export const GROUND_LAYER = 'ground';
/** The ground types, in the shader's uGround order. */
export const GROUND_TYPES = [
  ['grass', 'Grass'],
  ['dirt', 'Dirt'],
  ['stone', 'Stone tiles'],
  ['void', 'Dark void'],
];

const LIGHT_SLOTS = 8;
const WAVE_SLOTS = 6;
const HEAT_SLOTS = 4;
const SCORCH_CIRCLES = 28; // the first 6 make the core
const FIELD_LAYER = 'explosionField'; // explosions.js

const LIGHT_NAMES = Array.from({ length: LIGHT_SLOTS }, (_, i) => `uLight${i}`);
const WAVE_NAMES = Array.from({ length: WAVE_SLOTS }, (_, i) => `uWave${i}`);
const HEAT_NAMES = Array.from({ length: HEAT_SLOTS }, (_, i) => `uHeat${i}`);

/** World px per scorch texel: 2, coarser on worlds wider than 8 192 px, so the picture stays within 4 096 a side. */
export function scorchCell(worldWidth, worldHeight) {
  return Math.max(2, Math.ceil(Math.max(worldWidth, worldHeight) / 4096));
}

/** The scorch picture and the panel's clear requests. Writer: the worker that calls explode(). */
export class ScorchMap extends SharedResource {}

/** The scorch picture's size in texels; rows a multiple of 4 bytes, as a GL upload wants them. */
function scorchSize(worldWidth, worldHeight) {
  const cell = scorchCell(worldWidth, worldHeight);
  return { width: Math.ceil(Math.ceil(worldWidth / cell) / 4) * 4, height: Math.ceil(worldHeight / cell), cell };
}

/** ScorchMap's schema for a world of this size, for the scene's sharedResources. */
export function scorchSchema(worldWidth, worldHeight) {
  const { width, height } = scorchSize(worldWidth, worldHeight);
  return {
    cells: { type: Uint8Array, length: width * height },
    clear: Uint32Array, // the panel adds 1 to ask for an empty ground
  };
}

// The world the ground covers (groundLayer), in every thread that evaluates the scene's config.
let map = { width: 1, height: 1, cell: 1 };

/** The uniforms the ground and the field layer share: lights, waves and the light's color. */
export function effectUniforms() {
  const uniforms = { uLightCol: { value: [1, 0.61, 0.28], type: 'vec3<f32>' } };
  for (const name of LIGHT_NAMES) uniforms[name] = { value: [0, 0, 0, 0], type: 'vec4<f32>' };
  for (const name of WAVE_NAMES) uniforms[name] = { value: [0, 0, 0, 0], type: 'vec4<f32>' };
  return uniforms;
}

/**
 * The ground layer, for a scene's static config.layers: one world-sized rectangle the camera moves.
 * @param {object} options
 * @param {number} options.worldWidth
 * @param {number} options.worldHeight
 * @param {number} [options.zIndex=0]
 */
export function groundLayer({ worldWidth, worldHeight, zIndex = 0 }) {
  map = scorchSize(worldWidth, worldHeight);
  const uniforms = {
    uGround: { value: 0, type: 'f32' },
    uScorchCell: { value: map.cell, type: 'f32' },
    uBlastTime: { value: 0, type: 'f32' },
    ...effectUniforms(),
  };
  for (const name of HEAT_NAMES) uniforms[name] = { value: [0, 0, 0, 0], type: 'vec4<f32>' };
  return {
    zIndex,
    shader: {
      fragment: 'blastGround',
      worldRect: { width: worldWidth, height: worldHeight },
      textures: [{ name: 'scorch', format: 'r8unorm', size: { width: map.width, height: map.height } }],
      uniforms,
    },
  };
}

/** The ground's shader, for a scene's static assets.shaders. */
export const groundAssets = { shaders: { blastGround: '/demos/blastforgeScene/shaders/blastGround.frag' } };

// ---------------------------------------------------------------------------
// Slots, on the worker that calls explode()
// ---------------------------------------------------------------------------

const lights = []; // { x, y, r, i0, age, life }, strongest first
const fires = []; // { x, y, r, age, dur, light }: burning ground
const waves = []; // { x, y, r0, speed, strength, age, life }, newest last
const heats = []; // { x, y, r, age, life }, newest last
let clockS = 0;
let clearSeen = 0;
const VEC4 = [0, 0, 0, 0]; // setUniform copies it at once
const written = new Float64Array((LIGHT_SLOTS + WAVE_SLOTS + HEAT_SLOTS) * 4).fill(NaN);

/** Forget every light, wave and fireball (their slots go dark at the next update). */
export function resetBlastEffects() {
  lights.length = 0;
  fires.length = 0;
  waves.length = 0;
  heats.length = 0;
  clockS = 0;
}

/** A blast's light, shockwave, haze and burning ground, as Blastforge's detonate() starts them. */
export function addBlastEffects({ x, y, preset: p, size, radius }) {
  if (p.light > 0) {
    const light = { x, y, r: radius * 3.4 * Math.sqrt(p.light), i0: Math.min(1.2, 0.55 * p.light + 0.2), age: 0, life: p.fireLife * 1.5 + 0.25 };
    let at = 0;
    while (at < lights.length && lights[at].i0 >= light.i0) at++;
    lights.splice(at, 0, light);
  }
  if (p.wave > 0) {
    const speed = Math.max(160, p.ringSpeed * 1.6) * Math.sqrt(size);
    waves.push({ x, y, r0: radius * 0.3, speed, strength: p.wave * Math.sqrt(size), age: 0, life: 0.55 + 0.2 * size });
  }
  if (p.fire > 0) heats.push({ x, y, r: radius * 1.3, age: 0, life: p.fireLife });
  if (p.flames > 0 && p.flameTime > 0 && p.light > 0) {
    fires.push({ x, y, r: radius * 0.95 * 2.6, age: -p.fireLife * 0.35, dur: p.flameTime, light: p.light });
  }
}

/** The lights' color: the palette's light. Both layers. */
export function setBlastLightColor(color) {
  const rgb = [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255];
  Layer.get(GROUND_LAYER)?.setUniform('uLightCol', rgb);
  Layer.get(FIELD_LAYER)?.setUniform('uLightCol', rgb);
}

/** Age the slots by `deltaMs` of game time and write this tick's values; empty the scorch when the panel asked. */
export function updateBlastEffects(deltaMs) {
  const dt = deltaMs / 1000;
  clockS += dt;
  ageOut(lights, dt, 'life');
  ageOut(waves, dt, 'life');
  ageOut(heats, dt, 'life');
  ageOut(fires, dt, 'dur');
  const ground = Layer.get(GROUND_LAYER);
  const field = Layer.get(FIELD_LAYER);

  // Lights: blasts by strength, then burning ground in the slots left (Blastforge's render()).
  let slot = 0;
  for (let i = 0; i < lights.length && slot < LIGHT_SLOTS; i++, slot++) {
    const l = lights[i];
    const t = l.age / l.life;
    writeSlot(ground, field, LIGHT_NAMES[slot], slot, l.x, l.y, l.r, l.i0 * (0.4 * Math.exp(-l.age * 14) + 0.6 * (1 - smooth(t))));
  }
  for (let i = 0; i < fires.length && slot < LIGHT_SLOTS; i++) {
    const f = fires[i];
    if (f.age < 0) continue;
    const flicker = 0.32 + 0.06 * Math.sin(clockS * 23 + f.x);
    writeSlot(ground, field, LIGHT_NAMES[slot], slot, f.x, f.y, f.r, flicker * (1 - f.age / f.dur) * Math.min(1.5, f.light));
    slot++;
  }
  for (; slot < LIGHT_SLOTS; slot++) writeSlot(ground, field, LIGHT_NAMES[slot], slot, 0, 0, 0, 0);

  // Waves: the newest 6. The ring slows as it fades.
  const firstWave = Math.max(0, waves.length - WAVE_SLOTS);
  for (let s = 0; s < WAVE_SLOTS; s++) {
    const w = waves[firstWave + s];
    if (w === undefined) {
      writeSlot(ground, field, WAVE_NAMES[s], LIGHT_SLOTS + s, 0, 0, 0, 0);
      continue;
    }
    const t = w.age / w.life;
    writeSlot(ground, field, WAVE_NAMES[s], LIGHT_SLOTS + s, w.x, w.y, w.r0 + w.speed * w.age * (1 - 0.45 * t), w.strength * (1 - t) * (1 - t));
  }

  // Haze: the newest 4 fireballs, fading with their fire. The ground only.
  const firstHeat = Math.max(0, heats.length - HEAT_SLOTS);
  for (let s = 0; s < HEAT_SLOTS; s++) {
    const h = heats[firstHeat + s];
    if (h === undefined) writeSlot(ground, null, HEAT_NAMES[s], LIGHT_SLOTS + WAVE_SLOTS + s, 0, 0, 0, 0);
    else writeSlot(ground, null, HEAT_NAMES[s], LIGHT_SLOTS + WAVE_SLOTS + s, h.x, h.y, h.r, 1 - h.age / h.life);
  }
  ground?.setUniform('uBlastTime', clockS);

  const clear = ScorchMap.clear ? Atomics.load(ScorchMap.clear, 0) : 0;
  if (clear !== clearSeen) {
    clearSeen = clear;
    ScorchMap.cells.fill(0);
    ground?.updateTexture('scorch', ScorchMap.cells);
  }
}

/** Blastforge's scorchAt: 6 core and 22 outer soft gray circles, added up and clamped, into the scorch picture. */
export function scorchGround(x, y, radius, amount) {
  const cells = ScorchMap.cells;
  if (amount <= 0 || !cells) return;
  const { width, height, cell } = map;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let i = 0; i < SCORCH_CIRCLES; i++) {
    const core = i < 6;
    const cx = (x + gauss() * radius * (core ? 0.12 : 0.38)) / cell;
    const cy = (y + gauss() * radius * (core ? 0.1 : 0.3)) / cell;
    const r = (radius * (core ? random(0.35, 0.55) : random(0.18, 0.42))) / cell;
    const gray = Math.round(clamp(amount * (core ? 0.42 : 0.2), 0, 1) * 255);
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(width - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(height - 1, Math.ceil(cy + r));
    for (let ty = y0; ty <= y1; ty++) {
      const dy = (ty + 0.5 - cy) / r;
      for (let tx = x0; tx <= x1; tx++) {
        const dx = (tx + 0.5 - cx) / r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= 1) continue;
        const i = ty * width + tx;
        const falloff = (1 - d2) * (1 - d2);
        cells[i] = Math.min(255, cells[i] + Math.round(gray * falloff));
      }
    }
    if (x0 < left) left = x0;
    if (y0 < top) top = y0;
    if (x1 > right) right = x1;
    if (y1 > bottom) bottom = y1;
  }
  if (right >= left && bottom >= top) {
    Layer.get(GROUND_LAYER)?.updateTexture('scorch', cells, left, top, right - left + 1, bottom - top + 1);
  }
}

function writeSlot(ground, field, name, slot, x, y, r, value) {
  const at = slot * 4;
  if (written[at] === x && written[at + 1] === y && written[at + 2] === r && written[at + 3] === value) return;
  written[at] = x;
  written[at + 1] = y;
  written[at + 2] = r;
  written[at + 3] = value;
  VEC4[0] = x;
  VEC4[1] = y;
  VEC4[2] = r;
  VEC4[3] = value;
  ground?.setUniform(name, VEC4);
  field?.setUniform(name, VEC4);
}

/** Age every item by dt and drop the ones past `limit` (their life or duration), keeping the order. */
function ageOut(items, dt, limit) {
  let kept = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    item.age += dt;
    if (item.age < item[limit]) items[kept++] = item;
  }
  items.length = kept;
}

const smooth = (t) => {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
};
const random = (min, max) => min + (max - min) * Math.random();
/** Roughly normal, mean 0, spread about 1 (Blastforge's gauss). */
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;
const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
