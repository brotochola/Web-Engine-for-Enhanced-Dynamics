import test from 'node:test';
import assert from 'node:assert/strict';

import { Tween, tweenBufferBytes, TWEEN_REPEAT_FOREVER } from '../../src/core/tween.js';
import { PARTICLE_EASE } from '../../src/util/configDefaults.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Transform } from '../../src/components/transform.js';
import { Messages } from '../../src/core/messages.js';
import { drainMessages } from '../../src/util/messageRing.js';
import { encodeBinarySaveBody, decodeBinarySaveBody, SECTION } from '../../src/core/save/binarySaveCodec.js';
import { TWEEN_RECORD_FIELDS } from '../../src/core/save/tweenRecord.js';

// DX 4.2. A tween could not wait, repeat, yoyo or say it had finished, and a
// tween on an entity that despawned kept painting whatever took its index.

const E = 4;

function setup(slots = 8) {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(E)), E);
  SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(E)), E);
  for (let i = 0; i < E; i++) {
    Transform.active[i] = 1;
    SpriteRenderer.active[i] = 1;
    SpriteRenderer.alpha[i] = 1;
  }
  Tween.bind(new SharedArrayBuffer(tweenBufferBytes(slots, E)), slots, E);
}

const near = (a, b) => Math.abs(a - b) < 1e-5;

test('delay: nothing moves until it has passed, then the tween runs its duration', () => {
  setup();
  Tween.to(0, { alpha: 0 }, 100, PARTICLE_EASE.LERP, { delay: 50 });
  Tween.tick(40);
  assert.equal(SpriteRenderer.alpha[0], 1);
  Tween.tick(60); // 50 of delay + 50 of the tween
  assert.ok(near(SpriteRenderer.alpha[0], 0.5), `${SpriteRenderer.alpha[0]}`);
  Tween.tick(50);
  assert.equal(SpriteRenderer.alpha[0], 0);
  assert.equal(Tween.active[0], 0, 'freed');
});

test('repeat runs extra cycles from the start; yoyo runs every other one backwards', () => {
  setup();
  Tween.to(0, { alpha: 0 }, 100, PARTICLE_EASE.LERP, { repeat: 1 });
  Tween.to(1, { alpha: 0 }, 100, PARTICLE_EASE.LERP, { repeat: 1, yoyo: true });
  Tween.tick(100); // end of cycle 1
  Tween.tick(50);
  assert.ok(near(SpriteRenderer.alpha[0], 0.5), 'repeat: from 1 again');
  assert.ok(near(SpriteRenderer.alpha[1], 0.5), 'yoyo: back up from 0');
  Tween.tick(25);
  assert.ok(near(SpriteRenderer.alpha[0], 0.25));
  assert.ok(near(SpriteRenderer.alpha[1], 0.75));
  Tween.tick(25);
  assert.deepEqual([SpriteRenderer.alpha[0], SpriteRenderer.alpha[1]], [0, 1]);
  assert.deepEqual([Tween.active[0], Tween.active[1]], [0, 0]);
});

test('repeat: -1 runs until cancelled', () => {
  setup();
  const slot = Tween.to(0, { alpha: 0 }, 10, PARTICLE_EASE.LERP, { repeat: -1, yoyo: true });
  assert.equal(Tween.repeat[slot], TWEEN_REPEAT_FOREVER);
  for (let k = 0; k < 100; k++) Tween.tick(7);
  assert.equal(Tween.active[slot], 1);
  Tween.cancel(0);
  assert.equal(Tween.active[slot], 0);
  assert.equal(Tween.entityTweens[0], 0);
});

test('onComplete sends the declared message to the entity once, after the last cycle', () => {
  setup();
  Messages.bind(Messages.createBuffers(1, 16, E), ['faded']);
  try {
    const slot = Tween.to(2, { alpha: 0 }, 100, PARTICLE_EASE.LERP, { repeat: 1, onComplete: 'faded' });
    Tween.tick(100);
    let got = [];
    drainMessages(Messages.inboxI32[0], Messages.inboxF64[0], (...m) => got.push(m));
    assert.deepEqual(got, [], 'not after the first cycle');
    Tween.tick(100);
    drainMessages(Messages.inboxI32[0], Messages.inboxF64[0], (...m) => got.push(m));
    assert.deepEqual(got, [[2, -1, 0, 0, slot, 0, 0, 0]]);
    assert.throws(() => Tween.to(2, { alpha: 1 }, 10, PARTICLE_EASE.LERP, { onComplete: 'nope' }), /'nope' is not declared/);
    assert.equal(Tween.entityTweens[2], 0, 'the refused tween claimed nothing');
  } finally {
    Messages.unbind();
  }
});

test('despawn cancels an entity\'s tweens, and only scans when it has some', () => {
  setup();
  Tween.to(1, { alpha: 0 }, 100);
  Tween.to(1, { tint: 0 }, 100);
  Tween.to(3, { alpha: 0 }, 100);
  assert.deepEqual(Array.from(Tween.entityTweens), [0, 2, 0, 1]);
  const realCancel = Tween.cancel;
  let scans = 0;
  Tween.cancel = function (...a) {
    scans++;
    return realCancel.apply(this, a);
  };
  try {
    Tween.cancelForDespawn(0); // no tweens: no scan
    Tween.cancelForDespawn(1);
  } finally {
    Tween.cancel = realCancel;
  }
  assert.equal(scans, 1);
  assert.deepEqual(Array.from(Tween.entityTweens), [0, 0, 0, 1]);
  SpriteRenderer.alpha[1] = 1; // the next occupant of slot 1
  Tween.tick(50);
  assert.equal(SpriteRenderer.alpha[1], 1, 'the old tween no longer paints the slot');
});

test('a finished tween freed by a racing cancel is only counted down once', () => {
  setup();
  const slot = Tween.to(0, { alpha: 0 }, 10);
  assert.equal(Tween._free(slot), true);
  assert.equal(Tween._free(slot), false);
  assert.equal(Tween.entityTweens[0], 0);
});

test('tweens save repeat / yoyo / onComplete, and a layout 1 save still loads', () => {
  setup();
  Tween.to(0, { alpha: 0 }, 100, PARTICLE_EASE.LERP, { repeat: 3, yoyo: true });
  const slots = [];
  for (let i = 0; i < Tween.capacity; i++) {
    if (Tween.active[i] !== 1) continue;
    const rec = {};
    for (const [name] of TWEEN_RECORD_FIELDS) rec[name] = Tween[name][i];
    slots.push(rec);
  }
  const payload = {
    sceneName: 'T', engineVersion: '0', layout: { types: [], totalEntityCount: 0 },
    camera: null, sun: null, entities: [], joints: [], tweens: slots,
  };
  const bytes = encodeBinarySaveBody(payload);
  const back = decodeBinarySaveBody(bytes);
  assert.equal(back.tweens[0].repeat, 3);
  assert.equal(back.tweens[0].flags, 1);

  // Rewrite the TWEENS2 section as layout 1 (no repeat / doneMsg / flags).
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(0, true);
  let o = 2;
  const out = [];
  for (let s = 0; s < count; s++) {
    const tag = view.getUint16(o, true);
    const len = view.getUint32(o + 2, true);
    let body = bytes.subarray(o + 6, o + 6 + len);
    if (tag === SECTION.TWEENS2) {
      const recBytes = (len - 5) / slots.length;
      const oldRec = recBytes - 9; // u32 repeat + u32 doneMsg + u8 flags
      const old = new Uint8Array(5 + oldRec * slots.length);
      old[0] = 1;
      old.set(body.subarray(1, 5), 1);
      for (let k = 0; k < slots.length; k++) old.set(body.subarray(5 + k * recBytes, 5 + k * recBytes + oldRec), 5 + k * oldRec);
      body = old;
    }
    out.push([tag, body]);
    o += 6 + len;
  }
  const total = 2 + out.reduce((n, [, b]) => n + 6 + b.length, 0);
  const legacy = new Uint8Array(total);
  const lv = new DataView(legacy.buffer);
  lv.setUint16(0, out.length, true);
  let w = 2;
  for (const [tag, body] of out) {
    lv.setUint16(w, tag, true);
    lv.setUint32(w + 2, body.length, true);
    legacy.set(body, w + 6);
    w += 6 + body.length;
  }
  const old = decodeBinarySaveBody(legacy);
  assert.equal(old.tweens.length, 1);
  assert.equal(old.tweens[0].duration, 100);
  assert.deepEqual([old.tweens[0].repeat, old.tweens[0].doneMsg, old.tweens[0].flags], [0, 0, 0]);
});
