import test from 'node:test';
import assert from 'node:assert/strict';

import { checkProbe, PROBES } from '../bench/hypothesisProbes.mjs';

/**
 * These probes exist because a sitting can measure the wrong code and still look
 * like data. `spritePackStressScene` produced VISIBLE_ENTITIES 734 and 11139 -
 * non-zero, plausible, and both wrong - while STEP_MS sat in a healthy band and
 * FPS stayed at 60.
 *
 * Every fixture below is either a real output from that scene or the shape that
 * would have caught it.
 */

test('a hypothesis with no registered probe is refused, not accepted', () => {
  const r = checkProbe('H-99', { VISIBLE_ENTITIES: 5000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_PROBE');
  assert.match(r.detail, /nothing has established/);
});

test('the wrong key, even when non-zero, does not satisfy the probe', () => {
  // This is the v4 failure exactly: GPU_CASTERS is populated, which looks alive,
  // but the pack path is driven by the preRender queue.
  const r = checkProbe('H-02', { GPU_CASTERS: 13558, RENDER_QUEUE_SIZE: 0 }, 150000);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PATH_NOT_RUN');
  assert.match(r.detail, /packInstancedRows packs the queued rows/);
});

test('the pack runs in preRender, not renderer - and the probe says so', () => {
  // packSpriteLayer is called from pixiWorker.js:1473 AND preRenderWorker.js:3041.
  // Measured on spritePackStressScene: preRender SPRITE_PACK_MS 1.360 while the
  // renderer QUEUE_MS was 0.012 for the same 45 568 queued sprites. Naming the
  // wrong worker here would have passed a sitting that packed nothing.
  assert.equal(PROBES['H-02'].worker, 'preRender');
  assert.equal(PROBES['H-02'].key, 'RENDER_QUEUE_SIZE');

  // The real 4K sweep numbers, against the real 65 535 ceiling.
  //   spacing 24 -> 21 340 queued (32.6 %)  REFUSED, an underfed vehicle
  //   spacing 16 -> 41 984 queued (64.0 %)  accepted
  //   spacing 10 -> 45 056 queued (68.8 %)  accepted
  //   spacing  6 -> 45 568 queued (69.5 %)  accepted
  //
  // The floor is what separates "a scene that packed a lot" from "a scene that
  // packed what it was asked to pack", and spacing 24 is the first case where
  // those differ.
  const refused = checkProbe('H-02', { RENDER_QUEUE_SIZE: 21340 }, 65535);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'PATH_UNDERFED');
  assert.match(refused.detail, /32\.6% < 50% floor/);

  for (const n of [41984, 45056, 45568]) {
    assert.equal(checkProbe('H-02', { RENDER_QUEUE_SIZE: n }, 65535).ok, true, `${n} should pass`);
  }
});

test('a self-cancelling queue is refused (the v3/v4 shape, on the real key)', () => {
  const r = checkProbe('H-02', { RENDER_QUEUE_SIZE: 11139 }, 65535);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PATH_UNDERFED');
  assert.match(r.detail, /17\.0%/);
});

test('the v3 shape - 734 of 60000 - is refused too', () => {
  const r = checkProbe('H-02', { RENDER_QUEUE_SIZE: 734 }, 60000);
  assert.equal(r.code, 'PATH_UNDERFED');
});

test('a genuinely fed path passes', () => {
  const r = checkProbe('H-02', { RENDER_QUEUE_SIZE: 45568 }, 65535);
  assert.equal(r.ok, true);
  assert.equal(r.code, 'OK');
  assert.match(r.detail, /45568 of 65535/);
});

test('no expected population means presence only, not saturation', () => {
  // Predator does not take a count from the URL, so the probe cannot check a
  // share - but it can still insist the path ran.
  const r = checkProbe('H-02', { RENDER_QUEUE_SIZE: 45568 });
  assert.equal(r.ok, true);
});

test('each probe names its own worker and key', () => {
  // The mapping is the whole point, so it is asserted rather than assumed: a
  // worker-kind-derived table would let every probe collapse to the same keys.
  const seen = new Set();
  for (const [id, p] of Object.entries(PROBES)) {
    assert.equal(p.id, id, `${id} is filed under the wrong id`);
    assert.ok(p.worker, `${id} has no worker`);
    assert.ok(p.key, `${id} has no key`);
    assert.ok(p.why && p.why.length > 20, `${id} has no usable explanation`);
    assert.ok(p.floor >= 0 && p.floor <= 1, `${id} has a nonsensical floor`);
    seen.add(`${p.worker}.${p.key}`);
  }
  assert.ok(seen.size >= 4, 'the probes must not collapse onto one key per worker');
});

test('a missing key is refused, and says it is missing (review D3)', () => {
  const r = checkProbe('H-14', { BODY_COUNT: 9000 }, 50000);
  assert.equal(r.ok, false, 'ENTITIES_PROCESSED missing must not read as fine');
  assert.equal(r.code, 'KEY_NOT_PUBLISHED');
  // A key that is there and zero is the path not running.
  assert.equal(checkProbe('H-14', { ENTITIES_PROCESSED: 0 }, 50000).code, 'PATH_NOT_RUN');
});

test('floor 0 admits a zero key but says out loud that the probe is weak', () => {
  // H-13 is about a sweep that runs whether or not anything is dirty, so its key
  // is legitimately zero in a healthy run. Admitting it is right; pretending it
  // proves anything is not, so the verdict is flagged weak.
  const r = checkProbe('H-13', { DECAL_TILES_DIRTY: 0 }, 50000);
  assert.equal(r.ok, true, 'a zero-but-reached path must be allowed when floor is 0');
  assert.equal(r.weak, true);
  assert.match(r.detail, /WEAK PROBE/);
});

test('a floor-0 hypothesis cannot silently look like a strong one', () => {
  // The weakness is per-probe and permanent, not a one-off note on one result.
  assert.equal(
    checkProbe('H-02', { RENDER_QUEUE_SIZE: 45568 }).weak,
    false,
    'a strong probe must be explicitly strong, not merely unflagged',
  );
});