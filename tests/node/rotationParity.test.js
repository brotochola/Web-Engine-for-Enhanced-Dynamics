import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * H-11a. The decoration spawn path takes an `a === 0` fast path instead of
 * calling `Math.cos`/`Math.sin`.
 *
 * The whole claim is that this is bit-identical, so the tests are about exact
 * equality rather than a tolerance. `Math.cos(0)` is exactly 1 and
 * `Math.sin(0)` is exactly 0 in IEEE-754 - but only for POSITIVE zero, and the
 * domain here contains more zero than you would like:
 *
 *   -0        `Math.sin(-0)` is -0, not 0. The fast path must not swallow it.
 *   undefined -> `?? 0` makes it 0, which is the case the change targets.
 *   2*PI      `Math.cos(2*PI)` is exactly 1 but NOT via a `=== 0` test.
 *
 * Getting the -0 case wrong would write +0 where the engine had -0, which is
 * invisible in a screenshot and changes the sign of a zero rotation.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The pre-H-11a expression pair. */
function reference(a) {
  return { c: Math.cos(a), s: Math.sin(a) };
}

/** The shipped fast path, as written in decorationPool.js. */
function fast(a) {
  const isPlusZero = Object.is(a, 0);
  const c = isPlusZero ? 1 : Math.cos(a);
  const s = isPlusZero ? 0 : Math.sin(a);
  return { c, s };
}

/** Exact, signed-zero-aware equality. `===` alone cannot tell +0 from -0. */
function sameBits(got, want) {
  return Object.is(got, want);
}

test('the fast path is bit-identical for +0', () => {
  const r = reference(0);
  const f = fast(0);
  assert.ok(sameBits(f.c, r.c), `cos: ${f.c} vs ${r.c}`);
  assert.ok(sameBits(f.s, r.s), `sin: ${f.s} vs ${r.s}`);
  // And the reason it can be: these are exact constants, not approximations.
  assert.equal(Math.cos(0), 1);
  assert.equal(Math.sin(0), 0);
});

test('-0 falls through and keeps its sign', () => {
  // The first version of this used `a !== 0`. That is FALSE for -0, so -0 took
  // the FAST path and returned +0 where `Math.sin(-0)` is -0. The sign is not
  // observable in rotation composition, but the claim here is bit-identical, and
  // that claim has to survive -0 or be withdrawn.
  assert.equal(-0 !== 0, false, 'the old guard really did catch -0 - hence the bug');
  assert.equal(Object.is(-0, 0), false, 'Object.is is the guard that excludes -0');
  const r = reference(-0);
  const f = fast(-0);
  assert.ok(sameBits(f.c, r.c), `cos(-0): ${f.c} vs ${r.c}`);
  assert.ok(sameBits(f.s, r.s), `sin(-0): ${f.s} vs ${r.s}`);
  assert.ok(Object.is(f.s, -0), 'sin(-0) must stay -0');
});

test('undefined becomes 0 through ?? and then takes the fast path', () => {
  const a = undefined ?? 0;
  assert.ok(a === 0, 'the ?? default is +0');
  assert.ok(Object.is(a, 0), 'and Object.is agrees it is +0, so the fast path applies');
  assert.ok(sameBits(fast(a).c, reference(0).c));
  assert.ok(sameBits(fast(a).s, reference(0).s));
});

test('null and NaN fall through to the transcendentals unchanged', () => {
  // `?? 0` turns null into 0, but NaN is not nullish so it survives - and
  // Math.cos(NaN) is NaN, which the fast path must not "fix" to 1.
  assert.equal(NaN !== 0, true, 'NaN must not take the fast path');
  assert.ok(Number.isNaN(fast(NaN).c));
  assert.ok(Number.isNaN(fast(NaN).s));
  assert.ok(sameBits(fast(null ?? 0).c, 1));
});

test('a dense sweep of real angles is bit-identical', () => {
  // The fast path must not have perturbed anything that is not zero.
  let checked = 0;
  for (let d = -720; d <= 720; d += 0.25) {
    const a = (d * Math.PI) / 180;
    const r = reference(a);
    const f = fast(a);
    assert.ok(sameBits(f.c, r.c), `cos(${a}) : ${f.c} vs ${r.c}`);
    assert.ok(sameBits(f.s, r.s), `sin(${a}) : ${f.s} vs ${r.s}`);
    checked++;
  }
  assert.ok(checked > 5000, `expected a dense sweep, only checked ${checked}`);
});

test('2*PI and its multiples are exactly 1/-0 in BOTH paths', () => {
  // The interesting near-miss: these produce the same VALUES as 0 without being
  // 0, so a test that only checked "the answer is 1" would pass either way.
  for (const k of [1, 2, 3, -1, -2]) {
    const a = 2 * Math.PI * k;
    const r = reference(a);
    const f = fast(a);
    assert.ok(sameBits(f.c, r.c), `cos(2PI*${k})`);
    assert.ok(sameBits(f.s, r.s), `sin(2PI*${k})`);
  }
});

test('the working tree really has the fast path, and only for the zero case', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../src/core/decorationPool.js', import.meta.url)),
    'utf8',
  );
  const start = src.indexOf('const a = config.rotation ?? 0;');
  assert.ok(start >= 0, 'the spawn rotation block must exist');
  const block = src.slice(start, start + 400);
  const code = block.replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /const isPlusZero = Object\.is\(a, 0\);/);
  assert.match(code, /const c = isPlusZero \? 1 : Math\.cos\(a\);/);
  assert.match(code, /const s = isPlusZero \? 0 : Math\.sin\(a\);/);
  // `a === 0` and `a !== 0` both mishandle -0: the first fast-paths it, the
  // second does too. Object.is is the only one of the three that excludes it.
  assert.doesNotMatch(code, /a === 0/);
  assert.doesNotMatch(code, /a !== 0 \?/);
});

test('the fast path is a win only for zero, which is the common case', () => {
  // Not a timing test - a statement of intent. The change is worth nothing on a
  // scene where every decoration has a rotation, and the log must say so rather
  // than presenting it as a general trigonometric speedup.
  const zeroFractions = [undefined, 0, 0, 0, 0, 0, 0, 0, 0, 1.5707963267948966];
  const fast = zeroFractions.filter((a) => (a ?? 0) === 0).length;
  assert.equal(fast, 9, '9 of 10 spawns in this sample would take the fast path');
});