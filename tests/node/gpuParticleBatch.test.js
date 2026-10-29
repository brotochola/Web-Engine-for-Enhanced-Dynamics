import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GpuParticles, GPU_GROUP_JOIN_MS } from '../../src/core/gpuParticles.js';
import { Layer } from '../../src/core/layer.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { CLOCK_BYTES, Time } from '../../src/core/timeScale.js';
import { LAYER_KIND } from '../../src/util/configDefaults.js';
import { seededRandom } from '../../src/util/utils.js';
import { GPU_RECORD_BYTES } from '../../src/util/gpuParticleLayout.js';
import {
  GPU_PARTICLE_ATTRIBUTES,
  GpuParticleLayerBatch,
  gpuParticleTextureVertex,
  gpuRecordTextureSize,
  gpuRecordTexturesFit,
  packAnimStartLookup,
} from '../../src/render/gpuParticleBatch.js';
import { installInstanceRangeDraw } from '../../src/render/instanceRangeDraw.js';
import { Texture, TextureSource } from '../../src/vendor/pixi.min.js';

// The renderer's side of a GPU particle layer, without a GPU: what it uploads each frame (only what was published,
// copied out of the shared memory first) and which slice of each ring it draws (the live window, two ranges when it
// wraps the ring end). The draw itself is checked in Chromium (tests/bench/stressScenes/gpuParticlesStressScene.js).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WGSL = fs.readFileSync(path.join(root, 'src/shaders/gpuParticle.wgsl'), 'utf8');

function setup(maxParticles = 64 * 3, batchOpts = {}) {
  const layers = { smoke: { kind: LAYER_KIND.GPU_PARTICLES, maxParticles } };
  Layer.reset();
  Layer.initializeFromConfig(layers, { decals: {}, castedShadows: {}, entities: {}, lighting: {} });
  GpuParticles.initializeFromConfig(layers, 1);
  GpuParticles.writerSlot = 0;
  const clock = new SharedArrayBuffer(CLOCK_BYTES);
  new Float32Array(clock, 0, 1)[0] = 1;
  Time.bind(clock);
  globalThis.rng = seededRandom(7, 'gpu-batch');
  const batch = new GpuParticleLayerBatch({
    info: GpuParticles.layerOf('smoke'),
    useWebGpu: true,
    shaders: { gpuParticle: WGSL },
    atlasSource: Texture.WHITE.source,
    lutSource: Texture.WHITE.source,
    animStartSource: Texture.WHITE.source,
    blendMode: 'normal',
    ...batchOpts,
  });
  return {
    batch,
    draw: batch.rings[0],
    restore() {
      batch.destroy();
      GpuParticles.reset();
      Layer.reset();
      Time.unbind();
    },
  };
}

const clock = new Float64Array(1);
/** Time.simNowMs as the Pixi worker passes it (Time.readSimNowInto). */
const clockNow = () => {
  Time.readSimNowInto(clock, 0);
  return clock;
};

const emit = (n, lifespan, extra = {}) => ParticleEmitter.emitGpu({ layer: 'smoke', count: n, x: 0, y: 0, lifespan, ...extra });

test('a frame uploads only the records published since the last one, out of a private copy', { concurrency: false }, () => {
  const { batch, draw, restore } = setup();
  try {
    assert.notEqual(draw.mirror.buffer, draw.ring.records.buffer, 'uploads come from the ring\'s own array');
    emit(10, 1000);
    batch.update(clockNow());
    assert.equal(draw.buffer._updateOffset, 0);
    assert.equal(draw.buffer._updateSize, 10 * GPU_RECORD_BYTES);
    assert.deepEqual(Array.from(draw.mirror.subarray(0, 4)), Array.from(draw.ring.records.subarray(0, 4)));
    emit(5, 1000);
    batch.update(clockNow());
    assert.equal(draw.buffer._updateOffset, 10 * GPU_RECORD_BYTES, 'the next range starts where the last ended');
    assert.equal(draw.buffer._updateSize, 5 * GPU_RECORD_BYTES);
    const id = draw.buffer._updateID;
    batch.update(clockNow());
    assert.equal(draw.buffer._updateID, id, 'nothing new, nothing uploaded');
  } finally {
    restore();
  }
});

/**
 * Pixi's WebGL buffer upload (GlBufferSystem.updateBuffer in src/vendor/pixi.min.js): the whole array the first
 * time, then only the buffer's last pending range, and nothing when that range already went up.
 */
function glBufferModel() {
  const gl = { data: null, updateID: -1 };
  const upload = (buffer) => {
    if (gl.data === null) {
      gl.data = Float32Array.from(buffer.data);
      gl.updateID = buffer._updateID;
      return;
    }
    if (buffer._updateID === gl.updateID) return;
    gl.updateID = buffer._updateID;
    const off = buffer._updateOffset / 4;
    const len = (buffer._updateSize || buffer.data.byteLength) / 4;
    gl.data.set(buffer.data.subarray(off, off + len), off);
  };
  return { gl, upload };
}

test('every published range reaches the GPU, in a frame that draws nothing of the ring too', { concurrency: false }, () => {
  const { gl, upload } = glBufferModel();
  const { batch, draw, restore } = setup(64 * 3, { flush: upload });
  try {
    emit(8, 1000);
    batch.update(clockNow());
    upload(draw.buffer); // drawn
    emit(10, 1000);
    batch.update(clockNow()); // nothing of this ring drawn: a hidden layer, or groups all off-screen
    emit(5, 1000);
    batch.update(clockNow());
    upload(draw.buffer); // drawn
    const floats = (23 * GPU_RECORD_BYTES) / 4;
    assert.deepEqual(Array.from(gl.data.subarray(0, floats)), Array.from(draw.ring.records.subarray(0, floats)));
  } finally {
    restore();
  }
});

test('a range across the ring end goes up as its two pieces, not the whole ring', { concurrency: false }, () => {
  const { gl, upload } = glBufferModel();
  const ranges = []; // [first slot, slots] of each range that went up after the first upload
  const flush = (buffer) => {
    if (gl.data !== null && buffer._updateID !== gl.updateID) {
      ranges.push([buffer._updateOffset / GPU_RECORD_BYTES, buffer._updateSize / GPU_RECORD_BYTES]);
    }
    upload(buffer);
  };
  const { batch, draw, restore } = setup(64 * 3, { flush });
  try {
    emit(50, 5000);
    batch.update(clockNow());
    emit(30, 5000); // slots 50..79 of a 64-slot ring: wraps
    batch.update(clockNow());
    assert.deepEqual(ranges, [[50, 14], [0, 16]], 'the head up to the ring end, then the rest from slot 0');
    const floats = (64 * GPU_RECORD_BYTES) / 4;
    assert.deepEqual(Array.from(gl.data.subarray(0, floats)), Array.from(draw.ring.records.subarray(0, floats)));
  } finally {
    restore();
  }
});

test('the live window starts at the oldest group still alive, and wraps the ring end as two draws', { concurrency: false }, () => {
  const { batch, draw, restore } = setup();
  try {
    const [a, b] = draw.meshes;
    batch.update(clockNow());
    assert.equal(a.visible || b.visible, false, 'nothing published, nothing drawn');
    emit(40, 100); // dies at 100 ms
    emit(10, 5000);
    batch.update(clockNow());
    assert.equal(a.geometry.weedFirstInstance, 0);
    assert.equal(a.geometry.instanceCount, 50);
    Time._advanceSimNow(200);
    batch.update(clockNow());
    assert.equal(a.geometry.weedFirstInstance, 40, 'the dead group is skipped');
    assert.equal(a.geometry.instanceCount, 10);
    assert.equal(b.visible, false);
    emit(30, 5000); // slots 50..79 of a 64-slot ring: wraps
    batch.update(clockNow());
    assert.equal(a.geometry.weedFirstInstance, 40);
    assert.equal(a.geometry.instanceCount, 24, 'up to the ring end');
    assert.equal(b.visible, true);
    assert.equal(b.geometry.weedFirstInstance, 0);
    assert.equal(b.geometry.instanceCount, 16, 'the rest from slot 0');
    assert.equal(draw.buffer._updateSize, 64 * GPU_RECORD_BYTES, 'without a flush, a range across the ring end uploads the whole array');
    Time._advanceSimNow(6000);
    batch.update(clockNow());
    assert.equal(a.visible || b.visible, false, 'all ended');
  } finally {
    restore();
  }
});

test('each ring\'s clock is now on its own epoch; delays keep a group alive until its last death', { concurrency: false }, () => {
  const { batch, draw, restore } = setup();
  try {
    Time._advanceSimNow(1000);
    emit(4, 100, { delay: 500 });
    Time._advanceSimNow(250);
    batch.update(clockNow());
    assert.equal(draw.shader.resources.uniforms.uniforms.uGpuParticles[0], 250, 'ms since the ring\'s epoch');
    assert.equal(draw.meshes[0].visible, true);
    Time._advanceSimNow(400); // 650 ms: the last particle dies at 600
    batch.update(clockNow());
    assert.equal(draw.meshes[0].visible, false);
  } finally {
    restore();
  }
});

test('the anim-start lookup maps animation indices to atlas ids; 0 is the white circle', () => {
  const { data, width, height } = packAnimStartLookup([0, 5, 9, 12], 3);
  assert.equal(width, 64);
  assert.equal(height, 1);
  assert.deepEqual([data[0], data[4], data[8], data[12]], [3, 5, 9, 12]);
  assert.equal(data[16], -1, 'past the table: no texture');
});

test('instance ranges: WebGPU sets firstInstance for the draw and puts it back', () => {
  const calls = [];
  const renderer = { encoder: { draw: (o) => calls.push({ ...o }) } };
  assert.equal(installInstanceRangeDraw(renderer, true), 'firstInstance');
  assert.equal(installInstanceRangeDraw(renderer, true), 'firstInstance', 'installed once');
  const options = { geometry: { weedFirstInstance: 40, instanceCount: 10 } };
  renderer.encoder.draw(options);
  renderer.encoder.draw({ geometry: { instanceCount: 3 } });
  assert.equal(calls[0].firstInstance, 40);
  assert.equal(options.firstInstance, undefined, 'the caller\'s options are left as they were');
  assert.equal(calls[1].firstInstance, undefined);
});

test('instance ranges: WebGL without the extension points the instance attributes further, then back', () => {
  const log = [];
  const gl = {
    POINTS: 0, LINES: 1, LINE_STRIP: 3, TRIANGLES: 4, TRIANGLE_STRIP: 5, FLOAT: 0x1406, UNSIGNED_SHORT: 0x1403,
    UNSIGNED_INT: 0x1405, ARRAY_BUFFER: 0x8892,
    getExtension: () => null,
    bindBuffer: (t, b) => log.push(['bind', b]),
    vertexAttribPointer: (loc, size, type, norm, stride, offset) => log.push(['ptr', loc, size, stride, offset]),
    drawElementsInstanced: (mode, n, type, offset, count) => log.push(['draw', mode, n, count]),
  };
  const buffer = {};
  const geometry = {
    weedFirstInstance: 3,
    instanceCount: 2,
    topology: 'triangle-list',
    indexBuffer: { data: new Uint32Array(6) },
    attributes: {
      aQuad: { buffer: {}, format: 'float32x2', stride: 8, offset: 0 },
      aMove: { buffer, format: 'float32x4', stride: 112, offset: 0, instance: true },
      aHeight: { buffer, format: 'float32x4', stride: 112, offset: 16, instance: true },
    },
  };
  const geometrySystem = {
    _activeGeometry: null,
    bind(g) { this._activeGeometry = g; },
    draw() { log.push(['pixi-draw']); },
  };
  const renderer = { gl, geometry: geometrySystem, buffer: { getGlBuffer: () => ({ buffer: 'glbuf' }) } };
  assert.equal(installInstanceRangeDraw(renderer, false), 'repoint');
  geometrySystem.bind(geometry, { _attributeData: { aQuad: { location: 0 }, aMove: { location: 1 }, aHeight: { location: 2 } } });
  geometrySystem.draw('triangle-list', 6, 0, 2);
  assert.deepEqual(log.filter((l) => l[0] === 'ptr'), [
    ['ptr', 1, 4, 112, 3 * 112],
    ['ptr', 2, 4, 112, 16 + 3 * 112],
    ['ptr', 1, 4, 112, 0],
    ['ptr', 2, 4, 112, 16],
  ]);
  assert.deepEqual(log.find((l) => l[0] === 'draw'), ['draw', gl.TRIANGLES, 6, 2]);
  geometry.weedFirstInstance = 0;
  geometrySystem.draw('triangle-list', 6, 0, 2);
  assert.equal(log[log.length - 1][0], 'pixi-draw', 'no range: Pixi\'s own draw');
});

// GlProgram.from probes shader precision on a canvas; Node has none, and a context of null is enough.
globalThis.document ??= { createElement: () => ({ getContext: () => null }) };
const VERT = fs.readFileSync(path.join(root, 'src/shaders/gpuParticle.vert.glsl'), 'utf8');
const FRAG = fs.readFileSync(path.join(root, 'src/shaders/gpuParticle.frag.glsl'), 'utf8');

test('the texture vertex shader reads the seven record vec4 from texels of record uFirstInstance + gl_InstanceID', () => {
  const tex = gpuParticleTextureVertex(VERT);
  for (const name of GPU_PARTICLE_ATTRIBUTES) {
    assert.ok(!new RegExp(`^in vec4 ${name};`, 'm').test(tex), `${name} is no longer an attribute`);
    assert.ok(new RegExp(`^vec4 ${name};`, 'm').test(tex), `${name} is a global`);
  }
  assert.match(tex, /uniform highp usampler2D uRecords;/);
  assert.match(tex, /uniform int uFirstInstance;/);
  assert.equal((tex.match(/uintBitsToFloat\(texelFetch\(uRecords, weedTexel \+ ivec2\(\d, 0\), 0\)\)/g) || []).length, 7);
  assert.match(tex, /^in vec2 aQuad;/m, 'the corner stays an attribute');
  assert.equal(tex.split('void main() {').length - 1, 1);
  assert.throws(() => gpuParticleTextureVertex(VERT.replace('in vec4 aSpin;', 'in vec4 aSpinX;')), /aSpin/);
});

test('WebGL draws from a record texture: the rows each frame publishes go up, both pieces across the ring end', { concurrency: false }, () => {
  const made = [];
  const uploads = [];
  const recordTexture = {
    maxSize: 16384,
    make(bits, width, height, label) {
      made.push({ bits, width, height, label });
      return new TextureSource({ width, height, label });
    },
    upload(source, bits, width, height, y0, rows) {
      uploads.push([y0, rows]);
    },
  };
  // 2048 records a ring: four rows of 512.
  const { batch, draw, restore } = setup(2048 * 3, {
    useWebGpu: false,
    shaders: { gpuParticleVert: VERT, gpuParticleFrag: FRAG },
    recordTexture,
  });
  try {
    assert.equal(draw.buffer, null, 'no instance buffer');
    assert.equal(made.length, batch.rings.length);
    assert.equal(made[0].bits, draw.mirrorBits, 'the texture holds the ring\'s own copy');
    assert.deepEqual([made[0].width, made[0].height], [7 * 512, 4]);
    assert.deepEqual(gpuRecordTextureSize(64), { width: 7 * 64, height: 1 }, 'a small ring is one row');
    const [a, b] = draw.meshes;
    assert.equal(a.shader.resources.uniforms, draw.shader.resources.uniforms, 'the meshes share the ring\'s clock');
    assert.notEqual(a.shader.resources.firstInstance, b.shader.resources.firstInstance, 'each mesh has its own first record');

    emit(600, 5000);
    batch.update(clockNow());
    assert.deepEqual(uploads.splice(0), [[0, 2]], 'records 0..599: rows 0 and 1');
    // Calls a frame apart: each opens its own group (calls closer than GPU_GROUP_JOIN_MS share one, E-161).
    Time._advanceSimNow(GPU_GROUP_JOIN_MS + 1);
    emit(1000, 5000);
    batch.update(clockNow());
    assert.deepEqual(uploads.splice(0), [[1, 3]], 'records 600..1599: rows 1 to 3');
    batch.update(clockNow());
    assert.deepEqual(uploads, [], 'nothing published, nothing sent');

    Time._advanceSimNow(GPU_GROUP_JOIN_MS + 1);
    emit(600, 5000); // 1600..2199 of a 2048-record ring: wraps
    batch.update(clockNow());
    assert.deepEqual(uploads.splice(0), [[3, 1], [0, 1]], 'the head on row 3, the tail on row 0');
    assert.equal(a.visible && b.visible, true, 'the live window wraps: two draws');
    // The tail wrote over records 0..151, so the first group is gone: the window starts at the second, record 600.
    assert.equal(a.shader.resources.firstInstance.uniforms.uFirstInstance, 600, 'from the oldest group still whole');
    assert.equal(a.geometry.instanceCount, 2048 - 600);
    assert.equal(b.shader.resources.firstInstance.uniforms.uFirstInstance, 0);
    assert.equal(b.geometry.instanceCount, 152);
    assert.equal(a.geometry.weedFirstInstance, 0, 'the range is the uniform\'s, not the geometry\'s');
  } finally {
    restore();
  }
});

test('a layer whose rings need a texture past the GPU limit draws from instance attributes, with a warning', { concurrency: false }, () => {
  assert.equal(gpuRecordTexturesFit([{ capacity: 2048 }], 4096), true);
  assert.equal(gpuRecordTexturesFit([{ capacity: 2048 }], 2048), false, '3584 texels wide');
  assert.equal(gpuRecordTexturesFit([{ capacity: 1 << 22 }], 4096), false, '8192 rows');
  assert.equal(gpuRecordTexturesFit([{ capacity: 64 }], undefined), false, 'no limit known, no texture');
  let made = 0;
  const warnings = [];
  const warn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  let restoreLayer = null;
  try {
    const { draw, restore } = setup(2048 * 3, {
      useWebGpu: false,
      shaders: { gpuParticleVert: VERT, gpuParticleFrag: FRAG },
      recordTexture: {
        maxSize: 2048,
        make() {
          made++;
          return new TextureSource({ width: 1, height: 1 });
        },
        upload() {},
      },
    });
    restoreLayer = restore;
    assert.equal(made, 0, 'no texture made');
    assert.notEqual(draw.buffer, null, 'the instance buffer, as before');
    assert.equal(draw.records, null);
    assert.ok(warnings.some((m) => /draws from instance attributes/.test(m) && /2048 texels/.test(m)), warnings.join(' | '));
  } finally {
    console.warn = warn;
    if (restoreLayer) restoreLayer();
  }
});
