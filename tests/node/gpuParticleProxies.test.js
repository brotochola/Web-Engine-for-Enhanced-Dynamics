import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GpuParticles } from '../../src/core/gpuParticles.js';
import { Layer } from '../../src/core/layer.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { CLOCK_BYTES, Time } from '../../src/core/timeScale.js';
import { DECORATION_Y_SORT_SCALE, LAYER_KIND, PARTICLE_SORT_BIAS } from '../../src/util/configDefaults.js';
import { orderSortKey, spriteYSortKey, zSortBand } from '../../src/util/sortIndexByKey.js';
import { seededRandom } from '../../src/util/utils.js';
import { GPU_FLAG_SORTED } from '../../src/render/gpuQueueLayout.js';
import { GPU_RING } from '../../src/util/gpuParticleLayout.js';
import {
  PROXY,
  PROXY_ENTRY_WORDS,
  PROXY_KIND,
  PROXY_MAX_ENTRIES,
  ProxyCollector,
  bindProxyHalves,
  groupSortKey,
  localProxyHalf,
  proxyView,
  upperBoundByKey,
} from '../../src/render/gpuParticleProxies.js';
import { EntityChunks, assignGaps } from '../../src/render/gpuParticleChunks.js';
import { GpuParticleLayerBatch } from '../../src/render/gpuParticleBatch.js';
import { Container, Texture } from '../../src/vendor/pixi.min.js';
import { loadWorker } from '../bench/workerHarness.mjs';

// GPU particles in the y-sort painter: each emitGpu call (a group) is drawn among the entities at the place its
// sortY takes in the painter's order. These check where that place is (a binary search over the packed order),
// what the packer lists each frame, and how the entities batch is cut into chunks around the groups. The draw
// itself is checked in Chromium (tests/bench/stressScenes/gpuParticlesStressScene.js, ?sort=1).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WGSL = fs.readFileSync(path.join(root, 'src/shaders/gpuParticle.wgsl'), 'utf8');
const BUILT_INS = { decals: {}, castedShadows: {}, entities: {}, lighting: {} };
const WORLD_H = 720;
const BAND = zSortBand(WORLD_H);

function setup(layers = { smoke: { kind: LAYER_KIND.GPU_PARTICLES, maxParticles: 64 * 3, sortWithEntities: true } }) {
  Layer.reset();
  Layer.initializeFromConfig(layers, BUILT_INS);
  GpuParticles.initializeFromConfig(layers, 1);
  GpuParticles.writerSlot = 0;
  const clock = new SharedArrayBuffer(CLOCK_BYTES);
  new Float32Array(clock, 0, 1)[0] = 1;
  Time.bind(clock);
  globalThis.rng = seededRandom(11, 'gpu-proxies');
  return () => {
    GpuParticles.reset();
    Layer.reset();
    Time.unbind();
  };
}

const emit = (cfg) => ParticleEmitter.emitGpu({ layer: 'smoke', count: 4, x: 0, y: 0, lifespan: 5000, ...cfg });

/** A queue's sortKey column for entities standing on these rows (queue order), and their painter order. */
function entityKeys(rows) {
  const keys = new Float32Array(rows.length);
  for (let i = 0; i < rows.length; i++) keys[i] = orderSortKey(spriteYSortKey(rows[i], DECORATION_Y_SORT_SCALE), 0, true, BAND);
  const order = Uint32Array.from(rows.map((_, i) => i).sort((a, b) => keys[a] - keys[b]));
  return { keys, order };
}

const entry = (half, e, word) => half.ints[e * PROXY_ENTRY_WORDS + word];
const clock = new Float64Array(1);
/** Time.simNowMs as the workers pass it (Time.readSimNowInto). */
const clockNow = () => {
  Time.readSimNowInto(clock, 0);
  return clock;
};
/** proxyView's camera slots. */
const cameraOf = (x, y, zoom, rot, w, h) => Float64Array.of(x, y, zoom, rot, w, h);
/** What the root draws, in order. */
// What Pixi draws: visible and renderable children, with alpha (an idle chunk twin has none).
const drawn = (node) => node.children.filter((c) => c.visible && c.renderable && c.alpha > 0);
const entryF = (half, e, word) => half.floats[e * PROXY_ENTRY_WORDS + word];

test('upperBoundByKey: where a key goes in the packed order, after the instances it ties with', () => {
  const keys = new Float32Array([5, 1, 3, 3, 9]);
  const order = new Uint32Array([1, 2, 3, 0, 4]);
  assert.equal(upperBoundByKey(keys, order, 5, Float64Array.of(0), 0), 0);
  assert.equal(upperBoundByKey(keys, order, 5, Float64Array.of(3), 0), 3, 'after both 3s');
  assert.equal(upperBoundByKey(keys, order, 5, Float64Array.of(4), 0), 3);
  assert.equal(upperBoundByKey(keys, order, 5, Float64Array.of(9), 0), 5);
  assert.equal(upperBoundByKey(keys, order, 3, Float64Array.of(9), 0), 3, 'only the packed instances count');
  assert.equal(upperBoundByKey(new Float32Array([1, 3, 3, 5, 9]), null, 5, Float64Array.of(3), 0), 3, 'no order: instance k is row k');
});

test('a group\'s key is a CPU particle\'s on its ground row: behind what stands lower, in front of that row', () => {
  const k = groupSortKey(100, BAND);
  assert.equal(k, Math.fround(k), 'as the queue\'s Float32 column holds it');
  assert.equal(k, orderSortKey(spriteYSortKey(100, DECORATION_Y_SORT_SCALE) + PARTICLE_SORT_BIAS, 0, true, BAND));
  assert.ok(k > orderSortKey(spriteYSortKey(100, DECORATION_Y_SORT_SCALE), 0, true, BAND), 'after an entity on row 100');
  assert.ok(k < orderSortKey(spriteYSortKey(101, DECORATION_Y_SORT_SCALE), 0, true, BAND), 'before one on row 101');
  assert.ok(k < orderSortKey(spriteYSortKey(0, DECORATION_Y_SORT_SCALE), 1, true, BAND), 'zIndex 1 is in front of it');
});

test('the packer lists live groups in key order, each with the entity it is drawn before', { concurrency: false }, () => {
  const restore = setup();
  try {
    emit({ sortY: 300 });
    emit({ sortY: 100 });
    emit({ sortY: 200 });
    const collector = new ProxyCollector();
    assert.equal(collector.collect(GpuParticles.layers, clockNow(), null), 3);
    const { keys, order } = entityKeys([350, 50, 250, 150]);
    const half = localProxyHalf();
    assert.equal(collector.write(half, keys, order, 4), 3);
    assert.equal(half.header[0], 3);
    const layerId = Layer.get('smoke').id;
    assert.deepEqual([0, 1, 2].map((e) => entry(half, e, PROXY.GROUP)), [1, 2, 0], 'sortY 100, 200, 300');
    assert.deepEqual([0, 1, 2].map((e) => entry(half, e, PROXY.INDEX)), [1, 2, 3], 'after the rows above each');
    for (let e = 0; e < 3; e++) {
      assert.equal(entry(half, e, PROXY.KIND_LAYER), (PROXY_KIND.GROUP << 8) | layerId);
      assert.equal(entry(half, e, PROXY.RING), 0);
    }
    assert.equal(collector.write(half, keys, order, 2), 3);
    assert.deepEqual([0, 1, 2].map((e) => entry(half, e, PROXY.INDEX)), [1, 2, 2], 'clamped to the packed count');
  } finally {
    restore();
  }
});

test('hundreds of groups come out in key order, ties in the order they were collected', { concurrency: false }, () => {
  const restore = setup({ smoke: { kind: LAYER_KIND.GPU_PARTICLES, maxParticles: 1024 * 3, sortWithEntities: true } });
  try {
    const rows = seededRandom(3, 'proxy-sort');
    const n = 700;
    for (let g = 0; g < n; g++) emit({ count: 1, sortY: Math.floor(rows() * 40) * 10 }); // 40 rows: many ties
    // Consecutive calls on the same row share a group (E-161): the groups are the ring's count.
    const groups = Atomics.load(GpuParticles.layerOf('smoke').rings[0].header, GPU_RING.GROUPS) >>> 0;
    assert.ok(groups > 600 && groups < n, `${groups} groups`);
    const collector = new ProxyCollector();
    assert.equal(collector.collect(GpuParticles.layers, clockNow(), null), groups);
    const expected = Array.from({ length: groups }, (_, i) => i).sort((a, b) => collector.keys[a] - collector.keys[b] || a - b);
    assert.deepEqual(Array.from(collector.order.subarray(0, groups)), expected);
  } finally {
    restore();
  }
});

test('ended groups are skipped and the cursor moves past them; unborn ones are listed; the view culls', { concurrency: false }, () => {
  const restore = setup();
  try {
    emit({ lifespan: 100, sortY: 10 });
    emit({ lifespan: 5000, sortY: 20, delay: 1000 });
    emit({ lifespan: 5000, x: 900, sortY: 30 });
    Time._advanceSimNow(200);
    const collector = new ProxyCollector();
    assert.equal(collector.collect(GpuParticles.layers, clockNow(), null), 2, 'the first has ended');
    assert.equal(collector.cursors[Layer.get('smoke').id][0], 1);
    const view = proxyView(new Float64Array(4), cameraOf(-100, -100, 1, 0, 400, 300));
    assert.deepEqual(Array.from(view), [-100, -100, 300, 200]);
    assert.equal(collector.collect(GpuParticles.layers, clockNow(), view), 1, 'the one at x 900 is off screen');
    const turned = proxyView(new Float64Array(4), cameraOf(0, 0, 2, 0.5, 400, 300));
    assert.ok(turned[0] < 0 && turned[2] > 200, 'a turned camera: the box around what it sees');
  } finally {
    restore();
  }
});

test('a look layer\'s overlapping groups merge into one region, keyed by the one furthest back', { concurrency: false }, () => {
  const restore = setup({
    smoke: { kind: LAYER_KIND.GPU_PARTICLES, maxParticles: 64 * 3, sortWithEntities: true, shader: { fragment: 'look' } },
  });
  try {
    assert.equal(GpuParticles.layerOf('smoke').look, true);
    emit({ x: 0, sortY: 200 });
    emit({ x: 10, sortY: 100 });
    emit({ x: 600, sortY: 300 });
    const collector = new ProxyCollector();
    collector.collect(GpuParticles.layers, clockNow(), null);
    const { keys, order } = entityKeys([50, 150, 250, 350]);
    const half = localProxyHalf();
    assert.equal(collector.write(half, keys, order, 4), 2);
    assert.equal(entry(half, 0, PROXY.KIND_LAYER) >> 8, PROXY_KIND.REGION);
    assert.equal(entry(half, 0, PROXY.GROUP), 1, 'the head is sortY 100');
    assert.equal(entry(half, 0, PROXY.INDEX), 1);
    assert.ok(entryF(half, 0, PROXY.MIN_X_F) < 0 && entryF(half, 0, PROXY.MAX_X_F) > 10, 'the union of both');
    assert.equal(entry(half, 1, PROXY.GROUP), 2);
    assert.equal(entry(half, 1, PROXY.INDEX), 3);
  } finally {
    restore();
  }
});

test('past PROXY_MAX_ENTRIES the rest are dropped and counted', { concurrency: false }, () => {
  const restore = setup({ smoke: { kind: LAYER_KIND.GPU_PARTICLES, maxParticles: 3 * 2048, sortWithEntities: true } });
  try {
    for (let i = 0; i < PROXY_MAX_ENTRIES + 6; i++) emit({ count: 1, sortY: i % 700 });
    const collector = new ProxyCollector();
    assert.equal(collector.collect(GpuParticles.layers, clockNow(), null), PROXY_MAX_ENTRIES + 6);
    const half = bindProxyHalves(new SharedArrayBuffer(GpuParticles.proxySab.byteLength))[1];
    assert.equal(collector.write(half, null, null, 0), PROXY_MAX_ENTRIES);
    assert.equal(collector.dropped, 6);
    assert.equal(half.header[1], 6);
  } finally {
    restore();
  }
});

test('assignGaps: entries share a gap when no sprite is between them; past maxSplits the closest gaps merge', () => {
  const half = localProxyHalf();
  const indices = [0, 0, 5, 7, 20, 21, 40];
  indices.forEach((k, e) => { half.ints[e * PROXY_ENTRY_WORDS + PROXY.INDEX] = k; });
  const at = new Int32Array(8);
  assert.equal(assignGaps(half.ints, 7, 32, at, 30), 6, 'one gap per distinct index; 40 is clamped to 30');
  assert.deepEqual(Array.from(at.subarray(0, 7)), [0, 0, 5, 7, 20, 21, 30]);
  // Closest first: 21 into 20, 7 into 5, then 5 into 0.
  assert.equal(assignGaps(half.ints, 7, 3, at, 30), 3);
  assert.deepEqual(Array.from(at.subarray(0, 7)), [0, 0, 0, 0, 20, 20, 30]);
  half.ints[3 * PROXY_ENTRY_WORDS + PROXY.INDEX] = 2;
  assignGaps(half.ints, 7, 32, at, 30);
  assert.equal(at[3], 5, 'never earlier than an earlier entry');
});

/** A GPU particle batch (for real meshes and a shader) and one of its meshes standing in for the entities batch. */
function meshes() {
  const batch = new GpuParticleLayerBatch({
    info: GpuParticles.layerOf('smoke'),
    useWebGpu: true,
    shaders: { gpuParticle: WGSL },
    atlasSource: Texture.WHITE.source,
    lutSource: Texture.WHITE.source,
    animStartSource: Texture.WHITE.source,
    blendMode: 'normal',
  });
  const entities = { mesh: batch.rings[1].meshes[0] };
  entities.mesh.geometry.instanceCount = 10;
  entities.mesh.visible = true;
  return { batch, entities };
}

test('the entities batch is drawn in chunks with each entry in its gap, then back to one mesh', { concurrency: false }, () => {
  const restore = setup();
  const { batch, entities } = meshes();
  try {
    const rootNode = new Container();
    rootNode.addChild(entities.mesh);
    const chunks = new EntityChunks({ batch: entities, root: rootNode });
    const half = localProxyHalf();
    [0, 4, 4].forEach((k, e) => { half.ints[e * PROXY_ENTRY_WORDS + PROXY.INDEX] = k; });
    const marks = [new Container(), new Container(), new Container()];
    const draw = (w, out, n) => {
      out[n] = marks[w / PROXY_ENTRY_WORDS];
      return n + 1;
    };
    chunks.apply(half, 3, 10, draw);
    const kids = drawn(rootNode);
    assert.equal(kids.length, 5);
    assert.equal(entities.mesh.renderable, false, 'the chunks draw the batch\'s instances');
    assert.equal(kids[0], marks[0], 'entry 0 is behind every entity');
    assert.equal(kids[1].geometry.weedFirstInstance, 0);
    assert.equal(kids[1].geometry.instanceCount, 4);
    assert.equal(kids[2], marks[1]);
    assert.equal(kids[3], marks[2], 'two entries in one gap keep their order');
    assert.equal(kids[4].geometry.weedFirstInstance, 4);
    assert.equal(kids[4].geometry.instanceCount, 6);
    const base = entities.mesh.geometry.attributes;
    assert.equal(kids[1].geometry.attributes.aMove.buffer, base.aMove.buffer, 'a chunk draws the batch\'s own buffers');
    assert.equal(kids[1].shader, entities.mesh.shader);
    const first = kids[1];
    const children = rootNode.children.length;
    chunks.apply(half, 3, 10, draw);
    assert.equal(drawn(rootNode)[1], first, 'chunk meshes are reused');
    assert.equal(rootNode.children.length, children, 'and stay children: no child added or removed');
    chunks.clear();
    assert.deepEqual(drawn(rootNode), [entities.mesh]);
    chunks.apply(half, 3, 10, draw);
    assert.deepEqual(drawn(rootNode).map((c) => c.label || ''), kids.map((c) => c.label || ''), 'the same order again');
    chunks.destroy();
  } finally {
    batch.destroy();
    restore();
  }
});

test('the batch drawing from its two geometries in turn leaves the stage as it was: no instruction rebuild', { concurrency: false }, () => {
  const restore = setup();
  const { batch, entities } = meshes();
  try {
    const rootNode = new Container({ isRenderGroup: true });
    rootNode.addChild(entities.mesh);
    // A batch uploads into each of its ring geometries in turn; two real geometries over one buffer stand in.
    const geometries = [batch.rings[1].meshes[0].geometry, batch.rings[1].meshes[1].geometry];
    const chunks = new EntityChunks({ batch: entities, root: rootNode });
    const half = localProxyHalf();
    [0, 4, 4].forEach((k, e) => { half.ints[e * PROXY_ENTRY_WORDS + PROXY.INDEX] = k; });
    const marks = [new Container(), new Container(), new Container()];
    const draw = (w, out, n) => {
      out[n] = marks[w / PROXY_ENTRY_WORDS];
      return n + 1;
    };
    const frame = (f) => {
      entities.mesh.geometry = geometries[f & 1];
      chunks.apply(half, 3, 10, draw);
    };
    frame(0);
    frame(1); // the second geometry's chunks join their twins
    const children = rootNode.children.slice();
    for (let f = 2; f < 6; f++) {
      rootNode.renderGroup.structureDidChange = false;
      frame(f);
      assert.equal(rootNode.renderGroup.structureDidChange, false, `frame ${f}: nothing hidden, shown or moved`);
      assert.deepEqual(rootNode.children, children, 'the same children in the same order');
      const kids = drawn(rootNode);
      assert.deepEqual(kids.map((c) => c.label || ''), ['', `entities-chunk-0-${f & 1}`, '', '', `entities-chunk-1-${f & 1}`],
        'one mesh per chunk is drawn: the one over the geometry the batch uploaded');
      assert.deepEqual([kids[1].geometry.weedFirstInstance, kids[1].geometry.instanceCount], [0, 4]);
      assert.deepEqual([kids[4].geometry.weedFirstInstance, kids[4].geometry.instanceCount], [4, 6]);
      const twin = rootNode.children[rootNode.children.indexOf(kids[1]) + ((f & 1) === 0 ? 1 : -1)];
      assert.equal(twin.label, `entities-chunk-0-${(f & 1) ^ 1}`, 'its twin is next to it, slot 0 first');
      assert.equal(twin.alpha, 0);
    }
    entities.mesh.geometry = batch.rings[0].meshes[0].geometry;
    assert.throws(() => chunks.apply(half, 3, 10, draw), /third geometry/);
    entities.mesh.geometry = geometries[0];
    chunks.destroy();
  } finally {
    batch.destroy();
    restore();
  }
});

test('a group draws its slots, two ranges across the ring end, without the records written over', { concurrency: false }, () => {
  const restore = setup();
  const { batch } = meshes();
  try {
    emit({ count: 50 }); // slots 0..49 of a 64-slot ring
    emit({ count: 30 }); // slots 50..79: wraps
    batch.sorted = true;
    batch.update(clockNow());
    assert.equal(batch.rings[0].meshes[0].visible || batch.rings[0].meshes[1].visible, false, 'a sorted layer draws no rings');
    batch.beginGroups();
    const out = [];
    batch.alpha = 0.5;
    assert.equal(batch.groupMeshes(0, 1, out, 0), 2);
    assert.deepEqual([out[0].geometry.weedFirstInstance, out[0].geometry.instanceCount], [50, 14]);
    assert.deepEqual([out[1].geometry.weedFirstInstance, out[1].geometry.instanceCount], [0, 16]);
    assert.equal(out[0].alpha, 0.5);
    batch.alpha = 1;
    assert.equal(batch.groupMeshes(0, 0, out, 0), 1);
    assert.deepEqual([out[0].geometry.weedFirstInstance, out[0].geometry.instanceCount], [16, 34], 'its first 16 are gone');
    batch.beginGroups();
    batch.groupMeshes(0, 1, out, 0);
    assert.equal(out[0], batch.rings[0].pool[0], 'the pool is reused frame to frame');
  } finally {
    batch.destroy();
    restore();
  }
});

test('pre-render lists the groups into the half of the queue buffer it packs, only for a y-sorted frame', { concurrency: false }, async () => {
  const restore = setup();
  try {
    const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
    pre._proxyHalves = bindProxyHalves(GpuParticles.proxySab);
    pre._proxyCollector = new ProxyCollector();
    pre._zBand = BAND;
    pre.cameraData = null;
    pre._queueBuf = 1;
    pre._entitySortY = true;
    emit({ sortY: 200 });
    const { keys, order } = entityKeys([150, 250]);
    pre._writeProxies({ sortKey: keys }, { sprite: 2, flags: GPU_FLAG_SORTED, indices: order });
    const [a, b] = pre._proxyHalves;
    assert.equal(b.header[0], 1, 'the buffer being written');
    assert.equal(a.header[0], 0);
    assert.equal(entry(b, 0, PROXY.INDEX), 1);
    pre._writeProxies({ sortKey: keys }, { sprite: 2, flags: 0, indices: order });
    assert.equal(b.header[0], 0, 'an unsorted pack lists nothing');
    pre._writeProxies({ sortKey: keys }, { sprite: 0, flags: 0, indices: null });
    assert.equal(b.header[0], 1, 'no entities packed: the groups still draw');
    pre._entitySortY = false;
    pre._writeProxies({ sortKey: keys }, { sprite: 2, flags: GPU_FLAG_SORTED, indices: order });
    assert.equal(b.header[0], 0, 'without the y-sort the layers draw at their zIndex');
  } finally {
    restore();
  }
});
