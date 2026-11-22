// CR-19: the joint and tween pools and the layers' config buffer, laid out from tables, keep the byte offsets their
// hand-written layouts gave (the physics host mirrors the joint layout by hand), at both entity id widths; Component
// and SharedResource size and bind through laySchema as their own loops did.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Joint } from '../../src/core/joint.js';
import { Layer } from '../../src/core/layer.js';
import { Tween, tweenBufferBytes } from '../../src/core/tween.js';
import { bindEntityIdWidth } from '../../src/util/entityIdWidth.js';
import { laySchema } from '../../src/util/schemaLayout.js';

const align4 = (o) => Math.ceil(o / 4) * 4;

/** The joint layout as initializeArrays wrote it before CR-19: [field, byte offset, length]. */
function jointReference(n, e, wide) {
  const out = [];
  let o = 0;
  const col = (name, bytes, len = n) => {
    out.push([name, o, len]);
    o += len * bytes;
  };
  col('type', 1);
  o = align4(o);
  if (wide) {
    col('entityA', 4);
    col('entityB', 4);
  } else {
    col('pairs', 4);
  }
  for (const name of ['localAnchorAX', 'localAnchorAY', 'localAnchorBX', 'localAnchorBY', 'forceThreshold', 'torqueThreshold']) col(name, 4);
  col('active', 1);
  o = align4(o);
  col('length', 4);
  col('enableSpring', 1);
  o = align4(o);
  col('hertz', 4);
  col('dampingRatio', 4);
  col('enableLimit', 1);
  o = align4(o);
  col('lowerAngle', 4);
  col('upperAngle', 4);
  col('enableMotor', 1);
  o = align4(o);
  col('motorSpeed', 4);
  col('maxMotorTorque', 4);
  for (const name of ['linearHertz', 'angularHertz', 'linearDampingRatio', 'angularDampingRatio']) col(name, 4);
  col('activeIndices', 2);
  col('activeIndexPositions', 2);
  out.push(['activeMeta', o, 2], ['activeCount', o, 1], ['activeListLock', o + 4, 1]);
  o += 8;
  col('revision', 4);
  o = align4(o);
  col('nextA', 2);
  col('nextB', 2);
  o = align4(o);
  if (e > 0) out.push(['head', o, e]);
  o += e * 2;
  o = align4(o);
  return { columns: out, bytes: o };
}

test('the joint pool keeps its byte offsets, packed and wide, with and without per-entity heads', () => {
  try {
    for (const width of [16, 32]) {
      bindEntityIdWidth(width);
      for (const [n, e] of [[1, 0], [7, 3], [64, 1000], [33, 0], [255, 257]]) {
        const ref = jointReference(n, e, width === 32);
        assert.equal(Joint.getBufferSize(n, e), ref.bytes, `bytes n=${n} e=${e} width=${width}`);
        Joint.initializeArrays(new SharedArrayBuffer(ref.bytes), n, e);
        for (const [name, offset, len] of ref.columns) {
          assert.equal(Joint[name].byteOffset, offset, `${name} n=${n} e=${e} width=${width}`);
          assert.equal(Joint[name].length, len, `${name} length`);
        }
        if (width === 32) assert.equal(Joint.pairs, null);
        else assert.equal(Joint.entityA, null);
        if (e === 0) assert.equal(Joint.head, null);
        assert.equal(Joint.forceThreshold[n - 1], Infinity);
        assert.equal(Joint.activeIndices[0], Joint.INVALID_INDEX);
      }
    }
    Joint.reset();
    assert.equal(Joint.length, null);
    assert.equal(Joint.activeListLock, null);
  } finally {
    bindEntityIdWidth(16);
  }
});

test('Joint.update writes each type\'s props into their columns, and the force over the torque', () => {
  try {
    bindEntityIdWidth(16);
    Joint.initializeArrays(new SharedArrayBuffer(Joint.getBufferSize(4, 0)), 4, 0);
    Joint.maxCount = 4;
    Joint.active[1] = 1;
    Joint.type[1] = Joint.TYPE.PRISMATIC;
    Joint.update(1, { axisAngle: 0.5, enableLimit: true, lowerTranslation: -2, upperTranslation: 3, maxMotorTorque: 4, maxMotorForce: 9, localAnchorBY: 7 });
    assert.equal(Joint.linearHertz[1], 0.5);
    assert.equal(Joint.enableLimit[1], 1);
    assert.equal(Joint.lowerAngle[1], -2);
    assert.equal(Joint.upperAngle[1], 3);
    assert.equal(Joint.maxMotorTorque[1], 9);
    assert.equal(Joint.localAnchorBY[1], 7);
    Joint.type[1] = Joint.TYPE.DISTANCE;
    Joint.update(1, { hertz: 2, enableSpring: 0, lowerAngle: 99 });
    assert.equal(Joint.hertz[1], 2);
    assert.equal(Joint.enableSpring[1], 0);
    assert.equal(Joint.lowerAngle[1], -2, 'a revolute prop on a distance joint is not written');
  } finally {
    Joint.reset();
  }
});

/** The tween layout as bind wrote it before CR-19. */
function tweenReference(n, idBytes) {
  const out = [];
  let o = 0;
  const col = (name, bytes) => {
    out.push([name, o]);
    o = align4(o + n * bytes);
  };
  col('active', 4);
  col('ease', 1);
  col('mask', 1);
  col('kind', 1);
  col('entity', idBytes);
  for (const name of ['duration', 'elapsed', 'from0', 'to0', 'from1', 'to1', 'from2', 'to2', 'from3', 'to3', 'tintFrom', 'tintTo']) col(name, 4);
  col('repeat', 2);
  col('doneMsg', 2);
  col('flags', 1);
  return { columns: out, bytes: o };
}

test('the tween pool keeps its byte offsets at both entity id widths', () => {
  try {
    for (const width of [16, 32]) {
      bindEntityIdWidth(width);
      for (const [n, e] of [[1, 0], [5, 9], [128, 4096], [3, 1]]) {
        const ref = tweenReference(n, width / 8);
        assert.equal(tweenBufferBytes(n, e), ref.bytes + e * 2, `bytes n=${n} e=${e} width=${width}`);
        Tween.bind(new SharedArrayBuffer(tweenBufferBytes(n, e)), n, e);
        for (const [name, offset] of ref.columns) assert.equal(Tween[name].byteOffset, offset, `${name} n=${n} width=${width}`);
        assert.equal(Tween.entity.BYTES_PER_ELEMENT, width / 8);
        assert.equal(Tween.entityTweens.byteOffset, ref.bytes);
        assert.equal(Tween.entityTweens.length, e);
      }
    }
  } finally {
    Tween.unbind();
    bindEntityIdWidth(16);
  }
});

test('the layers\' config buffer keeps its byte offsets, and reset drops every column', () => {
  const n = Layer.MAX_LAYERS;
  // The hand-written layout before CR-19: [field, element bytes], an align to 4 after the third 1-byte column and
  // after the fifth.
  const ref = [];
  let o = 0;
  const col = (name, bytes) => {
    ref.push([name, o]);
    o += n * bytes;
  };
  col('_zIndex', 4);
  col('_blendModeId', 1);
  col('_hasShader', 1);
  col('_ySorting', 1);
  o = align4(o);
  col('_resolution', 4);
  col('_alpha', 4);
  col('_alphaDirty', 4);
  for (const name of ['_containerBlendId', '_available', '_hasRenderQueue', '_visible', '_feederKind']) col(name, 1);
  o = align4(o);
  col('_visibleDirty', 4);
  col('_presentationDirty', 4);
  assert.equal(Layer._getConfigSABSize(), o);
  Layer._createConfigViews(new SharedArrayBuffer(o));
  for (const [name, offset] of ref) {
    assert.equal(Layer[name].byteOffset, offset, name);
    assert.equal(Layer[name].length, n, `${name} length`);
  }
  Layer.reset();
  for (const [name] of ref) assert.equal(Layer[name], null, `${name} after reset`);
});

test('laySchema aligns each column to its element size and binds count x length elements', () => {
  const schema = { a: Uint8Array, b: { type: Float64Array, length: 3 }, c: Uint16Array, d: Int32Array };
  const entryOf = (spec) => (spec.type ? { type: spec.type, length: spec.length } : { type: spec, length: 1 });
  const bytes = laySchema(schema, entryOf, 5, 0, null, null);
  // a: 0..5; b at 8 (15 doubles, 120 bytes) to 128; c: 128..138; d at 140, 20 bytes: 160.
  assert.equal(bytes, 160);
  const seen = {};
  laySchema(schema, entryOf, 5, 8, new ArrayBuffer(8 + bytes), (name, view) => {
    seen[name] = [view.byteOffset, view.length];
  });
  assert.deepEqual(seen, { a: [8, 5], b: [16, 15], c: [136, 5], d: [148, 5] });
});
