// explosions.js – pixel-art explosions for Weed.js, ported from Blastforge.
//
// explode(x, y, preset) spawns a few thousand particles of two kinds:
//
//   Field puffs: fire, smoke and dust. Soft glow sprites in the explosionField
//   layer, which adds them up into a low-resolution texture. The layer's look
//   shader (shaders/explosionField.frag) turns that sum into banded, dithered,
//   lit pixel art. A puff's tint is data, not a color: red adds heat, green
//   adds smoke, blue adds dust.
//
//   Pieces: sparks, embers and debris. The engine's built-in 8 px circle in the
//   explosionPieces layer, drawn as hard pixels on the same grid. Sparks and
//   debris have height: they fly up, fall, bounce and land. Debris leaves a
//   decal where it lands, and the blast stamps a scorch mark.
//
// Some bursts start later: smoke once the fire cools, embers, follow-up blasts
// and ground flames. updateExplosions(deltaMs) runs them, so the worker that
// calls explode() must also call updateExplosions() every tick. They follow
// game time, so they pause when the game does.
//
// Ported from Blastforge (a standalone PixiJS explosion lab) with the engine's
// CPU particles.
//
// Units: presets use px, px/s and seconds. Weed particles move in px per frame
// at 60 fps, their gravity is px/frame², and lifespans are milliseconds.

import WEED from '/src/index.js';

const { ParticleEmitter, Decal, Camera, Layer, BLEND_MODES, LAYER_SCALE_MODE, PARTICLE_EASE } = WEED;

export const FIELD_LAYER = 'explosionField';
export const PIECES_LAYER = 'explosionPieces';

const GLOW_TEXTURE = 'explosionGlow'; // textures/softCircle.png, 64×64
const GLOW_RADIUS = 32;
const PIECE_TEXTURE = '_whiteCircle'; // built-in, 8×8
const PIECE_SIZE = 8;
const SCORCH_TEXTURE = '_whiteCircle_64x64'; // built-in
const SCORCH_RADIUS = 32;

const FPS = 60;
/** A 3/4 top-down view sees the ground squashed vertically. */
const SQUASH = 0.85;

// The field layer renders into an 8-bit texture, so values above 1 would clip.
// Puffs write 1/FIELD_SCALE of their strength and the look shader multiplies it
// back. A puff fainter than MIN_PUFF_ALPHA would round down to nothing.
const FIELD_SCALE = 2;
const MIN_PUFF_ALPHA = 4 / 255;

const here = (path) => `/demos/blastforgeScene/${path}`;

// ---------------------------------------------------------------------------
// Scene setup
// ---------------------------------------------------------------------------

/**
 * The two layers explode() draws into, for a scene's static config.layers.
 * @param {object} options
 * @param {number} options.pixelZoom - The camera zoom. One layer texel covers one world pixel.
 * @param {object} options.palette - Starting colors, one of the PALETTES in explosionPresets.js.
 */
export function explosionLayers({ pixelZoom, palette }) {
  const resolution = 1 / pixelZoom;
  return {
    [FIELD_LAYER]: {
      zIndex: 3.5, // above the entities layer (3)
      resolution,
      scaleMode: LAYER_SCALE_MODE.NEAREST,
      blendMode: BLEND_MODES.NORMAL,
      maxItems: 60000,
      ySorting: false,
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
        },
      },
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

/** Recolors the field layer. Blasts already on screen change too. Any thread. */
export function setExplosionPalette(palette) {
  const layer = Layer.get(FIELD_LAYER);
  for (const [name, uniform] of Object.entries(paletteUniforms(palette))) {
    layer.setUniform(name, uniform.value);
  }
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
// Timing: bursts that start later, in game time
// ---------------------------------------------------------------------------

let clockMs = 0;
let scheduled = []; // { atMs, run }
let groundFires = []; // patches still burning, see startGroundFire()

function after(seconds, run) {
  if (seconds <= 0) run();
  else scheduled.push({ atMs: clockMs + seconds * 1000, run });
}

/** Runs delayed bursts and ground flames. Call it every tick, on the worker that calls explode(). */
export function updateExplosions(deltaMs) {
  clockMs += deltaMs;
  if (scheduled.length > 0) {
    const due = scheduled.filter((task) => task.atMs <= clockMs);
    if (due.length > 0) {
      scheduled = scheduled.filter((task) => task.atMs > clockMs);
      for (const task of due) task.run();
    }
  }
  groundFires = groundFires.filter((fire) => burnGroundFire(fire, deltaMs / 1000));
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
 * @param {number} [options.wind=0] - Sideways push on fire, smoke and embers, px/s.
 */
export function explode(x, y, preset, { size = 1, amount = 1, wind = 0 } = {}) {
  const blast = { x, y, preset, size, amount, wind, palette: preset.palette, radius: Math.max(2, preset.radius * size) };

  emitFlash(blast);
  emitFireball(blast);
  releaseSmoke(blast);
  emitDustRing(blast);
  emitSparks(blast);
  releaseEmbers(blast);
  emitDebris(blast);
  stampScorch(blast);
  startGroundFire(blast);
  scheduleFollowUps(blast);

  if (preset.shake > 0) Camera.shake(preset.shake * Math.sqrt(size), 450);
}

/** A short hot disc at the center. */
function emitFlash({ x, y, preset, radius }) {
  if (preset.flash <= 0) return;
  for (let i = 0; i < 7; i++) {
    after(i * 0.012, () =>
      emitFieldPuff({
        x: x + gauss() * radius * 0.15,
        y: y + gauss() * radius * 0.12,
        seconds: random(0.07, 0.13),
        startRadius: radius * 0.35 * preset.flash,
        endRadius: radius * random(0.9, 1.25) * preset.flash,
        from: fieldColor(1, 0, 0),
        to: fieldColor(1, 0, 0),
        strength: 0.55 / FIELD_SCALE,
        ease: PARTICLE_EASE.QUAD_OUT,
      })
    );
  }
}

/**
 * The fireball: puffs grouped into lobes for a cauliflower silhouette.
 * Each puff starts as heat and ends as smoke: its tint goes from red to green
 * while its alpha fades, on one shared ease. Heat adds (1-e)² of the puff's
 * strength and smoke adds e(1-e), which peaks at a quarter.
 */
function emitFireball(blast) {
  const { x, y, preset: p, size, radius, wind } = blast;
  const puffRadius = p.fireSize * size;
  const { count, strength } = fieldStrength(Math.round(p.fire * blast.amount * size * size), puffRadius * 1.35, radius * radius, p.fireHeat * 0.48);
  if (count === 0) return;

  const smokeShare = 4 * clamp((p.smokeDensity * 0.6) / (p.fireHeat * 0.48), 0, 4);
  const lobes = makeLobes(p);
  for (let i = 0; i < count; i++) {
    const lobe = lobes[(Math.random() * lobes.length) | 0];
    const angle = lobe.angle + gauss() * lobe.width;
    const depth = Math.random() < 0.12 ? Math.random() * 0.35 : Math.pow(Math.random(), 0.42); // 0 = core, 1 = lobe tip
    const seconds = p.fireLife * random(0.55, 1.15);
    // Reach the puff's spot by three quarters of its life (see speedToCover).
    const speed = speedToCover(radius * 1.15 * lobe.length * depth, 0.75 * seconds);
    const heat = 0.8 + 0.2 * (1 - depth);
    const smoke = smokeShare * random(0.6, 1.2);
    const peak = Math.max(heat, smoke);
    const startRadius = puffRadius * random(0.5, 1.1);
    emitFieldPuff({
      x: x + gauss() * puffRadius * 0.3,
      y: y + gauss() * puffRadius * 0.3,
      vx: Math.cos(angle) * speed + perFrame(wind * 0.5),
      vy: Math.sin(angle) * speed * SQUASH - perFrame(p.rise * 0.2),
      seconds,
      startRadius,
      endRadius: startRadius * random(1.8, 2.6),
      from: fieldColor(heat / peak, 0, 0),
      to: fieldColor(0, smoke / peak, 0),
      strength: strength * peak,
      ease: PARTICLE_EASE.QUAD_IN,
    });
  }
}

function makeLobes(p) {
  const count = Math.max(1, Math.round(p.lobes));
  const start = Math.random() * Math.PI * 2;
  const lobes = [];
  for (let k = 0; k < count; k++) {
    lobes.push({
      angle: start + (k / count) * Math.PI * 2 + (gauss() * 0.35 * Math.PI) / count,
      length: 1 - p.lobeVar * 0.5 + p.lobeVar * Math.random(),
      width: (p.lobeSpread * Math.PI) / count,
    });
  }
  return lobes;
}

/** Smoke billows: groups of puffs released one by one while the fire cools. */
function releaseSmoke(blast) {
  const { x, y, preset: p, size, radius, wind } = blast;
  const puffRadius = p.smokeSize * size;
  const cloudArea = (radius * p.smokeSpread * 1.1 + puffRadius) ** 2 / 0.55;
  const { count, strength } = fieldStrength(Math.round(p.smoke * blast.amount * size * size), puffRadius * 1.25, cloudArea, p.smokeDensity * 0.7);
  if (count === 0) return;

  const billows = Math.max(3, Math.round(5 + radius / 4));
  const puffsPerBillow = Math.ceil(count / billows);
  for (let b = 0; b < billows; b++) {
    const angle = Math.random() * Math.PI * 2;
    const distance = radius * p.smokeSpread * Math.pow(Math.random(), 0.6);
    const centerX = x + Math.cos(angle) * distance;
    const centerY = y + Math.sin(angle) * distance * SQUASH;
    const billowRadius = puffRadius * random(0.8, 2);
    const riseSpeed = perFrame(p.rise * random(0.7, 1.4));

    after(p.fireLife * random(0.12, 0.6), () => {
      for (let i = 0; i < puffsPerBillow; i++) {
        const targetX = centerX + gauss() * billowRadius * 0.6;
        const targetY = centerY + gauss() * billowRadius * 0.5;
        const startX = x + (targetX - x) * 0.3;
        const startY = y + (targetY - y) * 0.3;
        const seconds = p.smokeLife * random(0.5, 1.2);
        const frames = seconds * FPS;
        const startRadius = puffRadius * random(0.4, 0.8);
        emitFieldPuff({
          x: startX,
          y: startY,
          vx: (targetX - startX) / (0.6 * frames) + perFrame(gauss() * p.turbulence * 0.3 + wind),
          vy: (targetY - startY) / (0.6 * frames) - riseSpeed * 0.3,
          gravity: (-riseSpeed * 0.7) / frames, // speeds up as it rises
          seconds,
          startRadius,
          endRadius: puffRadius * random(1.4, 2.5),
          from: fieldColor(0, 1, 0),
          to: fieldColor(0, 1, 0),
          strength: strength * random(0.7, 1.3),
          ease: PARTICLE_EASE.QUAD_OUT,
        });
      }
    });
  }
}

/** A ring of dust thrown along the ground. */
function emitDustRing(blast) {
  const { x, y, preset: p, size, radius, wind } = blast;
  const puffRadius = 3.2 * Math.sqrt(size) + radius * 0.05;
  const ringRadius = radius * 0.35 + ((p.ringSpeed * size) / 3.1) * 0.8;
  const ringArea = (2 * ringRadius * (ringRadius * 0.5 + 2 * puffRadius)) / 0.6;
  const { count, strength } = fieldStrength(Math.round(p.dust * blast.amount * size * size), puffRadius * 1.7, ringArea, 0.14);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const startDistance = radius * random(0.15, 0.45);
    const seconds = random(0.7, 1.8) * Math.sqrt(size);
    const speed = speedToCover((p.ringSpeed * size * random(0.55, 1.15)) / random(2.6, 3.6), 0.7 * seconds);
    const startRadius = puffRadius * random(0.6, 1.3);
    emitFieldPuff({
      x: x + Math.cos(angle) * startDistance,
      y: y + Math.sin(angle) * startDistance * SQUASH,
      vx: Math.cos(angle) * speed + perFrame(wind * 0.35),
      vy: Math.sin(angle) * speed * SQUASH,
      seconds,
      startRadius,
      endRadius: startRadius * random(2, 3.2),
      from: fieldColor(0, 0, 1),
      to: fieldColor(0, 0, 1),
      strength: strength * random(0.7, 1.3),
      ease: PARTICLE_EASE.QUAD_OUT,
    });
  }
}

/** Sparks: thrown up and out, they bounce once and fade on the floor. */
function emitSparks(blast) {
  const { x, y, preset: p, size, radius, palette } = blast;
  const count = Math.round(p.sparks * Math.sqrt(blast.amount) * size);
  for (let i = 0; i < count; i++) {
    const seconds = random(0.25, 0.9);
    const angle = Math.random() * Math.PI * 2;
    const launchSpeed = p.sparkSpeed * size * (0.25 + 0.95 * Math.pow(Math.random(), 0.7));
    // A Blastforge spark slows down with drag; this one keeps the speed that covers the same distance.
    const speed = draggedDistance(launchSpeed, random(1.8, 3), seconds) / seconds;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed * SQUASH;
    const up = random(20, 150) * size;
    const length = clamp(Math.sqrt(launchSpeed * launchSpeed + up * up) * 0.03, 1.2, 7);
    emitPiece({
      airborne: true,
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

/** Embers: glowing pixels drifting up with the smoke. */
function releaseEmbers(blast) {
  const { x, y, preset: p, size, radius, palette, wind } = blast;
  const count = Math.round(p.embers * Math.sqrt(blast.amount) * size);
  if (count === 0) return;
  after(p.fireLife * 0.4, () => {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = radius * Math.sqrt(Math.random()) * 0.9;
      const speed = perFrame(random(10, 60) * size);
      const seconds = random(1.2, 3.5);
      const rise = perFrame(p.rise * random(0.8, 1.6) + 6);
      emitPiece({
        airborne: false,
        x: x + Math.cos(angle) * distance,
        y: y + Math.sin(angle) * distance * SQUASH,
        vx: Math.cos(angle) * speed + perFrame(wind),
        vy: Math.sin(angle) * speed * SQUASH - rise * 0.5,
        gravity: (-rise * 0.5) / (seconds * FPS),
        seconds,
        startLength: 1.2,
        endLength: 1.2,
        thickness: 1.2,
        angle: 0,
        from: palette.fire[5],
        to: palette.fire[1],
        ease: PARTICLE_EASE.QUAD_IN,
      });
    }
  });
}

/** Debris: chunks that leave hot, cool to rock, bounce, and stay on the ground as decals. */
function emitDebris(blast) {
  const { x, y, preset: p, size, radius, palette } = blast;
  const count = Math.round(p.debris * size);
  const rock = palette.smoke[1];
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = draggedDistance(random(50, 230) * size, random(0.4, 1), 1); // about one second in the air
    const chunk = Math.max(1, Math.round(random(1, 3.2) * Math.min(1.4, Math.sqrt(size)))) + 0.2;
    emitPiece({
      airborne: true,
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

/**
 * A scorch mark on the floor decals: rings of hard dark circles. Where they
 * overlap the ground gets darker in steps, darkest at the center.
 */
const SCORCH_RINGS = [
  { stamps: 14, spread: 0.45, radius: [0.3, 0.55], alpha: 0.07 },
  { stamps: 8, spread: 0.22, radius: [0.3, 0.45], alpha: 0.12 },
  { stamps: 4, spread: 0.08, radius: [0.25, 0.35], alpha: 0.2 },
];
function stampScorch({ x, y, preset: p, size, radius }) {
  if (p.scorch <= 0) return;
  const darkness = p.scorch * Math.min(1, size * 1.2);
  for (const ring of SCORCH_RINGS) {
    for (let i = 0; i < ring.stamps; i++) {
      Decal.stamp({
        texture: SCORCH_TEXTURE,
        x: x + gauss() * radius * ring.spread,
        y: y + gauss() * radius * ring.spread * SQUASH,
        scale: (radius * random(ring.radius[0], ring.radius[1])) / SCORCH_RADIUS,
        tint: 0x15100d,
        alpha: clamp(darkness * ring.alpha, 0, 1),
      });
    }
  }
}

/** Presets with flames leave the ground burning for a while (see burnGroundFire). */
function startGroundFire(blast) {
  const p = blast.preset;
  if (p.flames <= 0 || p.flameTime <= 0) return;
  groundFires.push({ blast, age: -p.fireLife * 0.35, carry: 0 });
}

/** Advances one burning patch. Returns false once it has burned out. */
function burnGroundFire(fire, deltaSeconds) {
  const { blast } = fire;
  const p = blast.preset;
  fire.age += deltaSeconds;
  if (fire.age >= p.flameTime) return false;
  if (fire.age < 0) return true;

  const left = 1 - fire.age / p.flameTime; // 1 when it starts, 0 when it dies
  fire.carry += p.flames * blast.amount * blast.size * left * deltaSeconds;
  for (; fire.carry >= 1; fire.carry -= 1) {
    const angle = Math.random() * Math.PI * 2;
    const distance = blast.radius * 0.95 * Math.sqrt(Math.random());
    const seconds = random(0.35, 0.9);
    const rise = perFrame(p.rise * 2.2 + 18);
    const startRadius = random(1.5, 3.4) * Math.sqrt(blast.size);
    const heat = (0.55 + 0.45 * left) * random(0.7, 1.2);
    const smoke = 4 * 0.5 * p.smokeDensity * Math.random();
    const peak = Math.max(heat, smoke);
    emitFieldPuff({
      x: blast.x + Math.cos(angle) * distance,
      y: blast.y + Math.sin(angle) * distance * SQUASH,
      vx: perFrame(gauss() * 6 + blast.wind),
      vy: -rise * 0.6,
      gravity: (-rise * 0.4) / (seconds * FPS),
      seconds,
      startRadius,
      endRadius: startRadius * random(1.4, 2.1),
      from: fieldColor(heat / peak, 0, 0),
      to: fieldColor(0, smoke / peak, 0),
      strength: ((0.42 + 0.1 * p.fireHeat) / FIELD_SCALE) * peak,
      ease: PARTICLE_EASE.QUAD_IN,
    });
  }
  return true;
}

/** Chain-reaction presets set off smaller blasts around the first one. */
function scheduleFollowUps(blast) {
  const p = blast.preset;
  const count = Math.round(p.secondary);
  for (let i = 0; i < count; i++) {
    const delay = p.secondaryDelay * (i + 1) * random(0.6, 1.4);
    const angle = Math.random() * Math.PI * 2;
    const distance = blast.radius * random(0.9, 2.4);
    const followUp = { ...p, secondary: 0, shake: p.shake * 0.6 };
    const size = blast.size * p.secondaryScale * random(0.75, 1.15);
    after(delay, () =>
      explode(blast.x + Math.cos(angle) * distance, blast.y + Math.sin(angle) * distance * SQUASH, followUp, {
        size,
        amount: blast.amount,
        wind: blast.wind,
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Emitting one particle
// ---------------------------------------------------------------------------

// emit() copies the fields it reads, so one config object is reused for every particle.
const puffConfig = {
  count: 1,
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  gravity: 0,
  lifespan: 1000,
  texture: GLOW_TEXTURE,
  layer: FIELD_LAYER,
  tint: { from: 0, to: 0, ease: 0 },
  alpha: { from: 1, to: 0, ease: 0 },
  scale: { from: 1, to: 1, ease: 0 },
};

/** One field puff: a flat glow sprite that fades out over its life. Radii in px. */
function emitFieldPuff(puff) {
  const c = puffConfig;
  c.x = puff.x;
  c.y = puff.y;
  c.vx = puff.vx ?? 0;
  c.vy = puff.vy ?? 0;
  c.gravity = puff.gravity ?? 0;
  c.lifespan = lifespanMs(puff.seconds);
  c.scale.from = puff.startRadius / GLOW_RADIUS;
  c.scale.to = puff.endRadius / GLOW_RADIUS;
  c.scale.ease = puff.ease;
  c.tint.from = puff.from;
  c.tint.to = puff.to;
  c.tint.ease = puff.ease;
  c.alpha.from = Math.min(1, puff.strength);
  c.alpha.ease = puff.ease;
  ParticleEmitter.emitFlat(c);
}

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

/**
 * One piece: a hard-edged dot or streak. Sizes in px.
 * airborne pieces have height (z < 0 is up) and land; the others stay flat.
 * bounces, bounciness and bounceFriction need an engine with particle bounce;
 * without it, pieces land on the first contact.
 */
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
  if (piece.airborne) ParticleEmitter.emit(c);
  else ParticleEmitter.emitFlat(c);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * How strong each of `count` overlapping puffs must be for their sum to reach
 * `target`, given their radius and the area they share. If each puff would be
 * too faint for the 8-bit texture, fewer, stronger puffs are used instead.
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

/** Packs field amounts (0-1) into a tint: red = heat, green = smoke, blue = dust. */
function fieldColor(heat, smoke, dust) {
  return (toByte(heat) << 16) | (toByte(smoke) << 8) | toByte(dust);
}

// Weed particles keep their speed: there is no drag yet. To end where a
// Blastforge particle with drag would, a particle gets the steady speed that
// covers the same distance.

/** Steady speed, px per frame, that covers `distance` px in `seconds`. */
function speedToCover(distance, seconds) {
  return distance / (seconds * FPS);
}

/** Distance, px, that a particle launched at `speed` px/s covers in `seconds` with `drag` per second. */
function draggedDistance(speed, drag, seconds) {
  return (speed * (1 - Math.exp(-drag * seconds))) / drag;
}

const perFrame = (pxPerSecond) => pxPerSecond / FPS;
const perFrameSquared = (pxPerSecondSquared) => pxPerSecondSquared / (FPS * FPS);
/** Lifespans are stored as Uint16 milliseconds. */
const lifespanMs = (seconds) => clamp(Math.round(seconds * 1000), 1, 65535);

const random = (min, max) => min + (max - min) * Math.random();
/** Roughly normal, mean 0, spread about 1. */
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;
const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
const toByte = (v) => clamp(Math.round(v * 255), 0, 255);
const colorToRgb = (color) => [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255];
