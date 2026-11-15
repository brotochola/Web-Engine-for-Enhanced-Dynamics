// E-26: the pair-key comment in logicWorker.js.
//
// This is a hygiene hypothesis with an unusually clear falsifier, which is why it is
// worth a test rather than a code review.
//
// The comment read:
//
//   /** Float64Array, not Int32Array: this key overflows a 32-bit int well before
//    *  the entity cap. */
//
// It was wrong three separate ways, and each is independently checkable:
//
//   1. **The type is not in the file.** `Float64Array` appeared exactly once in
//      logicWorker.js: in the comment. The pair key lives in `this._pairSlot`, a Map,
//      so it is a JS number. The comment documented a declaration that did not exist.
//   2. **It was attached to nothing.** It sat between `FOREIGN_SWEEP_FRAMES` and the
//      B-09 block, so a reader looking for the Float64Array (or for what it was
//      justifying) found the B-09 queue caps instead.
//   3. **It read as a performance claim.** "not Int32Array" beside a hashing-heavy
//      loop is a performance claim. It is not - it describes storage. That reading is
//      what made E-10 a two-line hypothesis; E-10 then swept 715 838 805 keys and found
//      zero boxed, because JS `<<` is 32-bit *signed* and `pack16` can never exceed
//      int32 at the default 16-bit width.
//
// The replacement notes live where the key is actually built (entityIdWidth.js, on
// `packPair`) plus a pointer at the Map. This file makes all three failures loud if
// they come back, and checks the measurement is still true.
//
// E-26 in docs/internal/EXECUTION_PLAN.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const LOGIC = 'src/workers/logicWorker.js';
const IDW = 'src/util/entityIdWidth.js';

// --- failure 1: the type was never there -----------------------------------

test('logicWorker.js keeps the pair key out of any Float64Array, and no comment claims one', () => {
  // Strip comments first, or the note that explains the removal documents the very
  // symbol it is reporting as absent - the trap that broke four earlier test files.
  // E-125 added one Float64Array, the spawn sort's packed keys (E-344 the despawn sort's). E-282 moved the pair from a Map key to two
  // Int32Array columns of an open-addressing table.
  const src = code(LOGIC);
  const uses = src.match(/[\w.]*\s*=\s*new Float64Array\(/g) || [];
  for (const use of uses) {
    // E-344 sorts the despawn batch with the same packed keys.
    assert.match(use, /_(de)?spawnSortKeys/, `logicWorker.js makes a Float64Array other than the spawn keys: ${use}`);
  }
  assert.ok(/this\._pairHashMin = new Int32Array\(/.test(src), 'the pair table keeps its ids in Int32Arrays');
  assert.ok(!/_pairSlot/.test(src), 'no Map of pair keys is left');
});

test('the removal note does not itself read as the claim it removes', () => {
  // It has to be able to name the old text without being read as the new claim. The
  // test above is what enforces the distinction: comments are stripped, code is not.
  const src = read(LOGIC);
  assert.match(src, /there is no Float64Array in this file|There is no Float64Array in this file/);
  // And the old claim must be quoted only in a sentence that refutes it.
  assert.match(src, /0 boxed|zero boxed/, 'the removal note does not carry E-10\'s measurement');
});

// --- failure 2: the comment was attached to nothing -------------------------

test('no floating JSDoc sits between FOREIGN_SWEEP_FRAMES and the B-09 block', () => {
  const src = read(LOGIC);
  const at = src.indexOf('FOREIGN_SWEEP_FRAMES = 30;') + 'FOREIGN_SWEEP_FRAMES = 30;'.length;
  // Anchor on the B-09 block's OPENING `/**`, not on its first line of text. Slicing to
  // "B-09 / H-17 caps" includes that block's own JSDoc opener, so the first version of
  // this test reported the B-09 comment as the floating one it was looking for.
  const b09Doc = src.indexOf('/**', src.indexOf('B-09', at) - 200);
  const b09Text = src.indexOf('B-09 / H-17 caps');
  assert.ok(at > 0 && b09Text > at, 'expected FOREIGN_SWEEP_FRAMES to precede the B-09 block');
  const opener = src.lastIndexOf('/**', b09Text);
  const between = src.slice(at, opener);
  assert.equal(
    between.trim(),
    '',
    `something floats between FOREIGN_SWEEP_FRAMES and the B-09 block, where it will be read as documenting B-09:\n${between}`,
  );
  void b09Doc;
});

test('the pointer sits on the table that actually stores the pair', () => {
  const src = read(LOGIC);
  const at = src.indexOf('this._pairHashMin = new Int32Array(0);');
  assert.ok(at > 0, 'the pair table is gone');
  // E-282: the note now sits just ABOVE the table it explains (it names the Map it replaced
  // and the key that Map used). The window stops at the declaration, and nothing may
  // separate the two: a blank line between them would make the note float again.
  const note = src.slice(src.lastIndexOf('E-282:', at), at);
  assert.match(note, /collisionPairKey/, 'the table has no note about the key it replaced');
  // And it must name where the real explanation lives, so the reader is sent there
  // rather than left with a pointer that goes nowhere.
  assert.match(note, /entityIdWidth\.js/, 'the note does not say where the key is built');
  assert.ok(note.length < 1200 && !/\n\s*\n/.test(note), 'the note is not adjacent to the declaration it explains');
});

// --- the replacement is accurate -------------------------------------------

test('the packPair note states the measured fact, not the removed claim', async () => {
  const { packPair } = await import('../../src/util/entityIdWidth.js');
  assert.match(read(IDW), /715 838 805/, "E-10's key count is not cited next to packPair");
  assert.match(read(IDW), /32-bit \*\*signed\*\*|32-bit signed/, 'the signedness of << is not stated');

  // The claim the note makes, checked rather than asserted: pack16 cannot exceed int32.
  assert.equal(typeof packPair, 'function');
  let sawNegative = false;
  for (const [a, b] of [[0, 1], [65535, 65535], [1, 65535], [65535, 0], [0xffff, 0xffff], [32768, 32768]]) {
    const k = packPair(a, b);
    assert.ok(Number.isInteger(k), `pack16(${a},${b}) = ${k} is not an integer`);
    assert.ok(k >= -2147483648 && k <= 2147483647, `pack16(${a},${b}) = ${k} is outside int32`);
    if (k < 0) sawNegative = true;
  }
  // And the reason the sign matters: a negative key is a proof that << is signed, which
  // is exactly the fact the removed comment got backwards.
  assert.ok(sawNegative, 'pack16 never produced a negative key; the signedness claim is untested');
});

test('the note flags that 32-bit width is the one case where a double is real', () => {
  // Otherwise the note reads as "this key is always an int32", which is false under
  // entityIdWidth: 32 - and that is E-27's subject, not a settled question.
  const src = read(IDW);
  assert.match(src, /packCantor/, 'the note does not mention the 32-bit path');
  assert.match(src, /exceed int32|exceeds int32/, 'the note does not say when a double actually occurs');
  assert.match(src, /E-27/, 'the note does not forward the open question to E-27');
});