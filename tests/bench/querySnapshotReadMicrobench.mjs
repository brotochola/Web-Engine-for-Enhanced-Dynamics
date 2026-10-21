/**
 * Kernel for B-02: what the consistency check in `readPublishedQuerySnapshot`
 * (src/core/querySystem.js) costs.
 *
 * This exists because B-02 put a bounded retry loop on a function the CPU trace
 * shows on the main thread's hot path. A correctness fix on a hot path is still
 * a change that has to be paid for, and the protocol says so.
 *
 * Gate 2, both sides:
 *   - the shipped variant is the real module, imported;
 *   - the pre-fix variant is an exact textual diff over the shipped method
 *     source, compiled in memory and written OUTSIDE the working tree.
 * Both are driven through the identical public entry,
 * `createWorkerQueryFunctions(...).queryActiveEntities`, so the only difference
 * between the timed code is the one function under test.
 *
 * If the anchor text no longer matches, this throws rather than quietly
 * measuring something else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  calculateQueryResultBufferSize,
  createWorkerQueryFunctions,
  getQuerySnapshotBytes,
  getQuerySnapshotElements,
  QUERY_SNAPSHOT_COUNT,
} from '../../src/core/querySystem.js';
import { checksumInts, isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { median } from './benchMath.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.resolve(HERE, '../results/b02-query-snapshot');
const SRC = path.resolve(HERE, '../../src/core/querySystem.js');

const CAPACITY = 4096;
const HEADER_INTS = 4;
const HEADER_BYTES = HEADER_INTS * 4;
const SEED = 0x5eed1;
const CHECKSUM_N = 128;

/** Exact anchor. If the engine moves, this throws instead of measuring a ghost. */
const ANCHOR = 'function readPublishedQuerySnapshot(snapshotView) {';

/** The pre-fix body, verbatim from before B-02. */
const PRE_FIX_BODY = `
  const snapshotIndex = Atomics.load(snapshotView.header, 0);
  const count = Atomics.load(snapshotView.header, 1);

  if (
    snapshotView.cachedSnapshot === snapshotIndex &&
    snapshotView.cachedCount === count &&
    snapshotView.subarray !== null
  ) {
    return snapshotView.subarray;
  }

  const snapshot = snapshotView.snapshots[snapshotIndex] || snapshotView.snapshots[0];
  const subarray = count === 0 ? EMPTY_QUERY_RESULT : snapshot.subarray(1, 1 + count);
  snapshotView.cachedSnapshot = snapshotIndex;
  snapshotView.cachedCount = count;
  snapshotView.subarray = subarray;
  return subarray;
}`;

/**
 * Identical workload for both variants: one precomputed query covering the
 * whole type, a full consistent snapshot published, so the reader returns on
 * its first attempt - which is the common case the fix has to not slow down.
 */
function makeQueryData() {
  return {
    queryEntityCapacity: CAPACITY,
    metadata: [
      {
        entityType: 0,
        className: 'Probe',
        componentMask: '1',
        startIndex: 0,
        endIndex: CAPACITY,
        poolSize: CAPACITY,
      },
    ],
    precomputedQueries: [
      { name: 'probe', components: [], queryMask: '1', typeMask: '1', resultOffset: 0 },
    ],
  };
}

function makeHarness(rng) {
  const sab = new SharedArrayBuffer(calculateQueryResultBufferSize(CAPACITY));
  const snapshotBytes = getQuerySnapshotBytes(CAPACITY);
  const elements = getQuerySnapshotElements(CAPACITY);

  const header = new Int32Array(sab, 0, HEADER_INTS);
  const snapshots = [];
  for (let i = 0; i < QUERY_SNAPSHOT_COUNT; i++) {
    snapshots.push(new Uint16Array(sab, HEADER_BYTES + i * snapshotBytes, elements));
  }

  const fns = createWorkerQueryFunctions(
    makeQueryData(),
    { queryResultsSAB: sab },
    new Uint16Array(CAPACITY + 1),
  );
  const classes = [{ componentId: 0, name: 'Probe' }];

  // Publish a full, consistent set into snapshot 0.
  const snap = snapshots[0];
  const ids = new Uint16Array(CAPACITY);
  for (let i = 0; i < CAPACITY; i++) ids[i] = (rng() * CAPACITY) | 0;
  snap[0] = CAPACITY;
  for (let i = 0; i < CAPACITY; i++) snap[1 + i] = ids[i];
  Atomics.store(header, 1, CAPACITY);
  Atomics.store(header, 2, 1);
  Atomics.store(header, 0, 0);

  return { fns, classes, expectedChecksum: checksumInts(ids, CHECKSUM_N) };
}

/** Locate the function's opening and closing braces, brace-balanced. */
function functionBounds(source) {
  const at = source.indexOf(ANCHOR);
  if (at < 0) throw new Error(`querySnapshotRead: anchor not found in ${SRC}: "${ANCHOR}"`);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return { open, close: i };
    }
  }
  throw new Error('querySnapshotRead: could not find the end of the function');
}

/**
 * Build the pre-fix variant in memory. Relative imports are rewritten to
 * absolute file URLs so the copy can live outside `src/` and the working tree
 * is never touched.
 */
function buildPreFixModule() {
  const source = fs.readFileSync(SRC, 'utf8');
  const { open, close } = functionBounds(source);

  // open is the index OF the '{', so keep it: slice up to and including it.
  let patched = source.slice(0, open + 1) + PRE_FIX_BODY + source.slice(close + 1);
  patched = patched.replace(
    /from '(\.\.?\/[^']+)'/g,
    (_m, spec) => `from '${pathToFileURL(path.resolve(path.dirname(SRC), spec)).href}'`,
  );

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const file = path.join(REPORT_DIR, 'querySystem.prefixQuerySnapshotRead.mjs');
  fs.writeFileSync(file, patched, 'utf8');
  return file;
}

/** Drive one variant's public entry, identical shape for both. */
function benchVariant(label, fns, classes) {
  return timeIt(label, (n) => {
    let acc = 0;
    for (let k = 0; k < n; k++) acc += fns.queryActiveEntities(classes).length;
    return acc;
  });
}

async function main() {
  const args = parseArgs();
  const rng = mulberry32(SEED);

  const shippedH = makeHarness(rng);
  const first = shippedH.fns.queryActiveEntities(shippedH.classes);
  if (first.length !== CAPACITY) {
    throw new Error(`querySnapshotRead: expected ${CAPACITY} ids, got ${first.length}`);
  }
  const shippedChecksum = checksumInts(first, CHECKSUM_N);
  if (shippedChecksum !== shippedH.expectedChecksum) {
    throw new Error(
      `querySnapshotRead: shipped checksum ${shippedChecksum} != ${shippedH.expectedChecksum}`,
    );
  }

  const preFixFile = buildPreFixModule();
  const preMod = await import(pathToFileURL(preFixFile).href);

  // The pre-fix copy needs its own SAB and its own view state, built the same
  // way as the shipped harness so the two are driven by identical work.
  const preSAB = new SharedArrayBuffer(calculateQueryResultBufferSize(CAPACITY));
  const preHeader = new Int32Array(preSAB, 0, HEADER_INTS);
  const preSnap0 = new Uint16Array(preSAB, HEADER_BYTES, getQuerySnapshotElements(CAPACITY));
  const preRng = mulberry32(SEED);
  const preIds = new Uint16Array(CAPACITY);
  for (let i = 0; i < CAPACITY; i++) preIds[i] = (preRng() * CAPACITY) | 0;
  preSnap0[0] = CAPACITY;
  for (let i = 0; i < CAPACITY; i++) preSnap0[1 + i] = preIds[i];
  Atomics.store(preHeader, 1, CAPACITY);
  Atomics.store(preHeader, 2, 1);
  Atomics.store(preHeader, 0, 0);

  const preFns = preMod.createWorkerQueryFunctions(
    makeQueryData(),
    { queryResultsSAB: preSAB },
    new Uint16Array(CAPACITY + 1),
  );
  const preClasses = [{ componentId: 0, name: 'Probe' }];

  const preFirstRead = preFns.queryActiveEntities(preClasses);
  const preChecksum = checksumInts(preFirstRead, CHECKSUM_N);
  if (preChecksum !== shippedChecksum) {
    throw new Error(
      `querySnapshotRead: variants disagree - shipped ${shippedChecksum} vs pre-fix ${preChecksum}; ` +
        'the timed code is not comparable',
    );
  }

  // Alternating rounds, per the rule in docs/HOW_WE_MEASURE.md and the
  // correction DEVLOG (30 Sept) records: one process per side cannot resolve 3 %.
  // DEVLOG measured 1875 to 2128 ops/s across five processes of *identical*
  // code, so a single-shot A/B here would be reporting noise as a result - and
  // the first version of this kernel did exactly that, claiming +13.8 % for a
  // change that only adds work.
  //
  // The order is counterbalanced per round: drift inside a pair always lands on
  // whichever side ran second, which DEVLOG also records as a real correction.
  const ROUNDS = 5;
  const shippedRuns = [];
  const prefixRuns = [];
  const pairedWins = [];

  for (let round = 0; round < ROUNDS; round++) {
    const shippedFirst = round % 2 === 0;
    const runShipped = () => benchVariant(`shipped#${round}`, shippedH.fns, shippedH.classes);
    const runPrefix = () => benchVariant(`pre-fix#${round}`, preFns, preClasses);

    const [sFirst, pSecond] = shippedFirst
      ? [runShipped(), runPrefix()]
      : [null, null];
    let s, p;
    if (shippedFirst) {
      s = sFirst;
      p = pSecond;
    } else {
      p = runPrefix();
      s = runShipped();
    }

    shippedRuns.push(s.opsPerSec);
    prefixRuns.push(p.opsPerSec);
    pairedWins.push(s.opsPerSec > p.opsPerSec);
    process.stdout.write(
      `  round ${round + 1}/${ROUNDS} (${shippedFirst ? 'shipped,pre-fix' : 'pre-fix,shipped'}): ` +
        `${Math.round(s.opsPerSec).toLocaleString()} vs ${Math.round(p.opsPerSec).toLocaleString()}\n`,
    );
  }

  const shippedMedian = median(shippedRuns);
  const prefixMedian = median(prefixRuns);
  const deltaPct = ((shippedMedian / prefixMedian) - 1) * 100;
  const shippedWins = pairedWins.filter(Boolean).length;
  const prefixWins = ROUNDS - shippedWins;

  // The question is "do the rounds agree on a direction", not "did shipped win".
  // A cost measurement legitimately comes out negative - the fix adds a load and
  // a compare - so demanding that shipped win is the wrong bar. DEVLOG's 23/25
  // rule is for claiming a *win*; the equivalent for a cost is that the rounds
  // point the same way.
  let direction = 'tie';
  if (shippedWins === ROUNDS) direction = 'shipped';
  else if (prefixWins === ROUNDS) direction = 'prefix';
  const roundsAgree = direction !== 'tie';
  const majority = Math.max(shippedWins, prefixWins);

  const FLOOR_PCT = 3;
  let verdict;
  if (!roundsAgree) {
    verdict =
      `NO CLAIM - ${shippedWins}/${ROUNDS} rounds favour shipped, ${prefixWins}/${ROUNDS} favour ` +
      'pre-fix. The rounds do not agree, so the measurement is inside the noise band and ' +
      'resolves nothing either way. The single-shot version of this kernel claimed +13.8 % ' +
      'here; that was the error, not a result.';
  } else if (direction === 'shipped' && deltaPct > FLOOR_PCT) {
    verdict =
      `WIN - shipped is +${deltaPct.toFixed(2)} % and all ${ROUNDS} rounds agree. Implausible for ` +
      'a change that only adds work; investigate as a harness artifact before believing it.';
  } else if (direction === 'prefix' && deltaPct < -FLOOR_PCT) {
    verdict =
      `REGRESSION, rounds unanimous - the consistency check costs ${(-deltaPct).toFixed(2)} % on the ` +
      `query read path, all ${ROUNDS} rounds agree. Over the ${FLOOR_PCT} % floor.`;
  } else if (majority >= ROUNDS - 1 && Math.abs(deltaPct) > FLOOR_PCT) {
    verdict =
      `NO CLAIM, but the direction is consistent - ${majority}/${ROUNDS} rounds say ${direction}, ` +
      `median delta ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)} %. Over the ${FLOOR_PCT} % floor ` +
      'by a hair, but the strict bar is not met. Report as a suspected cost, not a regression.';
  } else {
    verdict =
      `FREE - ${deltaPct.toFixed(2)} % is inside the ${FLOOR_PCT} % floor. The consistency check costs ` +
      'nothing measurable in the consistent case.';
  }

  const payload = {
    kernel: 'querySnapshotRead',
    finding: 'B-02',
    seed: SEED,
    capacity: CAPACITY,
    checksum: shippedChecksum,
    checksumOk: true,
    variantsAgree: shippedChecksum === preChecksum,
    protocol: {
      rounds: ROUNDS,
      order: 'counterbalanced per round',
      floorPct: FLOOR_PCT,
      why: 'one process per side cannot resolve 3 %; DEVLOG measured 1875-2128 ops/s on identical code',
    },
    cases: {
      'queries.shipped': { opsPerSec: shippedMedian, runs: shippedRuns },
      'queries.preFix': { opsPerSec: prefixMedian, runs: prefixRuns },
    },
    deltaPct: Number(deltaPct.toFixed(3)),
    shippedWins,
    preFixWins: prefixWins,
    direction,
    roundsAgree,
    verdict,
  };

  console.log(`querySnapshotRead  shipped median ${Math.round(shippedMedian).toLocaleString()} reads/s`);
  console.log(`                  pre-fix median ${Math.round(prefixMedian).toLocaleString()} reads/s`);
  console.log(
    `                  delta ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)} %  ` +
      `(shipped ${shippedWins}/${ROUNDS}, pre-fix ${prefixWins}/${ROUNDS})  checksum ${shippedChecksum}`,
  );
  console.log(`                  verdict: ${verdict}`);

  writeReport(args.output ? String(args.output) : path.join(REPORT_DIR, 'kernel.json'), payload);
}

if (isCli(import.meta.url)) {
  main();
}