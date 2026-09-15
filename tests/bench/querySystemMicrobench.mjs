#!/usr/bin/env node
// L1: QuerySystem publish + skip-if-unchanged + bitset AND scan (Wave F).
//
//   node tests/bench/querySystemMicrobench.mjs
//   node tests/bench/querySystemMicrobench.mjs --output tests/results/query-l1.json

import assert from 'node:assert/strict';

import {
  QuerySystem,
  calculateQueryResultsSABSize,
} from '../../src/core/querySystem.js';
import { GameObject } from '../../src/core/gameObject.js';
import { parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const args = parseArgs();
const OUTPUT = args.output ? String(args.output) : null;
const ACTIVE = Number(args.active ?? 2048);

class CompA {}
CompA.componentId = 0;
class CompB {}
CompB.componentId = 1;

class TypeA {}
class TypeB {}

function makeActiveList(ids) {
  const view = new Uint16Array(1 + ids.length);
  view[0] = ids.length;
  view.set(ids, 1);
  return view;
}

const typeAIds = [];
const typeBIds = [];
for (let i = 0; i < ACTIVE; i++) {
  if ((i & 1) === 0) typeAIds.push(i);
  else typeBIds.push(i);
}
TypeA._activeList = makeActiveList(typeAIds);
TypeB._activeList = makeActiveList(typeBIds);

const querySystem = new QuerySystem();
querySystem.entityMetadata = [
  {
    entityType: 0,
    className: 'TypeA',
    entityClass: TypeA,
    componentMask: 3n,
    startIndex: 0,
    endIndex: ACTIVE,
    poolSize: ACTIVE,
  },
  {
    entityType: 1,
    className: 'TypeB',
    entityClass: TypeB,
    componentMask: 1n,
    startIndex: ACTIVE,
    endIndex: ACTIVE * 2,
    poolSize: ACTIVE,
  },
];
querySystem.precomputedQueries = [
  { name: 'CompA+CompB', queryMask: 3n, typeMask: 1n, resultOffset: 0 },
  { name: 'CompA', queryMask: 1n, typeMask: 3n, resultOffset: 0 },
];
querySystem.queryEntityCapacity = ACTIVE * 2;
querySystem.queryResultsSAB = new SharedArrayBuffer(
  calculateQueryResultsSABSize(querySystem.precomputedQueries.length, querySystem.queryEntityCapacity)
);
querySystem._initializeQueryResultViews();
GameObject.activeEntitiesData = new Uint16Array([0]);

querySystem.publishPrecomputedActiveQueries(1);
const publishedCount = Atomics.load(querySystem.queryResultViews[0].header, 1);
assert.equal(publishedCount, typeAIds.length);

querySystem.publishPrecomputedActiveQueries(2);
assert.equal(Atomics.load(querySystem.queryResultViews[0].header, 1), typeAIds.length);

function bitsetFromIds(ids, words) {
  words.fill(0);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    words[id >>> 5] |= 1 << (id & 31);
  }
}

const wordsA = new Uint32Array((ACTIVE + 31) >> 5);
const wordsB = new Uint32Array((ACTIVE + 31) >> 5);
bitsetFromIds(typeAIds, wordsA);
bitsetFromIds(typeAIds.concat(typeBIds), wordsB);

function andBitsToBuffer(a, b, out) {
  let n = 0;
  for (let w = 0; w < a.length; w++) {
    let bits = a[w] & b[w];
    const base = w << 5;
    while (bits) {
      const idx = 31 - Math.clz32(bits & -bits);
      out[n++] = base + idx;
      bits &= bits - 1;
    }
  }
  return n;
}

const bitOut = new Uint16Array(ACTIVE);
assert.equal(andBitsToBuffer(wordsA, wordsB, bitOut), typeAIds.length);

let lastCount = publishedCount;
function publishOrSkip(frame, force) {
  const count = TypeA._activeList[0];
  if (!force && count === lastCount) return 0;
  querySystem.publishPrecomputedActiveQueries(frame);
  lastCount = count;
  return 1;
}

assert.equal(publishOrSkip(3, false), 0);
assert.equal(publishOrSkip(4, true), 1);

const cases = {
  publish: timeIt('publish_precomputed', (iters) => {
    for (let i = 0; i < iters; i++) querySystem.publishPrecomputedActiveQueries(i);
  }, { iterations: Number(args.publishIters ?? 800) }),
  skipPublish: timeIt('skip_unchanged', (iters) => {
    lastCount = TypeA._activeList[0];
    for (let i = 0; i < iters; i++) publishOrSkip(i, false);
  }, { iterations: Number(args.skipIters ?? 8000) }),
  bitsetAnd: timeIt('bitset_and_scan', (iters) => {
    for (let i = 0; i < iters; i++) andBitsToBuffer(wordsA, wordsB, bitOut);
  }, { iterations: Number(args.bitIters ?? 4000) }),
};

const report = {
  feature: 'query-system-publish',
  active: ACTIVE,
  publishedCount,
  cases,
};
if (OUTPUT) writeReport(OUTPUT, report);
void CompA;
void CompB;
