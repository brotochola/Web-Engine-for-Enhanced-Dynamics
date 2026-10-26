// Moving placed entities in edit mode (VISUAL_EDITOR_PLAN.md D6, ED-10): a drag from the selected entity shows a
// ghost where it would land, snapped to the grid, and moves it once on letting go (its record's x and y, then a
// respawn); a click there without a drag takes the next entity under it; the arrow keys nudge by grid steps.
// Runtime entities do not move.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { Messages } from '../../src/core/messages.js';
import { MoveTool, snapTo, SNAP_STEPS } from '../../src/core/debug/editor/moveTool.js';
import { recordOf, editPlaced } from '../../src/core/debug/editor/sceneDocument.js';

const N = 16;

function setup() {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  Transform.rotC = new Float32Array(N).fill(1);
  Transform.rotS = new Float32Array(N);
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(N)), N);
  SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(N)), N);
  Messages.bind({ inboxes: [], spawnGen: Messages.createSpawnGenBuffer(N) }, []);
  // The platform, placed by the file, at index 1.
  Transform.active[1] = 1;
  Transform.x[1] = 600;
  Transform.y[1] = 2050;
  Collider.active[1] = 1;
  Collider.shapeType[1] = ShapeType.Box;
  Collider.width[1] = 1200;
  Collider.height[1] = 60;

  const calls = [];
  let next = 10;
  class Platform {
    static spawnParams = { width: { value: 220 }, height: { value: 36 } };
    static spawn(cfg) {
      calls.push(['spawn', { ...cfg }]);
      return { index: next++ };
    }
    static despawn(i) {
      calls.push(['despawn', i]);
    }
  }
  const scene = {
    sceneFile: { format: 1, script: 's.js', entities: [{ name: 'Ground', class: 'Platform', x: 600, y: 2050, config: { width: 1200, height: 60 } }] },
    registeredClasses: [{ class: Platform }],
    _namedEntities: new Map([['Ground', 1 * 65536]]),
  };
  const picks = [];
  const edited = [];
  const selection = {
    debugUI: { scene },
    index: 1,
    name: 'Ground',
    get authored() {
      return this.name !== null;
    },
    pickAt: (x, y) => picks.push([x, y]),
  };
  // The editor's part (EditMode.editSelected), without the history: the change and its respawn.
  selection.editor = {
    editSelected: (label, write) => {
      const result = editPlaced(scene, selection.name, write);
      edited.push(result === null ? -1 : result.index);
      return result === null ? -1 : result.index;
    },
  };
  return { tool: new MoveTool(selection), selection, scene, calls, picks, edited };
}

test('snapTo puts a position on the grid; 1 is whole pixels', () => {
  assert.deepEqual(SNAP_STEPS, [1, 8, 16, 32]);
  assert.equal(snapTo(603.4, 1), 603);
  assert.equal(snapTo(603.4, 8), 600);
  assert.equal(snapTo(605, 8), 608);
  assert.equal(snapTo(-13, 16), -16);
});

test('a drag from the selected entity moves it once, on letting go, snapped', () => {
  const { tool, scene, calls, picks, edited } = setup();
  tool.snap = 16;
  tool.press(1000, 2050, 300, 300);
  assert.deepEqual(picks, [], 'pressed on the selection: kept');
  tool.move(1001, 2050, 301, 300);
  assert.equal(tool.dragging, false, 'under 3 screen pixels: not a drag yet');
  tool.move(1103, 2027, 400, 280);
  assert.equal(tool.dragging, true);
  tool.move(1210, 2012, 500, 260);
  assert.deepEqual(calls, [], 'nothing spawned or written while dragging');
  assert.deepEqual([scene.sceneFile.entities[0].x, scene.sceneFile.entities[0].y], [600, 2050]);
  tool.release();
  assert.deepEqual([recordOf(scene, 'Ground').record.x, recordOf(scene, 'Ground').record.y], [816, 2016], '600 + 210 and 2050 - 38, on the 16 grid');
  assert.deepEqual(calls, [
    ['despawn', 1],
    ['spawn', { x: 816, y: 2016, width: 1200, height: 60 }],
  ]);
  assert.deepEqual(edited, [10], 'the selection follows the respawned entity');
});

test('a click on the selected entity without a drag takes the next one under it; elsewhere it selects', () => {
  const { tool, selection, calls, picks } = setup();
  tool.press(1000, 2050, 300, 300);
  tool.release();
  assert.deepEqual(picks, [[1000, 2050]], 'the cycle');
  tool.press(3000, 100, 900, 100);
  assert.deepEqual(picks.at(-1), [3000, 100], 'off the selection: a new pick');
  tool.release();
  assert.equal(picks.length, 2, 'and no cycle after it');
  selection.name = null; // a runtime entity
  tool.press(1000, 2050, 300, 300);
  tool.move(1300, 2050, 600, 300);
  tool.release();
  assert.equal(tool.dragging, false);
  assert.deepEqual(calls, [], 'a runtime entity does not move');
  assert.equal(tool.nudge(1, 0), false);
});

test('the arrow keys nudge by grid steps; ten with Shift', () => {
  const { tool, scene } = setup();
  assert.equal(tool.nudge(1, 0), true);
  assert.equal(recordOf(scene, 'Ground').record.x, 601);
  tool.snap = 8;
  tool.nudge(0, -10);
  assert.equal(recordOf(scene, 'Ground').record.y, 1968, '2050 - 80 = 1970, on the 8 grid');
  tool.nudge(-1, 0);
  assert.equal(recordOf(scene, 'Ground').record.x, 592, '601 - 8 = 593, on the grid');
});

test('the ghost is the entity’s box where it would land, drawn in screen space', () => {
  const { tool } = setup();
  const path = [];
  const ctx = {
    save() {},
    restore() {},
    setLineDash() {},
    beginPath() {},
    closePath() {},
    stroke: () => path.push('stroke'),
    moveTo: (x, y) => path.push(['M', x, y]),
    lineTo: (x, y) => path.push(['L', x, y]),
  };
  tool.drawOverlay(ctx, { x: 0, y: 0 }, 1);
  assert.deepEqual(path, [], 'no drag, no ghost');
  tool.press(1000, 2050, 300, 300);
  tool.move(1100, 2050, 400, 300);
  tool.drawOverlay(ctx, { x: 100, y: 2000 }, 0.5);
  // Moved 100 right: x 100 to 1300, y 2020 to 2080; screen = (world - camera) * 0.5.
  assert.deepEqual(path, [['M', 0, 10], ['L', 600, 10], ['L', 600, 40], ['L', 0, 40], 'stroke']);
});
