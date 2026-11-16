import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker, quietly } from '../bench/workerHarness.mjs';
import { buildPoolScene } from '../helpers/poolScene.mjs';
import { GameObject } from '../../src/core/gameObject.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Transform } from '../../src/components/transform.js';

// E-349: an interval type's entry in decimatedTypes gained six bucket fields on its first frame (_rebuildTickBuckets
// and _tickIntervalBucket wrote them), so the literal had two maps and the bucket loop compiled for both. The literal
// declares them now: the first frames rebuild the buckets and tick the same entities, and the entry keeps its fields.

const N = 64;
const INTERVAL = 4;

class Sleeper extends GameObject {
  static components = [SpriteRenderer];
  static tickInterval = INTERVAL;
  steps = 0;
  tick() {
    this.steps++;
  }
}

test('an interval type\'s entry keeps its fields through its first frames, and every entity ticks once per interval', { concurrency: false }, async () => {
  const savedNextTick = GameObject.nextTick;
  GameObject.nextTick = new Int32Array(N);
  try {
    const scene = buildPoolScene({ entities: N });
    const lw = await loadWorker('logicWorker.js', 'logicWorker');
    lw.config = scene.config;
    lw.globalEntityCount = N;
    lw.gameObjects = new Array(N).fill(null);
    globalThis.self.Sleeper = Sleeper;
    Sleeper._activeList = new Uint32Array(1 + N); // the active lists' buffer is bound elsewhere
    lw.registeredClasses = [{ name: 'Sleeper', poolSize: N, startIndex: 0, endIndex: N - 1, entityType: 0 }];
    await quietly(() => lw.createGameObjectInstances());
    assert.equal(lw.decimatedTypes.length, 1, 'the type is an interval type');
    const info = lw.decimatedTypes[0];
    const keys = Object.keys(info);
    for (const field of ['_buckets', '_bucketCounts', '_bucketInterval', '_bucketCap', '_bucketStampCount', '_bucketStampVer']) {
      assert.ok(keys.includes(field), `${field} declared in the literal`);
    }

    // Every slot live, in the type's active list (count first, then the ids).
    const active = new Uint8Array(N).fill(1);
    const list = info.activeList;
    list[0] = N;
    for (let i = 0; i < N; i++) list[1 + i] = i;
    const none = new Float32Array(N);
    let ticked = 0;
    for (let frame = 0; frame < INTERVAL; frame++) {
      ticked += lw._tickIntervalBucket(
        info, list, N, INTERVAL, frame, 1, 16.6, frame * 16.6, active, lw.gameObjects, none, none, none, 1, 0,
      );
    }
    assert.equal(ticked, N, 'one interval ticks every entity once');
    assert.ok(lw.gameObjects.every((o) => o instanceof Sleeper && o.steps === 1));
    assert.deepEqual(Object.keys(info), keys, 'no field added on the first frames');
    assert.equal(info._bucketInterval, INTERVAL);
    assert.equal(info._bucketStampCount, N);
  } finally {
    GameObject.nextTick = savedNextTick;
    Transform.active.fill(0);
  }
});
