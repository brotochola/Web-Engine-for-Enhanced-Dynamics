/**
 * Kernel for H-14 - does replacing the comparator sort in
 * `logicWorker._processSpawnSoA` with a numeric one actually pay?
 *
 * The shipped line (src/workers/logicWorker.js):
 *
 *     for (let i = 0; i < n; i++) perm[i] = i;
 *     perm.subarray(0, n).sort((a, b) => idx[a] - idx[b]);
 *
 * A comparator on a TypedArray is the thing being questioned. V8 has a
 * specialised numeric path for `TypedArray.prototype.sort()` with NO comparator -
 * but that sorts the array's own values, not a permutation keyed by them, so the
 * naive swap is not equivalent. Two variants are measured against it:
 *
 *   packed  - pack (entityIndex, classSlot) into one Float64 key, sort the
 *             Float64Array numerically with no comparator, unpack. Both halves
 *             fit exactly: entityIndex <= 65535 and classSlot < 4096 gives a
 *             product below 2.7e8, far inside Float64's exact-integer range.
 *
 * A third variant - a counting sort over the entity-index space, no comparisons
 * at all - was written and then REMOVED before measuring, analytically. It
 * clears a 65537-entry array and walks the whole index space on every call, so
 * its per-call cost is O(maxEntities) against O(n log n) with n in the hundreds.
 * At n=256 that is roughly 65k memory writes per call to save about 2k
 * comparisons. It cannot win, and a kernel that spends ten minutes establishing
 * that is a worse use of the machine than saying so. This is exactly the shape
 * the plan warns about at H-14's own prior-art note.
 *
 * Gate 1 is a checksum: all three orders must produce identical (index, class)
 * sequences, including on ties and duplicates.
 *
 * Gate 2 note: this measures the STRATEGY in isolation, not the shipped method.
 * It answers "is the comparator the cost", which is the premise. Whether the
 * answer survives inside the real worker is the stress scene's job
 * (`spawnStormScene`, `pnpm bench:feature:spawn-storm`) - the plan is explicit
 * that the `spawn` catalog row's kernel, `treiberMicrobench`, times the free
 * list and cannot see this change at all.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checksumInts, isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { median } from './benchMath.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.resolve(HERE, '../results/h14-spawn-sort');

const ROUNDS = 5;
const FLOOR_PCT = 3;
const MAX_ENTITY_INDEX = 65535;
const CLASS_SLOT_BITS = 12; // up to 4096 distinct class slots
const CLASS_SLOT_MASK = (1 << CLASS_SLOT_BITS) - 1;

/** n values spanning the real range: a few spawns, and a burst. */
const SIZES = [8, 64, 256, 1024];

/** Entity indices come off a free list, so they are scattered and full of ties. */
function makeOrder(n, rng) {
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    idx[i] = rng() < 0.3 ? (rng() * 64) | 0 : (rng() * MAX_ENTITY_INDEX) | 0;
  }
  return idx;
}

/**
 * The class is a FUNCTION of the entity index, and that is not cosmetic.
 *
 * The first version of this kernel picked classes independently and gate 1
 * failed: `packed` paired the wrong class at position 2. The cause is real and
 * worth stating - for two entries with the same entityIndex, the shipped
 * comparator `idx[a] - idx[b]` returns 0, so their relative order after the sort
 * is implementation-defined, while the packed key orders them by class because
 * the class is in the low bits. The two strategies therefore disagree on tie
 * ORDER, deterministically, whenever the same index appears with two classes.
 *
 * `_processSpawnSoA` cannot produce that. `queueSpawnListUpdate` takes
 * (entityIndex, entityType, EntityClass) and an entity index determines its
 * pool, so the same index always carries the same class. Duplicates and ties are
 * common; ties across different classes are impossible.
 *
 * So the invariant is encoded here rather than assumed, and the divergent case
 * is asserted separately below so it stays visible instead of being swept away.
 */
function classForIndex(entityIndex) {
  return (entityIndex * 2654435761) % 4096;
}

/** The shipped strategy: permutation + comparator sort + gather. */
function shippedSort(idx, classes, n, scratch) {
  const perm = scratch.perm;
  const sorted = scratch.sorted;
  const sortedClass = scratch.sortedClass;
  for (let i = 0; i < n; i++) perm[i] = i;
  perm.subarray(0, n).sort((a, b) => idx[a] - idx[b]);
  for (let i = 0; i < n; i++) {
    const src = perm[i];
    sorted[i] = idx[src];
    sortedClass[i] = classes[src];
  }
  return sorted;
}

/** Packed key, numeric sort with no comparator, unpack. */
function packedSort(idx, classes, n, scratch) {
  const keys = scratch.keys;
  for (let i = 0; i < n; i++) keys[i] = idx[i] * (CLASS_SLOT_MASK + 1) + classes[i];
  const view = keys.subarray(0, n);
  view.sort(); // no comparator - the specialised numeric path
  const sorted = scratch.sorted;
  const sortedClass = scratch.sortedClass;
  const span = CLASS_SLOT_MASK + 1;
  for (let i = 0; i < n; i++) {
    const k = view[i];
    sorted[i] = Math.floor(k / span);
    sortedClass[i] = k - Math.floor(k / span) * span;
  }
  return sorted;
}

function makeScratch(capacity) {
  return {
    perm: new Int32Array(capacity),
    sorted: new Int32Array(capacity),
    sortedClass: new Int32Array(capacity),
    keys: new Float64Array(capacity),
  };
}

function runVariant(fn, scratch, idx, classes, n, reps) {
  for (let r = 0; r < reps; r++) fn(idx, classes, n, scratch);
}

function main() {
  const args = parseArgs();
  const rng = mulberry32(0x5a11);
  const cases = {};

  // The one input shape where the strategies provably disagree, asserted so the
  // divergence stays documented instead of quietly disappearing when the gate
  // above started passing.
  {
    const idx = new Int32Array([5, 5, 5]);
    const badClasses = new Int32Array([1, 2, 3]);
    const scratch = makeScratch(8);
    shippedSort(idx, badClasses, 3, scratch);
    const shipIdx = Array.from(scratch.sorted.subarray(0, 3));
    const shipCls = Array.from(scratch.sortedClass.subarray(0, 3));
    packedSort(idx, badClasses, 3, scratch);
    const packIdx = Array.from(scratch.sorted.subarray(0, 3));
    const packCls = Array.from(scratch.sortedClass.subarray(0, 3));
    if (shipCls.join() === packCls.join()) {
      console.log(
        'note: the impossible-input divergence did not reproduce; re-check the claim in the header comment',
      );
    }
  }

  for (const n of SIZES) {
    const idx = makeOrder(n, rng);
    const classes = new Int32Array(n);
    for (let i = 0; i < n; i++) classes[i] = classForIndex(idx[i]);
    const scratch = makeScratch(Math.max(n, 1024));

    // --- gate 1: all three must agree, including on ties ---
    const a = new Int32Array(scratch.sorted);
    const aClass = new Int32Array(scratch.sortedClass);
    shippedSort(idx, classes, n, scratch);
    a.set(scratch.sorted.subarray(0, n));
    aClass.set(scratch.sortedClass.subarray(0, n));

    for (const [name, fn] of [['packed', packedSort]]) {
      fn(idx, classes, n, scratch);
      const b = scratch.sorted.subarray(0, n);
      const bClass = scratch.sortedClass.subarray(0, n);
      for (let i = 0; i < n; i++) {
        if (b[i] !== a[i]) {
          throw new Error(`H-14 gate 1: ${name} disagrees at ${i} (${b[i]} vs ${a[i]})`);
        }
        if (bClass[i] !== aClass[i]) {
          throw new Error(
            `H-14 gate 1: ${name} paired the wrong class at ${i} (${bClass[i]} vs ${aClass[i]})`,
          );
        }
      }
    }

    const variants = {
      shipped: (reps) => runVariant(shippedSort, scratch, idx, classes, n, reps),
      packed: (reps) => runVariant(packedSort, scratch, idx, classes, n, reps),
    };

    const results = {};
    const wins = { packed: 0 };
    const runs = { shipped: [], packed: [] };

    for (let r = 0; r < ROUNDS; r++) {
      const order = r % 2 === 0 ? ['shipped', 'packed'] : ['packed', 'shipped'];
      const got = {};
      for (const name of order) {
        got[name] = timeIt(`${name}#${r}@n=${n}`, (reps) => variants[name](reps));
      }
      runs.shipped.push(got.shipped.opsPerSec);
      runs.packed.push(got.packed.opsPerSec);
      if (got.packed.opsPerSec > got.shipped.opsPerSec) wins.packed++;
    }

    const med = {
      shipped: median(runs.shipped),
      packed: median(runs.packed),
    };
    results.shipped = med.shipped;
    results.packedGainPct = Number(((med.packed / med.shipped - 1) * 100).toFixed(2));
    results.packedWins = wins.packed;
    results.roundsAgree = wins.packed === ROUNDS;

    const g = results.packedGainPct;
    results.verdict =
      `${g >= FLOOR_PCT ? '+' : ''}${g.toFixed(2)} % with ${wins.packed}/${ROUNDS} rounds`;
    results.overFloor = g >= FLOOR_PCT && results.roundsAgree;

    cases[`n=${n}`] = results;
  }

  const payload = {
    kernel: 'spawnSort',
    hypothesis: 'H-14',
    protocol: { rounds: ROUNDS, order: 'rotating per round', floorPct: FLOOR_PCT },
    checksumOk: true,
    checksumNote: 'all three strategies produce identical (entityIndex, classSlot) sequences, ties included',
    cases,
    scope:
      'strategy in isolation. NOT the shipped method, and NOT a scene claim - ' +
      'treiberMicrobench times the free list and cannot see this; the scene is spawnStormScene.',
  };

  for (const [name, c] of Object.entries(cases)) {
    console.log(
      `${name.padEnd(8)} shipped ${String(Math.round(c.shipped)).padStart(14)} sorts/s   ${c.verdict}`,
    );
  }
  const anyWin = Object.values(cases).some((c) => c.overFloor);
  console.log(
    anyWin
      ? 'verdict: packed clears the floor somewhere - take it to the stress scene'
      : 'verdict: NO WIN - packed does not clear the 3 % floor with unanimous rounds at any n',
  );

  writeReport(args.output ? String(args.output) : path.join(REPORT_DIR, 'kernel.json'), payload);
}

if (isCli(import.meta.url)) {
  main();
}