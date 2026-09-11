import test from 'node:test';
import assert from 'node:assert/strict';

import { Layer, RESERVED_LOOK_UNIFORMS } from '../../src/core/Layer.js';
import {
  buildComputePrelude,
  buildLookPrelude,
  prependComputePrelude,
  prependLookPrelude,
  FRAME_PREFIX_FIELDS,
} from '../../src/workers/wgslPrelude.js';

const BUILT_IN_LAYERS = {
  BACKGROUND: {},
  DECALS: {},
  CASTED_SHADOWS: {},
  ENTITIES: {},
  LIGHTING: {},
};

test('compute prelude: FrameData prefix fields + frame binding + Body', () => {
  const out = buildComputePrelude(null, null);
  for (const f of FRAME_PREFIX_FIELDS) {
    assert.ok(out.includes(`  ${f}: f32,`), `missing prefix field ${f}`);
  }
  assert.ok(out.includes('struct FrameData {'));
  assert.ok(out.includes('@group(0) @binding(0) var<uniform> frame: FrameData;'));
  assert.ok(out.includes('struct Body {'));
  assert.ok(out.includes('vertStart: f32,'));
});

test('compute prelude: tail fields in map offset order with config names/types', () => {
  const map = {
    uRise: { offset: 0, size: 1 },
    uTint: { offset: 4, size: 3 },
    uCount: { offset: 8, size: 1 },
  };
  const types = { uTint: 'vec3<f32>' };
  const out = buildComputePrelude(map, types);
  const iRise = out.indexOf('uRise: f32,');
  const iTint = out.indexOf('uTint: vec3<f32>,');
  const iCount = out.indexOf('uCount: f32,');
  assert.ok(iRise > 0 && iTint > iRise && iCount > iTint, 'tail order must follow offsets');
  // prefix ends before tail starts
  assert.ok(out.indexOf('padFrame: f32,') < iRise);
});

test('compute prelude guard: hand-written structs/bindings throw', () => {
  assert.throws(() => prependComputePrelude('struct SimParams {\n  dt: f32,\n}\n', null, null), /WeedJS:/);
  assert.throws(() => prependComputePrelude('struct FrameData {\n  dt: f32,\n}\n', null, null), /WeedJS:/);
  assert.throws(() => prependComputePrelude('struct Body {\n  posX: f32,\n}\n', null, null), /WeedJS:/);
  assert.throws(
    () => prependComputePrelude('@group(0) @binding(0) var<uniform> frame: FrameData;', null, null),
    /WeedJS:/
  );
  assert.throws(
    () => prependComputePrelude('@group(0) @binding(0) var<uniform> sim: SimParams;', null, null),
    /WeedJS:/
  );
});

test('look prelude: fixed structs, bindings, VertexOut, CustomUniforms tail', () => {
  const map = { uCutoff: { offset: 0, size: 1 } };
  const out = buildLookPrelude(map, null);
  assert.ok(out.includes('struct GlobalUniforms {'));
  assert.ok(out.includes('struct LocalUniforms {'));
  assert.ok(out.includes('struct CustomUniforms {'));
  assert.ok(out.includes('struct VertexOut {'));
  assert.ok(out.includes('@group(2) @binding(0) var<uniform> customUniforms: CustomUniforms;'));
  assert.ok(out.includes('@group(2) @binding(1) var uTexture: texture_2d<f32>;'));
  assert.ok(out.includes('@group(2) @binding(2) var uSampler: sampler;'));
  assert.ok(out.includes('uCutoff: f32,'));
});

test('look prelude: empty map emits pad field', () => {
  const out = buildLookPrelude(null, null);
  assert.ok(out.includes('struct CustomUniforms {\n  _pad: f32,\n}'));
});

test('look prelude guard: hand-written look structs throw', () => {
  assert.throws(() => prependLookPrelude('struct CustomUniforms {\n  uA: f32,\n}\n', null, null), /WeedJS:/);
  assert.throws(() => prependLookPrelude('struct GlobalUniforms {\n  uP: mat3x3<f32>,\n}\n', null, null), /WeedJS:/);
  assert.throws(() => prependLookPrelude('struct VertexOut {\n  @builtin(position) p: vec4<f32>,\n}\n', null, null), /WeedJS:/);
  assert.throws(() => prependLookPrelude('@group(2) @binding(1) var uTexture: texture_2d<f32>;', null, null), /WeedJS:/);
});

test('reserved look uniforms injected for custom shader layers', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig(
      {
        water: {
          shader: {
            fragment: 'look',
            uniforms: { uThreshold: { value: 0.8, type: 'f32' } },
          },
        },
      },
      BUILT_IN_LAYERS,
      true
    );
    const id = Layer.get('water').id;
    const map = Layer._uniformMaps[id];
    for (const name of Object.keys(RESERVED_LOOK_UNIFORMS)) {
      assert.ok(map[name], `missing reserved ${name}`);
    }
    // Reserved first: uTime at 0, uDt 1, uZoom 2, then vec2s aligned to even offsets
    assert.equal(map.uTime.offset, 0);
    assert.equal(map.uDt.offset, 1);
    assert.equal(map.uZoom.offset, 2);
    assert.equal(map.uCameraPos.offset % 2, 0);
    assert.equal(map.uCameraPos.size, 2);
    assert.equal(map.uViewSize.offset, 10);
    assert.equal(map.uTexSize.offset, 12);
    assert.equal(map.uTexSize.size, 2);
    // Scene uniform lands after the reserved block
    assert.ok(map.uThreshold.offset >= 14);
    // Types and metadata
    const meta = Layer._metadata.layers[id];
    assert.equal(meta.uniformTypes.uCameraPos, 'vec2<f32>');
    assert.equal(meta.uniformTypes.uThreshold, 'f32');
  } finally {
    Layer.reset();
  }
});

test('scene def wins over reserved on name collision (initial value kept)', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig(
      {
        water: {
          shader: {
            fragment: 'look',
            uniforms: { uTime: { value: 5, type: 'f32' } },
          },
        },
      },
      BUILT_IN_LAYERS,
      true
    );
    const id = Layer.get('water').id;
    assert.equal(Layer._uniformMaps[id].uTime.offset, 0);
    assert.equal(Layer._uniformFloats[id][0], 5);
  } finally {
    Layer.reset();
  }
});

test('shader layer without uniforms still gets the reserved block', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig(
      { plain: { shader: { fragment: 'look' } } },
      BUILT_IN_LAYERS,
      true
    );
    const id = Layer.get('plain').id;
    assert.ok(Layer._uniformMaps[id].uTime);
    assert.ok(Layer._uniformMaps[id].uTexSize);
    assert.ok(Layer._uniformFloats[id].length >= 14);
  } finally {
    Layer.reset();
  }
});

test('vec uniforms align to WGSL uniform rules in the SAB map', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig(
      {
        water: {
          shader: {
            fragment: 'look',
            uniforms: {
              uA: { value: 1, type: 'f32' },
              uColor: { value: [1, 0, 0], type: 'vec3<f32>' },
              uB: { value: 2, type: 'f32' },
            },
          },
        },
      },
      BUILT_IN_LAYERS,
      true
    );
    const map = Layer._uniformMaps[Layer.get('water').id];
    // uA after reserved block (uTexSize ends at 14)
    const a = map.uA.offset;
    assert.equal(map.uColor.offset % 4, 0);
    assert.ok(map.uColor.offset >= a + 1);
    assert.equal(map.uB.offset, map.uColor.offset + 3);
  } finally {
    Layer.reset();
  }
});

test('prelude tail matches SAB map order (integration)', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig(
      {
        fire: {
          shader: {
            fragment: 'look',
            compute: 'sim',
            uniforms: {
              uRise: { value: -1, type: 'f32' },
              uTint: { value: [1, 1, 1], type: 'vec3<f32>' },
            },
          },
        },
      },
      BUILT_IN_LAYERS,
      true
    );
    const id = Layer.get('fire').id;
    const map = Layer._uniformMaps[id];
    const types = Layer._metadata.layers[id].uniformTypes;
    const out = buildComputePrelude(map, types);
    // Every map entry appears as a struct field, ordered by offset
    const positions = Object.entries(map)
      .sort((a, b) => a[1].offset - b[1].offset)
      .map(([name]) => {
        const idx = out.indexOf(`  ${name}: `);
        assert.ok(idx > 0, `missing tail field ${name}`);
        return idx;
      });
    const sorted = [...positions].sort((a, b) => a - b);
    assert.deepEqual(positions, sorted);
    assert.ok(out.includes('uTint: vec3<f32>,'));
  } finally {
    Layer.reset();
  }
});
