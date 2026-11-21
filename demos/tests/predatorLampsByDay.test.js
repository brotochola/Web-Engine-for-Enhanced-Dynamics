import test from 'node:test';
import assert from 'node:assert/strict';

import '../../tests/helpers/registerWebRoot.mjs';

// Predator's street lamps are lit at night only, and switch at once (the owner, 2026-11-21: "de repente, como las
// luces normales"): TallLight.tickAll sets every lamp's brightness to 1 when the night light starts (Sun.nightFactor
// above 0) and to 0 when it ends, all lamps whoever ticks them, and touches nothing on the frames between. A lamp
// spawned later comes up like the others at that hour. At brightness 0 the engine skips the light (E-531).

const { LightEmitter } = await import('../../src/components/lightEmitter.js');
const { SpriteRenderer } = await import('../../src/components/spriteRenderer.js');
const { Collider } = await import('../../src/components/collider.js');
const { Sun } = await import('../../src/core/sun.js');
const { TallLight } = await import('../predatorScene/gameObjects/tallLight.js');

const N = 16;
const LAMPS = [2, 5, 7];

function stub(owner, key, value, saved) {
  saved.push([owner, key, owner[key]]);
  owner[key] = value;
}

test('the lamps switch on when night falls and off when day comes, at once, and a new lamp matches the hour', () => {
  LightEmitter.initializeArrays(new SharedArrayBuffer(LightEmitter.getBufferSize(N)), N);
  Sun.initialize(new SharedArrayBuffer(Sun.BYTE_LENGTH));
  Sun.nightFrom = 0.4;
  Sun.nightTo = 0.1;
  const savedList = TallLight._activeList;
  TallLight._activeList = Uint16Array.from([LAMPS.length, ...LAMPS]);
  const saved = [];
  try {
    const brightness = () => LAMPS.map((i) => LightEmitter.brightness[i]);
    LightEmitter.brightness.fill(1);

    // Noon: off, every lamp, from the first frame.
    Sun.intensity = 1;
    TallLight.tickAll(new Uint16Array(0), 0);
    assert.deepEqual(brightness(), [0, 0, 0], 'off by day');

    // Dusk, the sun just under night.from: on at once (no fade: full brightness on that frame).
    Sun.intensity = 0.39;
    assert.ok(Sun.nightFactor > 0 && Sun.nightFactor < 0.1);
    TallLight.tickAll(new Uint16Array(0), 0);
    assert.deepEqual(brightness(), [1, 1, 1], 'on at dusk, full at once');

    // A frame with no change of day or night writes nothing (another value set meanwhile stays).
    LightEmitter.brightness[5] = 0.5;
    Sun.intensity = 0.2;
    TallLight.tickAll(new Uint16Array(0), 0);
    assert.equal(LightEmitter.brightness[5], 0.5, 'no switch, no write');

    // A lamp spawned by night comes up lit.
    stub(SpriteRenderer, 'setSprite', () => {}, saved);
    stub(Collider, 'setShapeType', () => {}, saved);
    stub(Collider, 'setRadius', () => {}, saved);
    stub(Collider, 'setOffsetY', () => {}, saved);
    stub(LightEmitter, 'setGlow', () => {}, saved);
    LightEmitter.brightness[9] = 0;
    TallLight.onSpawned(9, {});
    assert.equal(LightEmitter.brightness[9], 1, 'spawned by night: lit');

    // Dawn: off at once; a lamp spawned by day comes up off.
    Sun.intensity = 0.6;
    TallLight.tickAll(new Uint16Array(0), 0);
    assert.deepEqual(brightness(), [0, 0, 0], 'off by day again');
    TallLight.onSpawned(10, {});
    assert.equal(LightEmitter.brightness[10], 0, 'spawned by day: off');
  } finally {
    TallLight._activeList = savedList;
    for (let k = saved.length - 1; k >= 0; k--) saved[k][0][saved[k][1]] = saved[k][2];
  }
});
