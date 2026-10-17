import test from 'node:test';
import assert from 'node:assert/strict';

import { Layer } from '../../src/core/layer.js';
import { SharedResource } from '../../src/core/sharedResource.js';
import { DEFAULT_LAYERS } from '../../src/util/configDefaults.js';
import { packTextureRows } from '../../src/render/sharedTextureUpload.js';

class Grid extends SharedResource {}

function bindGrid(length) {
  const schema = { cells: { type: Uint8Array, length } };
  Grid.initialize(new SharedArrayBuffer(SharedResource.getBufferSize(schema)), schema);
}

function planetLayer() {
  Layer.reset();
  SharedResource.resetAll();
  bindGrid(64);
  Layer.initializeFromConfig(
    {
      planet: {
        zIndex: 1,
        shader: {
          fragment: '/x.frag',
          worldRect: { width: 32, height: 32 },
          textures: [
            { name: 'cells', format: 'r8unorm', size: { width: 8, height: 8 } },
          ],
        },
      },
    },
    DEFAULT_LAYERS,
  );
  Layer.resolveSharedTextures();
  return Layer.get('planet');
}

test('updateTexture unions two rectangles and a whole-picture call replaces them', () => {
  try {
    const layer = planetLayer();
    layer.updateTexture('cells', Grid.cells, 1, 1, 2, 2);
    layer.updateTexture('cells', Grid.cells, 4, 0, 2, 3);
    const union = Layer.consumeTextureUpload(layer.id, 'cells');
    assert.equal(union.x, 1);
    assert.equal(union.y, 0);
    assert.equal(union.w, 5);
    assert.equal(union.h, 3);
    assert.equal(SharedResource.viewAt(union.resourceIndex, union.fieldIndex), Grid.cells);
    assert.equal(SharedResource.locateView(Grid.cells), Grid.cells._weedLoc);
    const slot = Layer._textureSlots[layer.id].cells;
    assert.equal(union, slot.rect);
    assert.equal(Atomics.load(slot.view, 0) & 1, 0);
    assert.equal(Layer.consumeTextureUpload(layer.id, 'cells'), null);

    layer.updateTexture('cells', Grid.cells);
    const full = Layer.consumeTextureUpload(layer.id, 'cells');
    assert.deepEqual(
      { x: full.x, y: full.y, w: full.w, h: full.h },
      { x: 0, y: 0, w: 8, h: 8 },
    );
  } finally {
    Layer.reset();
    SharedResource.resetAll();
  }
});

test('a generation that moves mid-read is not consumed', () => {
  try {
    const layer = planetLayer();
    const slot = Layer._textureSlots[layer.id].cells;
    const view = slot.view;
    layer.updateTexture('cells', Grid.cells, 1, 1, 2, 2);
    const seen = Atomics.load(view, 5);
    const orig = Atomics.load;
    let genLoads = 0;
    Atomics.load = function (buf, index) {
      const value = orig.call(Atomics, buf, index);
      if (buf === view && index === 0 && genLoads++ === 0) {
        Atomics.store(view, 3, 99);
        Atomics.store(view, 0, (value + 2) | 0);
      }
      return value;
    };
    let torn = null;
    try {
      torn = Layer.consumeTextureUpload(layer.id, 'cells');
    } finally {
      Atomics.load = orig;
    }
    assert.equal(torn, null);
    assert.equal(Atomics.load(view, 5), seen);
    Atomics.store(view, 3, 2);
    Atomics.store(view, 0, 2);
    layer.updateTexture('cells', Grid.cells, 4, 0, 2, 3);
    const union = Layer.consumeTextureUpload(layer.id, 'cells');
    assert.equal(union.x, 1);
    assert.equal(union.y, 0);
    assert.equal(union.w, 5);
    assert.equal(union.h, 3);
    assert.notEqual(union.w, 99);
  } finally {
    Layer.reset();
    SharedResource.resetAll();
  }
});

test('a normal typed array and an unknown picture are rejected', () => {
  try {
    const layer = planetLayer();
    assert.throws(
      () => layer.updateTexture('cells', new Uint8Array(64), 0, 0, 1, 1),
      /shared array|not a shared resource field/,
    );
    assert.throws(
      () => layer.updateTexture('nope', Grid.cells),
      /no picture or buffer "nope"/,
    );
  } finally {
    Layer.reset();
    SharedResource.resetAll();
  }
});

test('a compute picture a pass writes cannot be filled from a shared array', () => {
  try {
    Layer.reset();
    SharedResource.resetAll();
    bindGrid(64);
    Layer.initializeFromConfig(
      {
        fire: {
          shader: {
            compute: {
              textures: [{ name: 't', format: 'r8unorm', pingPong: true }],
              passes: [{ entry: 'main', swap: ['t'] }],
              size: { width: 8, height: 8 },
            },
          },
        },
      },
      DEFAULT_LAYERS,
    );
    Layer.resolveSharedTextures();
    assert.throws(
      () => Layer.get('fire').updateTexture('t', Grid.cells, 0, 0, 1, 1),
      /cannot be filled from a shared array|cannot also be filled/,
    );
  } finally {
    Layer.reset();
    SharedResource.resetAll();
  }
});

test('packTextureRows keeps source bytes and pads each row to 256', () => {
  const width = 300;
  const bpp = 1;
  const bytes = new Uint8Array(width * 4);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i & 255;
  const packed = packTextureRows(bytes, width, bpp, 10, 1, 20, 2, null);
  assert.equal(packed.bytesPerRow % 256, 0);
  assert.equal(packed.packed[0], bytes[width + 10]);
  assert.equal(packed.packed[19], bytes[width + 29]);
  assert.equal(packed.packed[packed.bytesPerRow], bytes[width * 2 + 10]);
});
