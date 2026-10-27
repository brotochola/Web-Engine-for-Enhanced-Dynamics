// The inspector's Transform rows (VISUAL_EDITOR_PLAN.md ED-53, transformFields.js): a placed entity's position,
// rotation in degrees and sprite scale, typed or dragged by their labels; a drag shows on the live entity and writes
// the record once, on letting go; the record leaves out rotation 0 and scale 1, and keeps radians.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { TransformFields, formatValue, recordValue, writeValue } from '../../src/core/debug/editor/transformFields.js';

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.title = '';
    this.textContent = '';
  }
  appendChild(node) {
    this.children.push(node);
    return node;
  }
  append(...nodes) {
    for (const node of nodes) this.children.push(node);
  }
  blur() {}
  setPointerCapture() {}
  *all() {
    for (const child of this.children) {
      yield child;
      yield* child.all();
    }
  }
}

function withDocument(fn) {
  globalThis.document = { createElement: (tag) => new El(tag) };
  try {
    return fn();
  } finally {
    delete globalThis.document;
  }
}

/** The rows over a fake selection whose editor applies each write to `record` and counts them. */
function fieldsFor(record) {
  const writes = [];
  const selection = {
    name: 'Block1',
    index: 0,
    editor: {
      move: { snap: 8 },
      editSelected(label, write) {
        const before = JSON.stringify(record);
        write(record);
        if (JSON.stringify(record) === before) return -1;
        writes.push(label);
        fields.show(record, 0);
        return 0;
      },
    },
  };
  const fields = new TransformFields(selection);
  fields.show(record, 0);
  const inputs = [...fields.el.all()].filter((el) => el.tagName === 'INPUT');
  const axes = [...fields.el.all()].filter((el) => el.tagName === 'SPAN' && el.style.cssText?.includes('ew-resize'));
  return { fields, inputs, axes, writes };
}

const pointer = (clientX, extra = {}) => ({ button: 0, clientX, pointerId: 1, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, currentTarget: new El('span'), preventDefault() {}, ...extra });

test('the record’s values, as the fields show them; what a write leaves in the record', () => {
  assert.equal(formatValue(12.3456, 2), '12.35');
  assert.equal(formatValue(90.00001, 2), '90');
  assert.equal(recordValue({ rotation: Math.PI / 2 }, 'rotation'), 90);
  assert.equal(recordValue({}, 'scaleX'), 1);
  const record = { name: 'A', x: 0, y: 0 };
  writeValue(record, 'rotation', 270);
  assert.equal(record.rotation, Math.round((-Math.PI / 2) * 1e6) / 1e6, '270° is -90°, in radians');
  writeValue(record, 'rotation', 360);
  assert.equal('rotation' in record, false, '0 is left out');
  writeValue(record, 'scaleX', 2.5);
  writeValue(record, 'scaleY', 1);
  assert.deepEqual([record.scaleX, 'scaleY' in record], [2.5, false]);
});

test('typed: one write per field left; the same value writes nothing; text that is no number goes back', () => {
  withDocument(() => {
    const record = { name: 'Block1', class: 'Block', x: 300, y: 200 };
    const { inputs, writes } = fieldsFor(record);
    assert.deepEqual(inputs.map((i) => i.value), ['300', '200', '0', '1', '1']);
    inputs[0].value = '320';
    inputs[0].onchange();
    inputs[2].value = '45';
    inputs[2].onchange();
    inputs[1].value = '200';
    inputs[1].onchange();
    inputs[3].value = 'wide';
    inputs[3].onchange();
    assert.deepEqual(writes, ['move Block1', 'turn Block1']);
    assert.deepEqual([record.x, record.y, record.rotation], [320, 200, Math.round((Math.PI / 4) * 1e6) / 1e6]);
    assert.equal(inputs[3].value, '1', 'back to the record’s');
  });
});

test('a drag on a label shows on the live entity as it goes, snapped, and writes once on letting go; Esc puts it back', () => {
  withDocument(() => {
    Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(2)), 2);
    for (const k of ['x', 'y', 'rotation', 'rotC', 'rotS']) Transform[k] = new Float32Array(2);
    const record = { name: 'Block1', class: 'Block', x: 300, y: 200 };
    const { fields, axes, writes } = fieldsFor(record);
    const [xAxis, , rotationAxis] = axes;
    xAxis.onpointerdown(pointer(100));
    xAxis.onpointermove(pointer(113));
    assert.equal(Transform.x[0], 312, '13 px is 13 units, on the 8 px grid');
    xAxis.onpointermove(pointer(123, { altKey: true }));
    assert.equal(Transform.x[0], 323, 'Alt: off the grid');
    assert.deepEqual(writes, [], 'nothing written while dragging');
    xAxis.onpointerup();
    assert.deepEqual([writes, record.x], [['move Block1'], 323]);

    rotationAxis.onpointerdown(pointer(0));
    rotationAxis.onpointermove(pointer(9, { shiftKey: true }));
    assert.ok(Math.abs(Transform.rotation[0] - Math.PI / 2) < 1e-6, '9 px with Shift: 90°');
    fields.cancelDrag();
    assert.equal(Transform.rotation[0], 0, 'Esc: as the record has it');
    rotationAxis.onpointerup();
    assert.deepEqual(writes, ['move Block1'], 'a cancelled drag writes nothing');
  });
});

test('a runtime entity (no record) has no rows; an entity without a sprite has no scale row unless its record scales it', () => {
  withDocument(() => {
    const record = { name: 'Door1', class: 'Door', x: 0, y: 0 };
    const { fields } = fieldsFor(record);
    assert.equal(fields._scaleRow.style.display, 'none');
    fields.show({ ...record, scaleX: 2 }, 0);
    assert.equal(fields._scaleRow.style.display, 'flex');
    fields.show(null, -1);
    assert.equal(fields.el.style.display, 'none');
  });
});

test('on the real editor: a rotation, scale or seed edit respawns the entity once, and undo takes it out of the record', async () => {
  const { makeWorld } = await import('../helpers/editorHandlesWorld.mjs');
  const world = makeWorld();
  try {
    const { editMode, calls } = world;
    world.select('Block1');
    for (const [label, write] of [
      ['turn', (r) => writeValue(r, 'rotation', 30)],
      ['scale', (r) => writeValue(r, 'scaleX', 2)],
      ['look', (r) => (r.seed = 99)],
    ]) {
      calls.length = 0;
      assert.ok(editMode.editSelected(label, write) >= 0, `${label}: written`);
      assert.deepEqual(calls.map((c) => c[0]), ['despawn', 'spawn'], `${label}: one respawn`);
    }
    assert.deepEqual([world.record('Block1').rotation, world.record('Block1').scaleX, world.record('Block1').seed], [Math.round((Math.PI / 6) * 1e6) / 1e6, 2, 99]);
    editMode.undo();
    editMode.undo();
    editMode.undo();
    const record = world.record('Block1');
    assert.deepEqual(['rotation' in record, 'scaleX' in record, 'seed' in record], [false, false, false], 'all three undone');
  } finally {
    world.done();
  }
});
