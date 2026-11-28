// E-500: with faces (DX-FACEDEPTH) the batch's opaque pass is two programs over the same instances: its own program keeps
// the instances whose frame has heights (they write their pixels' depth) and sends the others off screen, and its
// vertex-depth twin (vdepthMesh, drawn right before it) keeps those others. Each walks every instance. Where no frame of
// the atlas has heights (the maps table's MAPS_HEIGHTS: packMapsTable's `heights`), the first walk draws nothing, so the
// batch's own program is the vertex-depth one and the twin is not drawn: one walk over the instances. Checked on real
// batches (both backends, the plain, indexed and by-row programs): which instances each opaque draw that runs keeps, as
// its vertex stage decides it (the cull in its source, evaluated for a frame with heights and one without), so that every
// instance is drawn by exactly one of them, and the walks a frame makes.
import test from 'node:test';
import assert from 'node:assert/strict';

import { TextureSource } from '../../src/vendor/pixi.min.js';
import { InstancedSpriteBatch } from '../../src/render/instancedSpriteBatch.js';
import { MAPS_HEIGHTS, MAPS_TWIN, packMapsTable } from '../../src/render/mapsTable.js';
import { readEngineShader, spriteGlslShaders } from './engineShaderSources.mjs';

// GlProgram.from probes shader precision on a canvas; Node has none, and a context of null is enough.
globalThis.document ??= { createElement: () => ({ getContext: () => null }) };

const GLSL_FLAT_CULL = 'if (!twinHeights(vMapsWin)) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);';
const GLSL_HEIGHTS_CULL = 'if (twinHeights(vMapsWin)) {\n    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);';
const WGSL_FLAT_CULL = 'if (!twinHeights(out.vMapsWin)) { out.position = vec4<f32>(2.0, 2.0, 2.0, 1.0); }';
const WGSL_HEIGHTS_CULL = 'if (twinHeights(out.vMapsWin)) {\n    out.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);';

/** A program's vertex source on either backend. */
function vertexOf(shader) {
  if (shader.glProgram) return shader.glProgram.vertex;
  return shader.gpuProgram.vertex.source;
}

/**
 * Whether the program's vertex stage keeps an instance whose frame has heights (`heights`), or one without: the cull its
 * source carries (pixelDepth.js cullGlsl and its WGSL), the instance sent off screen when it holds.
 */
function keeps(shader, heights) {
  const v = vertexOf(shader);
  const flat = v.includes(GLSL_FLAT_CULL) || v.includes(WGSL_FLAT_CULL);
  const tall = v.includes(GLSL_HEIGHTS_CULL) || v.includes(WGSL_HEIGHTS_CULL);
  assert.ok(!(flat && tall), 'one cull a program');
  if (flat) return heights;
  if (tall) return !heights;
  return true;
}

/** Whether the program's pixels write their own depth (the frames with heights), or keep the vertex's (early depth). */
function writesPixelDepth(shader) {
  if (shader.glProgram) return shader.glProgram.fragment.includes('gl_FragDepth');
  return /fn mainFrag\(in: VertexOut\) -> WeedDepthOut/.test(shader.gpuProgram.fragment.source);
}

function makeBatch({ useWebGpu, indexed, heightFrames }) {
  const shaders = useWebGpu ? { sprite: readEngineShader('instancedSprite.wgsl') } : spriteGlslShaders();
  const statics = !indexed
    ? null
    : useWebGpu
      ? { maxStorageBytes: 1 << 30, scatter() {} }
      : {
          maxSize: 16384,
          make: (bits, width, height, label) => new TextureSource({ width, height, label }),
          upload() {},
          scatter() {},
        };
  const batch = new InstancedSpriteBatch({
    capacity: 64,
    label: 'e500',
    useWebGpu,
    shaders,
    split: true,
    statics,
    pixelDepth: { maps: new TextureSource({ width: 1, height: 1 }) },
    depthFaces: true,
    heightFrames,
  });
  for (const x of [...batch._buffers, ...(batch._staticBuffers || []), ...(batch._slotBuffers || [])]) x.update = () => {};
  return batch;
}

/** The opaque draws a frame makes with the batch's mesh on `shader`: the twin's (when drawn), then the batch's own. */
function opaqueDraws(batch, shader) {
  const draws = [];
  const twin = batch.vdepthShaderFor(shader);
  if (batch.vdepthMesh !== null && batch.vdepthMesh.visible && twin !== null) draws.push(twin);
  if (batch.mesh.visible) draws.push(shader);
  return draws;
}

/**
 * Each instance kind the atlas holds (a frame with heights where `heightFrames`, one without) drawn by exactly one opaque
 * draw; returns the draws.
 */
function assertEachOnce(batch, shader, label, heightFrames) {
  const draws = opaqueDraws(batch, shader);
  for (const heights of heightFrames ? [true, false] : [false]) {
    const by = draws.filter((s) => keeps(s, heights));
    assert.equal(by.length, 1, `${label}: an instance ${heights ? 'with' : 'without'} heights drawn once`);
    assert.equal(writesPixelDepth(by[0]), heights, `${label}: its depth ${heights ? 'from its pixels' : 'from its vertices'}`);
  }
  return draws;
}

test('the maps table counts the frames with heights', () => {
  const t = packMapsTable([
    { frame: { x: 0, y: 0 }, weedMaps: { x: 4, y: 2, heights: true } },
    { frame: { x: 0, y: 0 }, weedMaps: { x: 2, y: 6, relief: true } },
    { frame: { x: 0, y: 0 } },
    null,
  ]);
  assert.equal(t.heights, 1);
  assert.equal(t.data[2], MAPS_TWIN | MAPS_HEIGHTS);
  assert.equal(packMapsTable([{ frame: { x: 0, y: 0 }, weedMaps: { x: 1, y: 1 } }, { frame: { x: 0, y: 0 } }]).heights, 0);
  assert.equal(packMapsTable([]).heights, 0);
  // A bake from before E-496 reads every frame at its atlas texel, with heights.
  assert.equal(packMapsTable([{ frame: { x: 5, y: 5 } }, { frame: { x: 9, y: 9 } }], true).heights, 2);
});

for (const useWebGpu of [false, true]) {
  const backend = useWebGpu ? 'WebGPU' : 'WebGL';
  test(`${backend}: with faces, two opaque walks where a frame has heights and one where none has, every instance drawn once`, () => {
    for (const indexed of [false, true]) {
      const kind = indexed ? 'indexed' : 'plain';
      const programOf = (batch) => (indexed ? batch._indexedShader : batch.shader);
      // Some frame has heights: the batch's own program keeps those, its twin the others.
      const two = makeBatch({ useWebGpu, indexed, heightFrames: true });
      two.commitInstances(10);
      assert.equal(assertEachOnce(two, two.shader, `${backend} ${kind}, heights`, true).length, 2, 'two walks');
      if (indexed) assert.equal(assertEachOnce(two, two._indexedShader, `${backend} indexed program, heights`, true).length, 2);
      assert.equal(two.vdepthMesh.geometry, two.mesh.geometry, 'both walks over the same instances');

      // None has: one walk, the batch's own program the vertex-depth one, no twin drawn.
      const one = makeBatch({ useWebGpu, indexed, heightFrames: false });
      one.commitInstances(10);
      assert.equal(one.vdepthShaderFor(programOf(one)), null, 'no twin');
      assert.equal(one.vdepthMesh, null, 'no twin mesh made');
      assert.equal(one.pixelDepthMeshes().before, null);
      const draws = assertEachOnce(one, one.shader, `${backend} ${kind}, no heights`, false);
      assert.deepEqual(draws, [one.shader], 'one walk');
      if (indexed) {
        assert.deepEqual(assertEachOnce(one, one._indexedShader, `${backend} indexed program, no heights`, false), [one._indexedShader]);
      }

      // The atlas changes: the programs are made again, and the twin made then is drawn right before the batch's mesh.
      assert.equal(one.setHeightFrames(false), false, 'unchanged: nothing made');
      assert.equal(one.setHeightFrames(true), true);
      one.commitInstances(10);
      assert.ok(one.vdepthMesh !== null && one.vdepthMesh.visible);
      assert.equal(one.pixelDepthMeshes().before, one.vdepthMesh);
      assert.equal(assertEachOnce(one, one.shader, `${backend} ${kind}, heights again`, true).length, 2);
      assert.equal(two.setHeightFrames(false), true);
      two.commitInstances(10);
      assert.equal(two.vdepthMesh.visible, false, 'the twin no longer drawn');
      assert.deepEqual(assertEachOnce(two, two.shader, `${backend} ${kind}, heights gone`, false), [two.shader]);
    }
  });
}

test('without faces, height frames change nothing: one opaque program over every instance, writing its pixels\' depth', () => {
  for (const useWebGpu of [false, true]) {
    for (const heightFrames of [false, true]) {
      const shaders = useWebGpu ? { sprite: readEngineShader('instancedSprite.wgsl') } : spriteGlslShaders();
      const batch = new InstancedSpriteBatch({
        capacity: 16, label: 'e500-nofaces', useWebGpu, shaders, split: true,
        pixelDepth: { maps: new TextureSource({ width: 1, height: 1 }) }, heightFrames,
      });
      for (const x of [...batch._buffers, ...batch._staticBuffers]) x.update = () => {};
      batch.commitInstances(4);
      assert.equal(batch.vdepthMesh, null);
      assert.ok(keeps(batch.shader, true) && keeps(batch.shader, false));
      assert.ok(writesPixelDepth(batch.shader));
      assert.equal(batch.setHeightFrames(!heightFrames), false, 'nothing made again without faces');
    }
  }
});

test('N-467: a run-time layer blend reaches the vertex-depth twin as it reaches the batch\'s mesh and its edge pass', () => {
  for (const useWebGpu of [false, true]) {
    const batch = makeBatch({ useWebGpu, indexed: false, heightFrames: true });
    assert.ok(batch.vdepthMesh !== null, 'faces and height frames make the twin');
    batch.setLayerBlend('add');
    assert.equal(batch.mesh.blendMode, 'add');
    if (batch.edgeMesh !== null) assert.equal(batch.edgeMesh.blendMode, 'add');
    assert.equal(batch.vdepthMesh.blendMode, 'add', `${useWebGpu ? 'WebGPU' : 'WebGL'}: the twin takes the layer's blend`);
  }
});
