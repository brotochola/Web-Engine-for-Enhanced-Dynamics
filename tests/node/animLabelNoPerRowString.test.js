// E-07 parity test: the per-row animation label must stop being a per-row string
// build, without changing what the warn path prints.
//
// `emitSpriteQueue` resolves one animation id per queued row. The label was a
// pre-built template string at all four call sites and is read ONLY inside the two
// warning branches of `_resolveAnimFrameStart`. Predator queues 20 000 swaying
// decorations, so that was ~20 000 string concatenations per frame in a loop that
// runs 20 000 times per frame.
//
// The risk being guarded: this is a *diagnostics* path. Making it cheaper must not
// make it wrong, because the day it is needed is the day somebody is debugging a
// missing texture and the label is the only clue they get. So the checksum here is
// the warning text itself, byte for byte.
//
// E-07 in docs/internal/EXECUTION_PLAN.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const src = read('src/workers/preRenderWorker.js');

// ------------------------------------------------- the label builder itself ---

// The frozen tables, read out of the source so this cannot drift from them.
// Statement boundary = the first `;` that closes the initialiser, respecting nesting.
function extractConst(name) {
  const decl = src.indexOf(`const ${name} = `);
  assert.ok(decl > 0, `could not find ${name}`);
  const from = src.indexOf('=', decl) + 1;
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ';' && depth <= 0) {
      return new Function(`return ${src.slice(from, i)};`)();
    }
  }
  throw new Error(`could not find the end of ${name}`);
}

// Extract a module-level function and give it the module constants it closes over.
// `new Function` compiles in global scope, so a bare extract of `formatAnimLabel`
// fails with `ANIM_LABEL_NAMES is not defined` - the tables are module-level consts
// that the extracted copy cannot see. They are injected as parameters instead.
function extractFn(name, deps = {}) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `could not find ${name}`);
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, `could not find the end of ${name}`);
  // Keep the SIGNATURE. A version sliced from the first `{` and dropped the
  // parameter list, which compiled to a function whose `kind` was undefined.
  const stripped = src.slice(start, end).replace(/\/\/[^\n]*/g, '');
  const names = Object.keys(deps);
  const fn = new Function(...names, `${stripped}\n} return ${name};`)(...names.map((n) => deps[n]));
  assert.ok(typeof fn === 'function', `${name} did not extract as a function`);
  return fn;
}

const ANIM_LABEL_TAG = extractConst('ANIM_LABEL_TAG');
const ANIM_LABEL_NAMES = extractConst('ANIM_LABEL_NAMES');
const formatAnimLabel = extractFn('formatAnimLabel', { ANIM_LABEL_NAMES });

test('every tag round-trips to the exact string the old template produced', () => {
  // The old call sites were literally these four templates. Byte equality here is
  // the whole point: this is a performance change to a diagnostics path.
  const old = [
    (i) => `particle:${i}`,
    (i) => `liquidFun:${i}`,
    (i) => `decoration:${i}`,
    (i) => `bullet:${i}`,
  ];
  const tags = [
    ANIM_LABEL_TAG.PARTICLE,
    ANIM_LABEL_TAG.LIQUID_FUN,
    ANIM_LABEL_TAG.DECORATION,
    ANIM_LABEL_TAG.BULLET,
  ];
  for (let t = 0; t < tags.length; t++) {
    for (const idx of [0, 1, 7, 255, 4096, 65534]) {
      assert.equal(
        formatAnimLabel(tags[t], idx),
        old[t](idx),
        `tag ${tags[t]} at ${idx}`,
      );
    }
  }
});

test('tags and names line up one to one', () => {
  assert.equal(ANIM_LABEL_NAMES.length, 4);
  for (let t = 0; t < ANIM_LABEL_NAMES.length; t++) {
    assert.equal(ANIM_LABEL_NAMES[t], formatAnimLabel(t, 0).split(':')[0]);
  }
});

test('a literal string kind still passes through, for the name-based caller', () => {
  // `_resolveAnimFrameStart(map[name], name)` at the builtin lookup is NOT in the
  // per-row path and passes a name. It must keep working.
  assert.equal(formatAnimLabel('zombie', 42), 'zombie:42');
});

test('a null / undefined animIdx renders exactly as template coercion did', () => {
  // `${null}` is "null" and `${undefined}` is "undefined". String() matches both,
  // but this is the kind of thing that silently changes a log line, so it is pinned.
  assert.equal(formatAnimLabel(ANIM_LABEL_TAG.PARTICLE, null), 'particle:null');
  assert.equal(formatAnimLabel(ANIM_LABEL_TAG.PARTICLE, undefined), 'particle:undefined');
  assert.equal(formatAnimLabel(ANIM_LABEL_TAG.PARTICLE, -1), 'particle:-1');
});

// ------------------------------------------------------ the call-site shape ---

test('no per-row call site builds a template string any more', () => {
  // This is the regression that made the change necessary. If one comes back, the
  // allocation returns.
  for (const [line, pattern] of [
    ['particle call site', /_resolveAnimFrameStart\(pAnimIdx,\s*`/],
    ['liquidFun call site', /_resolveAnimFrameStart\(lfAnimIdx,\s*`/],
    ['decoration call site', /_resolveAnimFrameStart\(dAnimIdx,\s*`/],
    ['bullet call site', /_resolveAnimFrameStart\(bAnimIdx,\s*`/],
  ]) {
    assert.ok(!pattern.test(src), `${line} builds a template string per row again`);
  }
});

test('all four per-row call sites pass a tag, not a string', () => {
  // Filter out the DEFINITION, which matches the same pattern. A first version
  // counted it and reported "expected 4, found 5".
  // Four: the decoration, bullet, particle and LiquidFun warnings the emit kernel hands back (_emitWarn). The
  // emit loop's own call sites left with the JS emit (close-out group B: tests/reference/preRenderEmitJs.mjs).
  const defIndex = src.indexOf('_resolveAnimFrameStart(animIdx, kind) {');
  const calls = [...src.matchAll(/_resolveAnimFrameStart\(([^,]+),\s*([^)]+)\)/g)]
    .map((m, i) => ({ arg: m[1].trim(), kind: m[2].trim(), at: m.index }))
    .filter((c) => c.at !== defIndex);
  const perRow = calls.filter((c) => c.arg !== 'map[name]');
  assert.equal(perRow.length, 4, `expected 4 per-row call sites, found ${perRow.length}`);
  for (const c of perRow) {
    assert.match(c.kind, /^ANIM_LABEL_TAG\./, `${c.arg} does not pass a tag`);
  }
  // The name-based caller is the one outside the per-row path and keeps its string.
  assert.equal(calls.length, perRow.length + 1, 'unexpected extra call site');
});

test('the label is only built on a warn path', () => {
  const start = src.indexOf('_resolveAnimFrameStart(animIdx, kind) {');
  assert.ok(start > 0, 'could not find _resolveAnimFrameStart');
  const end = src.indexOf('\n    }', start);
  const fn = src.slice(start, end);
  const build = [...fn.matchAll(/const label = formatAnimLabel\(/g)];
  assert.equal(build.length, 2, 'expected one label build per warn branch');
  // Each build must sit inside a failure branch, not before the fast return.
  for (const m of build) {
    const before = fn.slice(0, m.index);
    const guard = before.lastIndexOf('if (');
    assert.ok(guard > 0, 'label built outside a guard');
    const sinceGuard = fn.slice(guard, m.index);
    assert.match(sinceGuard, /return INVALID_TEXTURE_ID|===\s*null|<\s*0/, 'label not on a failure path');
  }
  // And the hot return must not build anything.
  assert.match(fn, /return start \| 0;/, 'fast path missing');
});

test('the warn key no longer repeats the index', () => {
  // Old: label was already "particle:123" and the key was `frameStart:${label}:${animIdx}`
  // -> "frameStart:particle:123:123". The index appeared twice. The label now carries
  // it once. Pin the corrected form so it cannot drift back.
  assert.ok(src.includes('`frameStart:${label}`'), 'warn key shape changed unexpectedly');
  assert.ok(!src.includes('`frameStart:${label}:${animIdx}`'), 'warn key repeats the index');
});

test('the success path allocates nothing extra', () => {
  const start = src.indexOf('_resolveAnimFrameStart(animIdx, kind) {');
  const end = src.indexOf('\n    }', start);
  const fn = src.slice(start, end);

  // There is no contiguous "success path" slice: the second warn branch sits
  // BETWEEN the animationFrameStart read and the final return, so slicing from the
  // read to the return sweeps the branch in. What is true is structural - exactly
  // two label builds, each the first statement of a guard that returns early, and
  // nothing left to run but `return start | 0`.
  const builds = [...fn.matchAll(/const label = formatAnimLabel\(/g)];
  assert.equal(builds.length, 2, 'expected exactly two label builds, both on warn paths');

  for (const b of builds) {
    const before = fn.slice(0, b.index);
    const guard = before.lastIndexOf('if (');
    assert.ok(guard > 0, 'a label is built outside any guard');
    assert.match(
      fn.slice(guard, b.index),
      /\{\s*$/,
      'a label build is not the first statement of its guard',
    );
  }

  // After the LAST early return there is only the guard's closing brace and the
  // successful return. A first version anchored with /^return/ and failed on the
  // leading `}` - a test that was right about the code and wrong about its shape.
  const lastGuardReturn = fn.lastIndexOf('return INVALID_TEXTURE_ID;');
  const tail = fn.slice(lastGuardReturn + 'return INVALID_TEXTURE_ID;'.length);
  assert.ok(!tail.includes('formatAnimLabel'), 'the success path builds a label');
  assert.ok(!tail.includes('`'), 'the success path builds a template string');
  assert.equal(
    tail.replace(/\s/g, ''),
    '}returnstart|0;',
    'the success path does something other than return the resolved start',
  );
});