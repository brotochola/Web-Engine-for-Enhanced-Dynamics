import test from 'node:test';
import assert from 'node:assert/strict';

import { mulberry32 } from '../bench/benchMath.js';
import { copyPremultiplyRgba } from '../reference/decalPremultiply.mjs';

// E-270: Pixi's dirty decal tiles go up in runs: tiles claimed one after another whose layers follow one another share a
// call. Every claimed tile's layer must end up with its premultiplied texels, whatever order the tiles were stamped in.

const PX = 16;
const TILE_BYTES = PX * PX * 4;

/** A PixiDecalTiles over a real decal memory, its chunks plain layer arrays a fake GL (or WebGPU queue) writes into. */
async function makeTiles({ totalTiles, layersPerChunk, runCap, maxUploads = 0, webgpu = false }) {
  const { createDecalMemory } = await import('../../src/util/decalMemory.js');
  const { bindDecalPremultiply } = await import('../../src/render/decalPremultiplyClient.js');
  const { PixiDecalTiles } = await import('../../src/render/pixi/decalTiles.js');
  const m = createDecalMemory({ totalTiles, tilePixelSize: PX, textures: null });
  const calls = [];
  let bound = null;
  const write = (source, layer, layers, data) => {
    calls.push({ source, layer, layers });
    assert.ok(layer >= 0 && layers >= 1 && layer + layers <= layersPerChunk, `layers ${layer}..${layer + layers}`);
    for (let i = 0; i < layers; i++) source.layers[layer + i] = Uint8Array.from(data.subarray(i * TILE_BYTES, (i + 1) * TILE_BYTES));
  };
  const gl = {
    TEXTURE_2D_ARRAY: 1, TEXTURE_BINDING_2D_ARRAY: 2, RGBA: 3, UNSIGNED_BYTE: 4, UNPACK_ALIGNMENT: 5,
    UNPACK_FLIP_Y_WEBGL: 6, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 7,
    getParameter: () => null,
    bindTexture: (target, t) => { bound = t; },
    pixelStorei() {},
    texSubImage3D(target, level, x, y, z, w, h, d, format, type, data) {
      assert.deepEqual([target, level, x, y, w, h, format, type], [1, 0, 0, 0, PX, PX, 3, 4]);
      write(bound, z, d, data);
    },
  };
  const device = {
    queue: {
      writeTexture({ texture, origin }, data, { bytesPerRow, rowsPerImage }, size) {
        assert.deepEqual([bytesPerRow, rowsPerImage, size.width, size.height], [PX * 4, PX, PX, PX]);
        write(texture, origin.z, size.depthOrArrayLayers, data);
      },
    },
  };
  const renderer = {
    uid: 0,
    gl: webgpu ? null : gl,
    gpu: webgpu ? { device } : null,
    texture: { bind() {}, getGlSource: (source) => ({ texture: source }) },
  };
  const dirty = new Uint8Array(new SharedArrayBuffer((totalTiles + 3) & ~3));
  const worker = {
    decalsEnabled: true,
    decalsTilePixelSize: PX,
    decalsTotalTiles: totalTiles,
    maxDecalTileUploadsPerFrame: maxUploads,
    decalsTilesDirty: dirty,
    _decalDirtyWords: new Uint32Array(dirty.buffer, 0, totalTiles >> 2),
    _decalPremultiply: await bindDecalPremultiply(m.memory, m.layout),
    _useWebGpu: webgpu,
    pixiApp: { renderer },
    _decalTilesDirtyThisFrame: 0,
    _decalTilesUploadedThisFrame: 0,
  };
  const tiles = new PixiDecalTiles(worker);
  tiles.stamped = new Uint8Array(totalTiles);
  tiles.tileSlot = new Int32Array(totalTiles).fill(-1);
  tiles.layersPerChunk = layersPerChunk;
  tiles.runCap = runCap;
  tiles.run = new Uint8ClampedArray(runCap * TILE_BYTES);
  tiles._makeChunk = () => {
    const source = { layers: [], update() {}, _gpuData: null };
    source._gpuData = [{ gpuTexture: source }];
    tiles.chunks.push({ source, used: 0 });
  };
  const texels = new Uint8ClampedArray(m.buffer, 0, totalTiles * TILE_BYTES);
  const stamp = (t, rng) => {
    for (let i = t * TILE_BYTES; i < (t + 1) * TILE_BYTES; i++) texels[i] = (i & 3) === 3 ? [0, 255, (rng() * 256) | 0][(rng() * 3) | 0] : (rng() * 256) | 0;
    dirty[t] = 1;
  };
  const check = (t, what) => {
    const slot = tiles.tileSlot[t];
    assert.ok(slot >= 0, `${what}: tile ${t} has a layer`);
    const want = new Uint8ClampedArray(TILE_BYTES);
    copyPremultiplyRgba(want, Uint8ClampedArray.from(texels.subarray(t * TILE_BYTES, (t + 1) * TILE_BYTES)));
    const got = tiles.chunks[(slot / layersPerChunk) | 0].source.layers[slot % layersPerChunk];
    assert.deepEqual(Buffer.from(got), Buffer.from(want), `${what}: tile ${t}`);
  };
  return { tiles, worker, calls, stamp, check, dirty };
}

for (const webgpu of [false, true]) {
  const name = webgpu ? 'WebGPU' : 'WebGL';

  test(`E-270 (${name}): a scan over tiles stamped in order is one upload a run, chunk by chunk`, async () => {
    const { tiles, worker, calls, stamp, check } = await makeTiles({ totalTiles: 40, layersPerChunk: 16, runCap: 8, webgpu });
    const rng = mulberry32(0x270);
    for (let t = 0; t < 40; t++) stamp(t, rng);
    tiles.update();
    assert.equal(worker._decalTilesUploadedThisFrame, 40);
    assert.deepEqual(calls.map((c) => [c.layer, c.layers]), [[0, 8], [8, 8], [0, 8], [8, 8], [0, 8]], 'runs of 8, none across a chunk of 16');
    for (let t = 0; t < 40; t++) check(t, 'in order');
    // A gap ends the run; the tiles keep their layers.
    calls.length = 0;
    for (const t of [2, 3, 4, 7, 8]) stamp(t, rng);
    tiles.update();
    assert.deepEqual(calls.map((c) => [c.layer, c.layers]), [[2, 3], [7, 2]]);
    for (const t of [2, 3, 4, 7, 8]) check(t, 'after a gap');
    calls.length = 0;
    tiles.update();
    assert.equal(calls.length, 0, 'nothing dirty, nothing sent');
  });

  test(`E-270 (${name}): tiles stamped in any order, a few at a time, each in its own layer`, async () => {
    const rng = mulberry32(0x2700);
    for (const [layersPerChunk, runCap, maxUploads] of [[16, 8, 0], [5, 3, 7], [64, 1, 11], [64, 64, 0]]) {
      const { tiles, worker, stamp, check, dirty } = await makeTiles({ totalTiles: 50, layersPerChunk, runCap, maxUploads, webgpu });
      for (let frame = 0; frame < 60; frame++) {
        const n = 1 + ((rng() * 20) | 0);
        for (let i = 0; i < n; i++) stamp((rng() * 50) | 0, rng);
        const before = Uint8Array.from(dirty);
        tiles.update();
        for (let t = 0; t < 50; t++) if (before[t] === 1 && dirty[t] === 0) check(t, `${layersPerChunk}/${runCap}/${maxUploads}, frame ${frame}`);
        assert.ok(worker._decalTilesUploadedThisFrame <= (maxUploads || 50));
        assert.equal(tiles.runTiles, 0, 'no tile waits for the next frame');
      }
    }
  });
}

test('E-270: an upload takes 256 KB of tiles, at least one, at most a chunk', async () => {
  const { decalRunTiles } = await import('../../src/render/pixi/decalTiles.js');
  assert.equal(decalRunTiles(16, 2048), 256);
  assert.equal(decalRunTiles(16, 100), 100);
  assert.equal(decalRunTiles(128, 128), 4);
  assert.equal(decalRunTiles(512, 8), 1);
});
