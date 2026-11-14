import test from 'node:test';
import assert from 'node:assert/strict';

import { Decal } from '../../src/core/decal.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { resolveParticleColorOp, resolveParticleOp } from '../../src/util/particleTween.js';
import { randomRange, rng, seededRandom } from '../../src/util/utils.js';

// E-286: Decal.stamp is a small front that reads the options once and hands its bodies only their values (the numbers
// of a plain stamp through a Float64Array), so a caller's literal can be removed once the front is inlined. Every
// stamp it makes (the values handed to the particle worker's apply, or written to the ring) and its return value must
// be the stamp before E-286's, kept here as the reference, with the shared rng in the same state: plain numbers,
// defaults, the scale rules, counts, ranges and from/to values, sprite-sheet frames.

const opA = { from: 0, to: 0, tween: false, ease: 0 };
const opB = { from: 0, to: 0, tween: false, ease: 0 };

function referenceNumber(value, defaultVal, op) {
  return typeof value === 'number' ? value : resolveParticleOp(value, defaultVal, op).from;
}

function referenceTextureId(config) {
  let textureName = config.texture;
  if (config.spritesheet && config.animation !== undefined && !Array.isArray(config.frame)) {
    textureName = SpriteSheetRegistry.getFrameName(config.spritesheet, config.animation, config.frame ?? 0);
  }
  let textureId = textureName ? SpriteSheetRegistry.getTextureId(textureName) : 0;
  if (Array.isArray(config.frame) && config.spritesheet && config.animation !== undefined) {
    const frames = config.frame;
    const n = Math.min(8, frames.length);
    const ids = [];
    for (let f = 0; f < n; f++) {
      const fname = SpriteSheetRegistry.getFrameName(config.spritesheet, config.animation, frames[f]);
      if (!fname) continue;
      ids.push(SpriteSheetRegistry.getTextureId(fname));
    }
    if (ids.length > 0) textureId = ids.length === 1 ? ids[0] : ids[(rng() * ids.length) | 0];
  }
  return textureId | 0;
}

/** Decal.stamp before E-286, on the apply path (the values each stamp hands the particle worker). */
function referenceStamp(config, apply) {
  if (!config) return 0;
  const textureId = referenceTextureId(config);
  const count = Math.max(1, Math.round(randomRange(config.count, 1)));
  let n = 0;
  for (let i = 0; i < count; i++) {
    let scaleX;
    let scaleY;
    if (config.scale == null && config.scaleX != null && config.scaleY != null) {
      scaleX = referenceNumber(config.scaleX, 1, opA);
      scaleY = referenceNumber(config.scaleY, 1, opB);
    } else {
      const s = referenceNumber(config.scale ?? config.scaleX ?? config.scaleY, 1, opA);
      scaleX = s;
      scaleY = s;
    }
    const x = randomRange(config.x);
    const y = randomRange(config.y);
    const tint = typeof config.tint === 'number' ? config.tint : resolveParticleColorOp(config.tint, 0xffffff, opA).from;
    const alpha = referenceNumber(config.alpha, 1, opA);
    const blendMode = config.blendMode ?? 0;
    apply(x, y, tint, scaleX, scaleY, textureId, alpha, blendMode);
    n++;
  }
  return n;
}

/** Sprite-sheet lookups as plain functions of their arguments (the shipped and the reference stamp share them). */
function stubRegistry() {
  const saved = { getFrameName: SpriteSheetRegistry.getFrameName, getTextureId: SpriteSheetRegistry.getTextureId };
  SpriteSheetRegistry.getFrameName = (sheet, anim, frame) => (frame === 99 ? null : `${sheet}/${anim}/${frame}`);
  SpriteSheetRegistry.getTextureId = (name) => {
    let h = 7;
    for (let k = 0; k < name.length; k++) h = (h * 31 + name.charCodeAt(k)) & 0xffff;
    return h;
  };
  return () => Object.assign(SpriteSheetRegistry, saved);
}

const CASES = [
  { texture: 'blood', x: 812.4, y: 77.25, scaleX: 1.3, scaleY: 1.3, tint: 0x8811ff, alpha: 0.7, blendMode: 1 },
  { texture: 'blood', x: 96, y: 160, scaleX: 1.15, scaleY: 1.15, alpha: 1 },
  { x: 3, y: 4 },
  {},
  { texture: 'blood', x: 1, y: 2, scale: 2, scaleX: 3, scaleY: 4 },
  { texture: 'blood', x: 1, y: 2, scaleX: 3 },
  { texture: 'blood', x: 1, y: 2, scaleY: 5 },
  { texture: 'blood', x: 1, y: 2, scale: null, scaleX: 2, scaleY: 3 },
  { texture: 'blood', x: 1, y: 2, scaleX: null, scaleY: 3 },
  { texture: 'blood', x: null, y: null, tint: null, alpha: null, blendMode: null },
  { texture: 'blood', x: 1, y: 2, count: 3 },
  { texture: 'blood', x: 1, y: 2, count: 2.6 },
  { texture: 'blood', x: 1, y: 2, count: 0 },
  { texture: 'blood', x: 1, y: 2, count: { min: 2, max: 5 } },
  { texture: 'blood', x: { min: 0, max: 100 }, y: 2 },
  { texture: 'blood', x: 1, y: 2, tint: { min: 0x000000, max: 0xffffff } },
  { texture: 'blood', x: 1, y: 2, alpha: { from: 0.2, to: 1 }, scale: { min: 0.5, max: 2 }, count: 2 },
  { texture: 'blood', x: 1, y: 2, scaleX: { min: 1, max: 2 }, scaleY: 3 },
  { texture: 'blood', x: '5', y: 2 },
  { texture: 'blood', x: NaN, y: Infinity, tint: 0xffffffff, blendMode: 'add' },
  { spritesheet: 'civil1', animation: 'hurt', frame: 2, x: 1, y: 1 },
  { spritesheet: 'civil1', animation: 'hurt', x: 1, y: 1 },
  { spritesheet: 'civil1', animation: 'hurt', frame: [1, 2, 3], x: 1, y: 1, count: 3 },
  { spritesheet: 'civil1', animation: 'hurt', frame: [99], texture: 'blood', x: 1, y: 1 },
  { spritesheet: 'civil1', texture: 'blood', x: 1, y: 1 },
];

test('every stamp handed to apply, and the count returned, match the stamp before E-286', { concurrency: false }, () => {
  const restoreRegistry = stubRegistry();
  const savedRng = globalThis.rng;
  try {
    for (const config of CASES) {
      const got = [];
      Decal.bindStampApply((...args) => got.push(args));
      globalThis.rng = seededRandom(0xe286, 'test');
      const n = Decal.stamp(config);
      const want = [];
      globalThis.rng = seededRandom(0xe286, 'test');
      const m = referenceStamp(config, (...args) => want.push(args));
      assert.equal(n, m, `count for ${JSON.stringify(config)}`);
      assert.deepEqual(got, want, `stamps for ${JSON.stringify(config)}`);
    }
    assert.equal(Decal.stamp(null), 0);
  } finally {
    globalThis.rng = savedRng;
    Decal.bindStampApply(null);
    restoreRegistry();
  }
});

/** The ring's records, read as the particle worker reads them. */
function drain() {
  const out = [];
  Decal.drainStampRing((...args) => out.push(args));
  return out;
}

test('a plain stamp and a ranged one write the ring records the reference values give', { concurrency: false }, () => {
  const restoreRegistry = stubRegistry();
  const savedRng = globalThis.rng;
  Decal.bindStampApply(null);
  Decal.bindStampRing(Decal.createStampRingSab(64));
  try {
    for (const config of [CASES[0], CASES[10], CASES[16], CASES[19]]) {
      globalThis.rng = seededRandom(0xe286, 'test');
      const n = Decal.stamp(config);
      const got = drain();
      globalThis.rng = seededRandom(0xe286, 'test');
      const want = [];
      referenceStamp(config, (x, y, tint, scaleX, scaleY, textureId, alpha, blendMode) => {
        Decal.enqueueStamp(x, y, textureId, scaleX, scaleY, tint, alpha, blendMode);
      });
      want.push(...drain());
      assert.equal(n, want.length);
      assert.deepEqual(got, want, `records for ${JSON.stringify(config)}`);
    }
  } finally {
    globalThis.rng = savedRng;
    Decal.bindStampRing(null);
    restoreRegistry();
  }
});

test('with nowhere to send a stamp returns 0 before it resolves anything (no rng drawn)', { concurrency: false }, () => {
  const savedRng = globalThis.rng;
  Decal.bindStampApply(null);
  Decal.bindStampRing(null);
  try {
    globalThis.rng = seededRandom(5, 'test');
    for (const config of [CASES[0], CASES[13], CASES[16], CASES[22]]) assert.equal(Decal.stamp(config), 0);
    const next = rng();
    globalThis.rng = seededRandom(5, 'test');
    assert.equal(next, rng(), 'the rng is where it was');
  } finally {
    globalThis.rng = savedRng;
  }
});

test('a full ring stops the count and returns the stamps it took', { concurrency: false }, () => {
  const quiet = console.warn;
  console.warn = () => {};
  Decal.bindStampApply(null);
  Decal.bindStampRing(Decal.createStampRingSab(64));
  try {
    assert.equal(Decal.stamp({ x: 1, y: 2, count: 60 }), 60);
    assert.equal(Decal.stamp({ x: 1, y: 2, count: 10 }), 4, 'four places left');
    assert.equal(Decal.stamp({ x: { min: 0, max: 1 }, y: 2 }), 0, 'a ranged stamp into a full ring');
    assert.equal(drain().length, 64);
  } finally {
    console.warn = quiet;
    Decal.bindStampRing(null);
  }
});
