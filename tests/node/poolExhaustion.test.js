import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { Joint } from '../../src/core/joint.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import {
  bindPoolExhaustion,
  droppedJoints,
  poolExhaustionBytes,
  unbindPoolExhaustion,
} from '../../src/util/poolExhaustion.js';

// A spawn into a full pool warned on every call from every thread, so a game
// that kept spawning flooded the console. One warning per type per scene now,
// from whichever thread finds the pool empty first; the rest are counted.

function captureWarnings(fn) {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

class Crate extends GameObject {}

function bindEmptyCratePool() {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(4)), 4);
  Crate.entityType = 1;
  Crate.startIndex = 0;
  Crate.endIndex = 2;
  Crate.poolSize = 2;
  Crate.instances = [];
  Crate.freeList = new Uint16Array(new SharedArrayBuffer(4));
  Crate.freeListTop = new Int32Array(new SharedArrayBuffer(8));
  resetFreeList(Crate.freeListTop, Crate.freeList, 0);
}

test('spawning into a full pool warns once and counts every failed spawn', () => {
  bindPoolExhaustion(new SharedArrayBuffer(poolExhaustionBytes(3)));
  bindEmptyCratePool();
  try {
    const lines = captureWarnings(() => {
      for (let k = 0; k < 500; k++) assert.equal(GameObject.spawn(Crate, { x: k }), null);
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /the Crate pool is full \(2 slots\)/);
    assert.equal(GameObject.getPoolStats(Crate).dropped, 500);
  } finally {
    unbindPoolExhaustion();
  }
});

test('a full joint pool warns once too', () => {
  bindPoolExhaustion(new SharedArrayBuffer(poolExhaustionBytes(1)));
  try {
    const realAcquire = Joint.acquireIndex;
    Joint.acquireIndex = () => -1;
    try {
      const lines = captureWarnings(() => {
        for (let k = 0; k < 100; k++) assert.equal(Joint._acquireOrWarn(), -1);
      });
      assert.equal(lines.length, 1);
      assert.match(lines[0], /joint pool is full/);
      assert.equal(droppedJoints(), 100);
    } finally {
      Joint.acquireIndex = realAcquire;
    }
  } finally {
    unbindPoolExhaustion();
  }
});

test('three threads hitting the same full pool print one warning between them', async () => {
  const sab = new SharedArrayBuffer(poolExhaustionBytes(4));
  const url = new URL('../../src/util/poolExhaustion.js', import.meta.url).href;
  const code = `
    const { workerData, parentPort } = require('node:worker_threads');
    import(workerData.url).then((m) => {
      m.bindPoolExhaustion(workerData.sab);
      let warnings = 0;
      console.warn = () => { warnings++; };
      const Bullet = { name: 'Bullet', entityType: 2, poolSize: 64 };
      for (let k = 0; k < 1000; k++) m.reportPoolExhausted(Bullet);
      parentPort.postMessage(warnings);
    });
  `;
  const counts = await Promise.all(
    [0, 1, 2].map(
      () =>
        new Promise((resolve, reject) => {
          const w = new Worker(code, { eval: true, workerData: { sab, url } });
          w.once('message', resolve);
          w.once('error', reject);
        })
    )
  );
  assert.equal(counts.reduce((a, b) => a + b, 0), 1);
  bindPoolExhaustion(sab);
  try {
    assert.equal(GameObject.getPoolStats({ entityType: 2, startIndex: 0, poolSize: 64, endIndex: 64 }).dropped, 3000);
  } finally {
    unbindPoolExhaustion();
  }
});
