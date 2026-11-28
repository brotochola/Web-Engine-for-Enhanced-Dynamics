import test from 'node:test';
import assert from 'node:assert/strict';
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
  GPU_STAGE_MIN_RECORDS,
  GpuParticleLayerBatch,
  gpuParticleTextureVertex,
  gpuRecordTextureSize,
  gpuRecordTexturesFit,
  packAnimStartLookup,
  texRecordRangeGl,
} from '../../src/render/gpuParticleBatch.js';
import { installInstanceRangeDraw } from '../../src/render/instanceRangeDraw.js';
import { RingStaging } from '../../src/render/webgpu/ringStaging.js';
import { Texture, TextureSource } from '../../src/vendor/pixi.min.js';
import { GlBufferSystem } from '../../node_modules/pixi.js/lib/rendering/renderers/gl/buffer/GlBufferSystem.mjs';
import { GpuBufferSystem } from '../../node_modules/pixi.js/lib/rendering/renderers/gpu/buffer/GpuBufferSystem.mjs';
import { readEngineShader } from './engineShaderSources.mjs';

// The renderer's side of a GPU particle layer, without a GPU: what it uploads each frame (only what was published,
// copied out of the shared memory first) and which slice of each ring it draws (the live window, two ranges when it
// wraps the ring end). The draw itself is checked in Chromium (tests/bench/stressScenes/gpuParticlesStressScene.js).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WGSL = readEngineShader('gpuParticle.wgsl');

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

test('a frame uploads only the records published since the last one, straight from the shared ring', { concurrency: false }, () => {
  const { batch, draw, restore } = setup();
  try {
    assert.equal(draw.buffer.data, draw.ring.records, 'the buffer\'s data is the ring in the shared memory (E-488)');
    assert.ok(draw.buffer.data.buffer instanceof SharedArrayBuffer);
    emit(10, 1000);
    batch.update(clockNow());
    assert.equal(draw.buffer._updateOffset, 0);
    assert.equal(draw.buffer._updateSize, 10 * GPU_RECORD_BYTES);
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
 * Pixi's WebGL buffer system (8.23's GlBufferSystem, the bundle's, unpatched) over a fake context that keeps what the GPU
 * holds: the whole array when a draw first binds the buffer, then each Buffer.update at the call (#12316). `ranges`: the
 * [first slot, slots] of each update sent after the first upload.
 */
function glBuffers() {
  const gpu = { data: null, ranges: [] };
  const gl = {
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    createBuffer: () => ({}),
    bindBuffer() {},
    deleteBuffer() {},
    bufferData(target, data) {
      gpu.data = Float32Array.from(data);
    },
    bufferSubData(target, offset, data, start, length) {
      gpu.data.set(data.subarray(start, start + length), offset / 4);
      gpu.ranges.push([offset / GPU_RECORD_BYTES, (length * 4) / GPU_RECORD_BYTES]);
    },
  };
  const system = new GlBufferSystem({ uid: 1, gl, gc: { now: 0, addResourceHash() {} }, context: { webGLVersion: 2 } });
  system.contextChange();
  return { gpu, draw: (buffer) => system.updateBuffer(buffer), destroy: () => system.destroy() };
}

test('every published range reaches the GPU at once, in a frame that draws nothing of the ring too', { concurrency: false }, () => {
  const gl = glBuffers();
  const { batch, draw, restore } = setup(64 * 3);
  try {
    emit(8, 1000);
    batch.update(clockNow());
    gl.draw(draw.buffer); // drawn: the buffer is made on the GPU, the whole array
    emit(10, 1000);
    batch.update(clockNow()); // nothing of this ring drawn: a hidden layer, or groups all off-screen
    emit(5, 1000);
    batch.update(clockNow());
    const floats = (23 * GPU_RECORD_BYTES) / 4;
    assert.deepEqual(Array.from(gl.gpu.data.subarray(0, floats)), Array.from(draw.ring.records.subarray(0, floats)),
      'before the next draw');
    assert.deepEqual(gl.gpu.ranges, [[8, 10], [18, 5]]);
    gl.draw(draw.buffer);
    assert.equal(gl.gpu.ranges.length, 2, 'the draw sends nothing again');
  } finally {
    gl.destroy();
    restore();
  }
});

test('a range across the ring end goes up as its two pieces, not the whole ring', { concurrency: false }, () => {
  const gl = glBuffers();
  const { batch, draw, restore } = setup(64 * 3);
  try {
    emit(50, 5000);
    batch.update(clockNow());
    gl.draw(draw.buffer);
    emit(30, 5000); // slots 50..79 of a 64-slot ring: wraps
    batch.update(clockNow());
    assert.deepEqual(gl.gpu.ranges, [[50, 14], [0, 16]], 'the head up to the ring end, then the rest from slot 0');
    const floats = (64 * GPU_RECORD_BYTES) / 4;
    assert.deepEqual(Array.from(gl.gpu.data.subarray(0, floats)), Array.from(draw.ring.records.subarray(0, floats)));
  } finally {
    gl.destroy();
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
    assert.deepEqual([draw.buffer._updateOffset, draw.buffer._updateSize], [0, 16 * GPU_RECORD_BYTES],
      'across the ring end the last update is the tail, from slot 0');
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

test('N-189: a WebGL range gives the program its first instance for the draw, then 0 (base instance or not)', () => {
  for (const withExt of [false, true]) {
    const log = [];
    const gl = {
      TRIANGLES: 4, FLOAT: 0x1406, UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405, ARRAY_BUFFER: 0x8892,
      getExtension: () => (withExt ? { drawElementsInstancedBaseVertexBaseInstanceWEBGL: (...a) => log.push(['draw', a[4], a[6]]) } : null),
      bindBuffer: () => {},
      vertexAttribPointer: () => {},
      drawElementsInstanced: (mode, n, type, offset, count) => log.push(['draw', count]),
      uniform1i: (location, value) => log.push(['uniform', location, value]),
    };
    const painterProgram = { _attributeData: {} };
    const plainProgram = { _attributeData: {} };
    const programData = new Map([
      [painterProgram, { uniformData: { uWeedFirstInstance: { location: 'firstLoc', value: 0 } } }],
      [plainProgram, { uniformData: {} }],
    ]);
    const geometrySystem = {
      _activeGeometry: null,
      bind(g) { this._activeGeometry = g; },
      draw() { log.push(['pixi-draw']); },
    };
    const renderer = {
      gl,
      geometry: geometrySystem,
      buffer: { getGlBuffer: () => ({ buffer: 'glbuf' }) },
      shader: { _getProgramData: (program) => programData.get(program) },
    };
    installInstanceRangeDraw(renderer, false);
    const geometry = { weedFirstInstance: 130, instanceCount: 5, topology: 'triangle-list', indexBuffer: { data: new Uint32Array(6) }, attributes: {} };
    geometrySystem.bind(geometry, painterProgram);
    geometrySystem.draw('triangle-list', 6, 0, 5);
    const drawn = withExt ? ['draw', 5, 130] : ['draw', 5];
    assert.deepEqual(log, [['uniform', 'firstLoc', 130], drawn, ['uniform', 'firstLoc', 0]], withExt ? 'base instance' : 'repoint');
    log.length = 0;
    geometrySystem.bind(geometry, plainProgram);
    geometrySystem.draw('triangle-list', 6, 0, 5);
    assert.deepEqual(log, [drawn], 'a program without the uniform: the draw alone');
    log.length = 0;
    geometry.weedFirstInstance = 0;
    geometrySystem.bind(geometry, painterProgram);
    geometrySystem.draw('triangle-list', 6, 0, 5);
    assert.deepEqual(log, [['pixi-draw']], 'no range: Pixi\'s own draw, the uniform left at 0');
  }
});

// GlProgram.from probes shader precision on a canvas; Node has none, and a context of null is enough.
globalThis.document ??= { createElement: () => ({ getContext: () => null }) };
const VERT = readEngineShader('gpuParticle.vert.glsl');
const FRAG = readEngineShader('gpuParticle.frag.glsl');

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

test('WebGL draws from a record texture: the records each frame publishes go up, both pieces across the ring end', { concurrency: false }, () => {
  const made = [];
  const uploads = [];
  const recordTexture = {
    maxSize: 16384,
    make(bits, width, height, label) {
      made.push({ bits, width, height, label });
      return new TextureSource({ width, height, label });
    },
    uploadRecords(source, bits, from, n) {
      sentFrom.add(bits);
      uploads.push([from, n]);
    },
  };
  const sentFrom = new Set();
  // 2048 records a ring: four rows of 512.
  const { batch, draw, restore } = setup(2048 * 3, {
    useWebGpu: false,
    shaders: { gpuParticleVert: VERT, gpuParticleFrag: FRAG },
    recordTexture,
  });
  try {
    assert.equal(draw.buffer, null, 'no instance buffer');
    assert.equal(made.length, batch.rings.length);
    assert.equal(made[0].bits, draw.ring.recordBits, 'the texture holds the ring in the shared memory (E-488)');
    assert.deepEqual([made[0].width, made[0].height], [7 * 512, 4]);
    assert.deepEqual(gpuRecordTextureSize(64), { width: 7 * 64, height: 1 }, 'a small ring is one row');
    const [a, b] = draw.meshes;
    assert.equal(a.shader.resources.uniforms, draw.shader.resources.uniforms, 'the meshes share the ring\'s clock');
    assert.notEqual(a.shader.resources.firstInstance, b.shader.resources.firstInstance, 'each mesh has its own first record');

    emit(600, 5000);
    batch.update(clockNow());
    assert.deepEqual(uploads.splice(0), [[0, 600]], 'records 0..599');
    // Calls a frame apart: each opens its own group (calls closer than GPU_GROUP_JOIN_MS share one, E-161).
    Time._advanceSimNow(GPU_GROUP_JOIN_MS + 1);
    emit(1000, 5000);
    batch.update(clockNow());
    assert.deepEqual(uploads.splice(0), [[600, 1000]], 'records 600..1599');
    batch.update(clockNow());
    assert.deepEqual(uploads, [], 'nothing published, nothing sent');

    Time._advanceSimNow(GPU_GROUP_JOIN_MS + 1);
    emit(600, 5000); // 1600..2199 of a 2048-record ring: wraps
    batch.update(clockNow());
    assert.deepEqual(uploads.splice(0), [[1600, 448], [0, 152]], 'the head to the ring end, the tail from slot 0');
    assert.deepEqual([...sentFrom], [draw.ring.recordBits], 'every piece from the ring\'s words in the shared memory');
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

/**
 * A record texture of `capacity` records as texels, and a context whose texSubImage2D writes into it as WebGL does
 * (rows packed at the upload's width, UNPACK_ROW_LENGTH 0). Every texel starts as `fill`.
 */
function recordTextureGl(capacity, fill) {
  const { width, height } = gpuRecordTextureSize(capacity);
  const texels = new Uint32Array(width * height * 4).fill(fill);
  const calls = [];
  const gl = {
    TEXTURE_2D: 0x0de1,
    RGBA_INTEGER: 0x8d99,
    UNSIGNED_INT: 0x1405,
    texSubImage2D(target, level, x, y, w, h, format, type, src, srcOffset) {
      assert.ok(x >= 0 && y >= 0 && x + w <= width && y + h <= height, `[${x}, ${y}, ${w}, ${h}] inside ${width} x ${height}`);
      calls.push([x, y, w, h]);
      for (let row = 0; row < h; row++) {
        texels.set(src.subarray(srcOffset + row * w * 4, srcOffset + (row + 1) * w * 4), ((y + row) * width + x) * 4);
      }
    },
  };
  return { gl, texels, calls, width };
}

test('E-488: a range of a ring goes to its record texture as its own texels and no other', () => {
  const FILL = 0xdeadbeef;
  for (const [capacity, ranges] of [
    [2048, [[0, 600], [600, 1000], [1600, 448], [5, 3], [512, 1024], [0, 2048], [700, 30], [511, 2], [1024, 512]]],
    [64, [[0, 64], [10, 20], [63, 1]]],
  ]) {
    const bits = new Uint32Array(new SharedArrayBuffer(capacity * 28 * 4));
    for (let w = 0; w < bits.length; w++) bits[w] = w + 1;
    for (const [from, n] of ranges) {
      const { gl, texels, calls, width } = recordTextureGl(capacity, FILL);
      texRecordRangeGl(gl, bits, from, n);
      assert.ok(calls.length <= 3, 'a partial first row, the whole rows, a partial last row');
      for (let s = 0; s < capacity; s++) {
        const at = ((s >> 9) * width + (s & 511) * 7) * 4;
        const inside = s >= from && s < from + n;
        for (let k = 0; k < 28; k++) {
          const want = inside ? bits[s * 28 + k] : FILL;
          if (texels[at + k] !== want) assert.fail(`ring ${capacity}, [${from}, ${from + n}): record ${s} word ${k} is ${texels[at + k]}, not ${want}`);
        }
      }
    }
  }
});

/**
 * A WebGPU device that keeps what each buffer holds: writeBuffer and a submit's copies land at the call, a mapping is a
 * copy of the buffer's bytes made at getMappedRange and written back at unmap, and mapAsync resolves only at catchUp()
 * (the GPU caught up).
 */
function gpuDevice() {
  const pending = [];
  const device = {
    submits: 0,
    ringWrites: [],
    createBuffer({ size, usage, mappedAtCreation, label }) {
      const b = {
        size,
        usage,
        label,
        bytes: new Uint8Array(size),
        state: mappedAtCreation ? 'mapped' : 'unmapped',
        range: null,
        getMappedRange() {
          assert.equal(b.state, 'mapped');
          b.range = new ArrayBuffer(size);
          new Uint8Array(b.range).set(b.bytes);
          return b.range;
        },
        unmap() {
          if (b.range) b.bytes.set(new Uint8Array(b.range));
          b.range = null;
          b.state = 'unmapped';
        },
        mapAsync() {
          assert.equal(b.state, 'unmapped', 'mapped again only once unmapped');
          b.state = 'pending';
          return new Promise((resolve) => {
            pending.push(() => {
              if (b.state !== 'pending') return;
              b.state = 'mapped';
              resolve();
            });
          });
        },
        destroy() {
          b.state = 'destroyed';
        },
      };
      return b;
    },
    createCommandEncoder() {
      const copies = [];
      return {
        copyBufferToBuffer: (src, srcOffset, dst, dstOffset, size) => copies.push([src, srcOffset, dst, dstOffset, size]),
        finish: () => ({ copies }),
      };
    },
    queue: {
      writeBuffer(dst, offset, data, dataOffset, size) {
        dst.bytes.set(new Uint8Array(data, dataOffset, size), offset);
        if (/-records$/.test(dst.label)) device.ringWrites.push([offset / GPU_RECORD_BYTES, size / GPU_RECORD_BYTES]);
      },
      submit(list) {
        device.submits++;
        for (const cb of list) {
          for (const [src, srcOffset, dst, dstOffset, size] of cb.copies) {
            assert.equal(src.state, 'unmapped', 'a staging buffer is unmapped when its copies run');
            assert.ok(srcOffset % 4 === 0 && dstOffset % 4 === 0 && size % 4 === 0);
            dst.bytes.set(src.bytes.subarray(srcOffset, srcOffset + size), dstOffset);
          }
        }
      },
    },
    async catchUp() {
      while (pending.length) pending.shift()();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  return device;
}

test('E-488: WebGPU stages large ranges through mapped buffers, small ones by Buffer.update; the GPU holds the ring', { concurrency: false }, async () => {
  const device = gpuDevice();
  const system = new GpuBufferSystem({ uid: 1, gc: { now: 0, addResourceHash() {} } });
  system.contextChange({ device });
  const { batch, draw, restore } = setup(8192 * 3, {
    ringUploads: { device, gpuBufferOf: (buffer) => system.getGPUBuffer(buffer) },
  });
  try {
    const staging = batch.staging;
    assert.ok(staging instanceof RingStaging);
    assert.equal(draw.ring.capacity, 8192);
    const gpu = system.getGPUBuffer(draw.buffer); // made now, from the empty ring
    const records = draw.ring.records;
    const ringBytes = new Uint8Array(records.buffer, records.byteOffset, records.byteLength);
    const recordOnGpu = (s) => Array.from(gpu.bytes.subarray(s * GPU_RECORD_BYTES, (s + 1) * GPU_RECORD_BYTES));
    const recordInRing = (s) => Array.from(ringBytes.subarray(s * GPU_RECORD_BYTES, (s + 1) * GPU_RECORD_BYTES));
    /** Records the writer has not published, as they are mid-call: they must not go up. */
    const inFlight = (from, n) => draw.ring.recordBits.fill(0x7fc0beef, from * 28, (from + n) * 28);
    const sameUpTo = (published, label) => {
      for (let s = 0; s < Math.min(published, 8192); s++) {
        assert.deepEqual(recordOnGpu(s), recordInRing(s), `${label}: record ${s}`);
      }
    };

    emit(3000, 60000);
    inFlight(3000, 100);
    batch.update(clockNow());
    assert.deepEqual([staging.stagedRanges, device.ringWrites.length, device.submits], [1, 0, 1], 'staged, one submit');
    sameUpTo(3000, 'frame 1');
    assert.ok(recordOnGpu(3001).every((b) => b === 0), 'the in-flight records past the range stay off the GPU');

    Time._advanceSimNow(GPU_GROUP_JOIN_MS + 1);
    emit(3000, 60000); // 3000..5999: the first buffer is still mapping; a second is made
    batch.update(clockNow());
    assert.deepEqual([staging.stagedRanges, staging.pool.length], [2, 2]);
    sameUpTo(6000, 'frame 2');

    Time._advanceSimNow(GPU_GROUP_JOIN_MS + 1);
    emit(GPU_STAGE_MIN_RECORDS - 1, 60000); // small: Buffer.update, at the call
    batch.update(clockNow());
    assert.deepEqual(device.ringWrites, [[6000, GPU_STAGE_MIN_RECORDS - 1]]);
    assert.equal(device.submits, 2, 'nothing staged, nothing submitted');
    const published = 6000 + GPU_STAGE_MIN_RECORDS - 1;
    sameUpTo(published, 'frame 3');

    Time._advanceSimNow(GPU_GROUP_JOIN_MS + 1);
    emit(3000, 60000); // 7023..10022, across the ring end: both pieces staged, in a third buffer
    batch.update(clockNow());
    assert.deepEqual([staging.stagedRanges, staging.pool.length, device.submits], [4, 3, 3], 'one submit a frame');
    Time._advanceSimNow(GPU_GROUP_JOIN_MS + 1);
    emit(1500, 60000); // the pool is full and every buffer still mapping: Buffer.update
    batch.update(clockNow());
    assert.deepEqual([staging.stagedRanges, staging.declinedRanges, staging.pool.length], [4, 1, 3]);
    assert.deepEqual(device.ringWrites.slice(1), [[(published + 3000) & 8191, 1500]]);

    await device.catchUp(); // the buffers mapped again
    Time._advanceSimNow(GPU_GROUP_JOIN_MS + 1);
    emit(2000, 60000);
    batch.update(clockNow());
    assert.equal(staging.stagedRanges, 5, 'a buffer mapped again takes the next frame');
    for (let s = 0; s < 8192; s++) assert.deepEqual(recordOnGpu(s), recordInRing(s), `after the wrap: record ${s}`);
  } finally {
    restore();
    system.destroy();
  }
});

test('E-488: a staging buffer is made for the frames it serves, and remade when too small', () => {
  const device = gpuDevice();
  const target = device.createBuffer({ size: 1 << 22, usage: 0, label: 'ring-records' });
  const staging = new RingStaging(device, () => target, 'test');
  const ring = new Uint32Array(new SharedArrayBuffer((1 << 15) * 28 * 4));
  const blocks = [];
  for (let k = 0; k < (1 << 15) / 256; k++) blocks.push(ring.subarray(k * 256 * 28, (k + 1) * 256 * 28));
  const block = 256 * 28 * 4;
  assert.equal(staging.stage(blocks, 0, 2048, null), true);
  assert.equal(staging.pool[0].bytes, 1 << 18, 'the smallest buffer: 9 blocks');
  assert.equal(staging.stage(blocks, 2048, 1024, null), false, 'no room left: the caller writes it');
  staging.flush();
  assert.equal(staging.want, 12 * block, 'what the frame asked for, staged or not');
  assert.equal(staging.stage(blocks, 4096, 1024, null), true, 'a new buffer, made at the size the last frame asked for');
  assert.equal(staging.pool[1].bytes, 1 << 19);
  staging.flush();
  staging.destroy();
  assert.equal(staging.pool.length, 0);
});
