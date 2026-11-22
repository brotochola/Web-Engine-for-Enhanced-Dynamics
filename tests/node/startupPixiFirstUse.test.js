// E-494: the programs the renderer made the first time a pass drew (the lamps' map, the sun's map, their volumes, the UV
// meshes, the G-buffer and unshaded passes over the entities, the keyed shadow passes) are made at init when the config
// says the pass runs, and so linked ahead with the rest (E-475); the pass's own first call then gets the very program made
// at init (GlProgram.from), already linked, instead of a new one to link while the frame waits. A program no mesh draws
// with is left out of the links.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GlProgram, Shader, Texture } from '../../src/vendor/pixi.min.js';
import { InstancedSpriteBatch } from '../../src/render/instancedSpriteBatch.js';
import { meshUvFillProgram } from '../../src/render/meshUvFillBatch.js';
import { loadWorker } from '../bench/workerHarness.mjs';
import { readEngineShader, spriteGlslShaders } from './engineShaderSources.mjs';

// GlProgram probes shader precision on a canvas; Node has none, and a context of null is enough.
globalThis.OffscreenCanvas ??= class {
  getContext() {
    return null;
  }
};

const readShader = readEngineShader;
const GL_SHADERS = {
  ...spriteGlslShaders(),
  shadowVert: readShader('instancedSpriteShadow.vert.glsl'),
  sunMapFrag: readShader('sunShadowMap.frag.glsl'),
  faceFrag: readShader('faceMap.frag.glsl'),
  meshUvFillVert: readShader('meshUvFill.vert.glsl'),
  meshUvFillFrag: readShader('meshUvFill.frag.glsl'),
};

/** The programs made while `fn` runs (GlProgram.weedMade, as the worker's init collects them). */
function programsMadeBy(fn) {
  const made = [];
  GlProgram.weedMade = made;
  try {
    fn();
  } finally {
    GlProgram.weedMade = null;
  }
  return made;
}

/** A program's name, from the SHADER_NAME Pixi puts in its fragment source. */
function nameOf(program) {
  return /#define SHADER_NAME (\S+)-fragment/.exec(program.fragment)?.[1] ?? '?';
}

async function glRenderer() {
  const shared = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const px = new shared.constructor({ postMessage: () => {}, onmessage: null });
  px._useWebGpu = false;
  px._engineShaders = { ...GL_SHADERS };
  px.pixiApp = { renderer: { gl: null } };
  return px;
}

test("a lit scene's maps, volumes and UV meshes: their programs made at init, and the passes' first calls get them", async () => {
  const px = await glRenderer();
  px.gpuCasterBatch = { mesh: {} };
  px._sunMapOn = true;
  px._lampMapOn = true;
  px._lampCacheOn = true;
  px.customLayers.list = [
    { layerId: 3, uvVertCapacity: 0, uvIndexCapacity: 0, sunProjected: false },
    { layerId: 6, uvVertCapacity: 64, uvIndexCapacity: 96, sunProjected: true },
  ];

  const made = programsMadeBy(() => px._makeFirstUsePrograms());
  const names = made.map(nameOf).sort();
  assert.deepEqual(names, [
    'lamp-map', 'lamp-map-columns', 'lamp-map-volume-cache', 'lamp-map-volume-copy', 'lamp-map-volumes',
    'mesh-uv-6', 'sun-map', 'sun-map-columns', 'sun-map-volumes',
  ]);

  // The passes, on their first draw, make their programs by the same calls: each gets the one made at init.
  const later = programsMadeBy(() => {
    assert.ok(made.includes(px._lampMapProgram(false).glProgram), "the lamps' cards");
    assert.ok(made.includes(px._lampMapProgram(true).glProgram), "the lamps' columns");
    assert.ok(made.includes(px._sunShadowProgram('map').glProgram), "the sun's map");
    assert.ok(made.includes(px._sunShadowProgram('mapColumns').glProgram), "the sun's map columns");
    assert.ok(made.includes(px._sunMapVolumeProgram().glProgram), "the sun map's volumes");
    assert.ok(made.includes(px._lampCacheCopyProgram().glProgram), "the lamps' cache copy");
    assert.ok(made.includes(meshUvFillProgram(false, px._engineShaders, 'mesh-uv-9').glProgram), 'any layer\'s UV mesh');
  });
  assert.equal(later.length, 0, 'no program made after init');
  // The volumes' programs are made once and kept.
  const volumes = px._volumeLampProgram.glProgram;
  px._makeVolumeLampPrograms();
  assert.equal(px._volumeLampProgram.glProgram, volumes);
  assert.ok(made.includes(volumes));
});

test('without the maps or a UV mesh, no program is made for them', async () => {
  const px = await glRenderer();
  px.gpuCasterBatch = { mesh: {} };
  px.customLayers.list = [{ layerId: 2, uvVertCapacity: 0, uvIndexCapacity: 0, sunProjected: true }];
  px.atlasMapsSource = null;
  const made = programsMadeBy(() => px._makeFirstUsePrograms());
  assert.deepEqual(made.map(nameOf), []);
});

test("the entities' keyed shadow passes: their programs made at init, the passes' first calls get them", () => {
  const capacity = 64;
  const shared = new Float32Array(capacity * 32);
  const statics = { maxSize: 4096, scatter() {}, make: () => Texture.EMPTY.source, upload() {} };
  const keyed = { keyRows: 128, keyBase: 0, updatesByte: 0, headerByte: 0, shadowByte: 0 };
  const batch = new InstancedSpriteBatch({
    capacity,
    label: 'entities-instanced',
    useWebGpu: false,
    shaders: GL_SHADERS,
    split: true,
    data: shared,
    gpuPack: { spritesKeyedRows: null },
    statics,
    keyed,
  });
  assert.equal(batch.keyed, true, 'a keyed batch');
  const made = programsMadeBy(() => batch.makeKeyedShadowPrograms(true, true));
  assert.deepEqual(made.map(nameOf).sort(), ['entities-instanced-keyed-stamp-rows', 'entities-instanced-keyed-sun', 'entities-instanced-keyed-sun-rows']);

  // makeKeyedSunShader and makeKeyedCasterShader make their programs by these calls.
  const later = programsMadeBy(() => {
    assert.ok(made.includes(batch._keyedSunProgram().glProgram), 'the keyed sun pass');
    assert.ok(made.includes(batch._keyedCasterProgram(false).glProgram), "the sun's keyed rows");
    assert.ok(made.includes(batch._keyedCasterProgram(true).glProgram), "the stamps' keyed rows");
  });
  assert.equal(later.length, 0, 'no program made after init');
});

test("the casters' batch's own sprite program, which no mesh draws, is left out of the links ahead", async () => {
  const px = await glRenderer();
  const drawn = new Shader({ glProgram: GlProgram.from({ vertex: 'void main() {}', fragment: 'void main() { /* drawn */ }', name: 'drawn' }), resources: {} });
  const unused = new Shader({ glProgram: GlProgram.from({ vertex: 'void main() {}', fragment: 'void main() { /* unused */ }', name: 'unused' }), resources: {} });
  px._madePrograms = [drawn.glProgram, unused.glProgram];
  px._leaveOutOfLinksAhead(unused, [drawn]);
  assert.deepEqual(px._madePrograms, [drawn.glProgram]);
  // One another batch draws (the same program through GlProgram.from) stays.
  px._leaveOutOfLinksAhead(drawn, [drawn]);
  assert.deepEqual(px._madePrograms, [drawn.glProgram]);
});
