// N-463: the entities batch drawn in chunks (gpuParticleChunks.js EntityChunks: GPU particle groups or look-layer regions
// sorted among the entities) draws each range of instances with the programs the batch draws all of them with. With faces
// (DX-FACEDEPTH) and some frame with heights the batch's opaque pass is two programs (E-378, E-500): its own keeps the
// instances whose frame has heights and its vertex-depth twin (vdepthMesh, right before it) the others, so each chunk has
// that twin too, or the instances without heights went undrawn while a group sorted among them. And when setDepthFaces or
// setHeightFrames make the programs again, the chunks draw with the new ones, not with those of their first frame.
// Checked on real batches (both backends, a plain and an indexed frame) under a root the Pixi worker's own
// _placeDepthMeshes arranges: which instances each opaque draw keeps, as its vertex stage decides it (the cull in its
// source), so that in every chunk each instance is drawn once, by the same programs as the batch's own drawing.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Container, TextureSource } from '../../src/vendor/pixi.min.js';
import { InstancedSpriteBatch } from '../../src/render/instancedSpriteBatch.js';
import { EntityChunks } from '../../src/render/gpuParticleChunks.js';
import { PROXY, PROXY_ENTRY_WORDS } from '../../src/render/gpuParticleProxies.js';
import { readEngineShader, spriteGlslShaders } from './engineShaderSources.mjs';

// The Pixi worker's _placeDepthMeshes (its prototype's), on a small context.
const previousSelf = globalThis.self;
const previousPostMessage = globalThis.postMessage;
globalThis.self = globalThis;
globalThis.postMessage = () => {};
await import('../../src/workers/pixiWorker.js');
const Pixi = globalThis.pixiRenderer.constructor.prototype;
test.after(() => {
  globalThis.self = previousSelf;
  globalThis.postMessage = previousPostMessage;
});

// GlProgram.from probes shader precision on a canvas (the worker's import set Pixi's adapter to OffscreenCanvas); Node has
// none, and a context of null is enough. After the import: with a document the scene's parameters read the page's location.
globalThis.document ??= { createElement: () => ({ getContext: () => null }) };
globalThis.OffscreenCanvas ??= class {
  getContext() {
    return null;
  }
};

const GLSL_FLAT_CULL = 'if (!twinHeights(vMapsWin)) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);';
const GLSL_HEIGHTS_CULL = 'if (twinHeights(vMapsWin)) {\n    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);';
const WGSL_FLAT_CULL = 'if (!twinHeights(out.vMapsWin)) { out.position = vec4<f32>(2.0, 2.0, 2.0, 1.0); }';
const WGSL_HEIGHTS_CULL = 'if (twinHeights(out.vMapsWin)) {\n    out.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);';

/** Whether the program's vertex stage keeps an instance whose frame has heights (`heights`), or one without. */
function keeps(shader, heights) {
  const v = shader.glProgram ? shader.glProgram.vertex : shader.gpuProgram.vertex.source;
  const flat = v.includes(GLSL_FLAT_CULL) || v.includes(WGSL_FLAT_CULL);
  const tall = v.includes(GLSL_HEIGHTS_CULL) || v.includes(WGSL_HEIGHTS_CULL);
  assert.ok(!(flat && tall), 'one cull a program');
  if (flat) return heights;
  if (tall) return !heights;
  return true;
}

/** Whether the program's pixels write their own depth (the frames with heights), or keep the vertex's. */
function writesPixelDepth(shader) {
  if (shader.glProgram) return shader.glProgram.fragment.includes('gl_FragDepth');
  return /fn mainFrag\(in: VertexOut\) -> WeedDepthOut/.test(shader.gpuProgram.fragment.source);
}

const COUNT = 10;
/** The entry (a group) sorts between instances 3 and 4: two chunks, [0, 4) and [4, 10). */
const SPLIT = 4;
const ZEROS = new Float32Array(COUNT * 16);

function makeBatch({ useWebGpu, depthFaces, heightFrames }) {
  const shaders = useWebGpu ? { sprite: readEngineShader('instancedSprite.wgsl') } : spriteGlslShaders();
  const statics = useWebGpu
    ? { maxStorageBytes: 1 << 30, scatter() {} }
    : {
        maxSize: 16384,
        make: (bits, width, height, label) => new TextureSource({ width, height, label }),
        upload() {},
        scatter() {},
      };
  const batch = new InstancedSpriteBatch({
    capacity: 64,
    label: 'n463',
    useWebGpu,
    shaders,
    split: true,
    statics,
    pixelDepth: { maps: new TextureSource({ width: 1, height: 1 }) },
    depthFaces,
    heightFrames,
  });
  for (const x of [...batch._buffers, ...(batch._staticBuffers || []), ...(batch._slotBuffers || [])]) x.update = () => {};
  if (batch._staticsSource) batch._staticsSource.update = () => {};
  return batch;
}

/** The entities root, and the Pixi worker's own placement of the batch's pixel depth meshes around its mesh. */
function sceneOf(batch) {
  const root = new Container({ isRenderGroup: true });
  root.addChild(batch.mesh);
  const worker = { _entitiesRoot: root, entitiesBatch: batch, spriteMesh: batch.mesh };
  const place = () => Pixi._placeDepthMeshes.call(worker);
  place();
  const chunks = new EntityChunks({ batch, root });
  const half = { ints: new Int32Array(PROXY_ENTRY_WORDS) };
  half.ints[PROXY.INDEX] = SPLIT;
  const mark = new Container();
  mark.label = 'group';
  const drawEntry = (w, out, n) => {
    out[n] = mark;
    return n + 1;
  };
  return { root, chunks, place, apply: () => chunks.apply(half, 1, COUNT, drawEntry), mark };
}

/** One frame's upload: a plain frame or an indexed one (E-162), each with its own geometry and program. */
function commit(batch, indexed) {
  if (indexed) batch.commitIndexed(ZEROS, ZEROS, ZEROS, COUNT, COUNT, 1, 1);
  else batch.commitInstances(COUNT);
}

/** What Pixi draws under `root`, in order: visible and renderable children with alpha (an idle chunk twin has none). */
const drawnUnder = (root) => root.children.filter((c) => c.visible && c.renderable && c.alpha > 0);

/** The batch drawing itself: its programs in draw order (the vertex-depth twin, its own, the edge pass). */
function ownPrograms(batch, root) {
  const drawn = drawnUnder(root);
  for (const m of drawn) assert.ok([batch.mesh, batch.vdepthMesh, batch.edgeMesh].includes(m), 'only the batch\'s meshes');
  return drawn.map((m) => m.shader);
}

/**
 * The chunks' draws, each side of the group: the meshes over one range of instances each, as [first, count] and their
 * programs in draw order, with every instance kind the atlas holds drawn once by its opaque ones (those that write
 * depth: not the edge pass), its depth from its pixels with heights or without faces, and none of the batch's own meshes
 * drawn.
 */
function chunkDraws(batch, root, mark, label, heightFrames, faces) {
  const drawn = drawnUnder(root);
  for (const own of [batch.mesh, batch.vdepthMesh, batch.edgeMesh]) {
    if (own !== null) assert.ok(!drawn.includes(own), `${label}: the batch's own ${own.label} not drawn`);
  }
  const at = drawn.indexOf(mark);
  assert.ok(at > 0, `${label}: the group between the chunks`);
  return [drawn.slice(0, at), drawn.slice(at + 1)].map((side, c) => {
    const geometry = side[0].geometry;
    for (const m of side) assert.equal(m.geometry, geometry, `${label}, chunk ${c}: one range`);
    const opaque = side.filter((m) => m.state.depthMask);
    for (const heights of heightFrames ? [true, false] : [false]) {
      const by = opaque.filter((m) => keeps(m.shader, heights));
      assert.equal(by.length, 1, `${label}, chunk ${c}: an instance ${heights ? 'with' : 'without'} heights drawn once`);
      const pixels = heights || !faces;
      assert.equal(writesPixelDepth(by[0].shader), pixels, `${label}, chunk ${c}: its depth ${pixels ? 'from its pixels' : 'from its vertices'}`);
    }
    return { range: [geometry.weedFirstInstance, geometry.instanceCount], programs: side.map((m) => m.shader) };
  });
}

/** A program's name: the WGSL one's own, or the one Pixi writes into a GLSL source (SHADER_NAME). */
const nameOf = (shader) => shader.gpuProgram?.name ?? shader.glProgram?.vertex.match(/SHADER_NAME\s+(\S+)/)?.[1] ?? '?';

/**
 * The same objects in the same order (programs, children), named in a failure. Not deepEqual: two different programs
 * compared deeply walk Pixi's whole graph, for minutes.
 */
function assertSameList(actual, expected, label, name = nameOf) {
  const names = (list) => list.map(name).join(', ');
  assert.ok(actual.length === expected.length && actual.every((x, i) => x === expected[i]),
    `${label}: [${names(actual)}], expected [${names(expected)}]`);
}

/**
 * The chunks cover the instances once, each with the programs the batch draws all of them with; then, back to the batch's
 * own drawing (clear), the batch draws them in that order too.
 */
function assertChunksDrawAsTheBatch(batch, scene, label, { heights, faces }) {
  const twin = heights && faces;
  const sides = chunkDraws(batch, scene.root, scene.mark, label, heights, faces);
  assert.deepEqual(sides.map((s) => s.range), [[0, SPLIT], [SPLIT, COUNT - SPLIT]], `${label}: every instance once`);
  scene.chunks.clear();
  const own = ownPrograms(batch, scene.root);
  assert.equal(own.length, twin ? 3 : 2, `${label}: the batch's own drawing ${twin ? 'with' : 'without'} its vertex-depth twin`);
  for (const s of sides) assertSameList(s.programs, own, `${label}: a chunk's programs are the batch's`);
  return own;
}

for (const useWebGpu of [false, true]) {
  const backend = useWebGpu ? 'WebGPU' : 'WebGL';
  for (const indexed of [false, true]) {
    const kind = `${backend} ${indexed ? 'indexed' : 'plain'}`;

    test(`${kind}: with faces and frames with heights, each chunk draws its instances with both opaque programs`, () => {
      const batch = makeBatch({ useWebGpu, depthFaces: true, heightFrames: true });
      const scene = sceneOf(batch);
      commit(batch, indexed);
      assert.equal(batch.mesh.shader, indexed ? batch._indexedShader : batch.shader);
      scene.apply();
      const own = assertChunksDrawAsTheBatch(batch, scene, kind, { heights: true, faces: true });
      assert.equal(own[0], batch.vdepthShaderFor(batch.mesh.shader), 'the vertex-depth twin first');

      // Frames in chunks one after another: nothing hidden, shown or moved (the batch's twin stays shown, not rendered).
      commit(batch, indexed);
      scene.apply();
      const children = scene.root.children.slice();
      for (let f = 0; f < 3; f++) {
        scene.root.renderGroup.structureDidChange = false;
        commit(batch, indexed);
        scene.apply();
        assert.equal(scene.root.renderGroup.structureDidChange, false, `${kind}, frame ${f}: the stage holds still`);
        assertSameList(scene.root.children, children, `${kind}, frame ${f}: the same children`, (c) => c.label);
      }
      scene.chunks.destroy();
    });

    test(`${kind}: the chunks draw with the programs setHeightFrames and setDepthFaces make again`, () => {
      const batch = makeBatch({ useWebGpu, depthFaces: true, heightFrames: true });
      const scene = sceneOf(batch);
      commit(batch, indexed);
      scene.apply();
      const first = assertChunksDrawAsTheBatch(batch, scene, `${kind}, heights`, { heights: true, faces: true });

      // The atlas loses its frames with heights: one opaque program, the vertex-depth one; no twin drawn.
      assert.equal(batch.setHeightFrames(false), true);
      scene.place();
      commit(batch, indexed);
      scene.apply();
      const none = assertChunksDrawAsTheBatch(batch, scene, `${kind}, no heights`, { heights: false, faces: true });
      assert.notEqual(none[0], first[1], 'the programs made again');

      // And gets them back: the twin again, with the programs made now.
      assert.equal(batch.setHeightFrames(true), true);
      scene.place();
      commit(batch, indexed);
      scene.apply();
      const again = assertChunksDrawAsTheBatch(batch, scene, `${kind}, heights again`, { heights: true, faces: true });
      for (let i = 0; i < again.length; i++) assert.notEqual(again[i], first[i], 'none of the first frame\'s programs');

      // Faces off: one program over every instance, writing its pixels' depth.
      assert.equal(batch.setDepthFaces(false), true);
      scene.place();
      commit(batch, indexed);
      scene.apply();
      const plain = assertChunksDrawAsTheBatch(batch, scene, `${kind}, no faces`, { heights: true, faces: false });
      assert.ok(keeps(plain[0], true) && keeps(plain[0], false), 'one opaque program for both kinds');
      scene.chunks.destroy();
    });

    test(`${kind}: faces turned on after the chunks were made give them the vertex-depth twin`, () => {
      // As a scene's first frames do: the batch is made before the first decoration with a normal (lighting.useFaces).
      const batch = makeBatch({ useWebGpu, depthFaces: false, heightFrames: true });
      const scene = sceneOf(batch);
      commit(batch, indexed);
      scene.apply();
      assertChunksDrawAsTheBatch(batch, scene, `${kind}, before faces`, { heights: true, faces: false });
      assert.equal(batch.vdepthMesh, null);

      assert.equal(batch.setDepthFaces(true), true);
      scene.place();
      assert.equal(batch.pixelDepthMeshes().before, batch.vdepthMesh);
      commit(batch, indexed);
      scene.apply();
      assertChunksDrawAsTheBatch(batch, scene, `${kind}, faces`, { heights: true, faces: true });
      scene.chunks.destroy();
    });
  }
}
