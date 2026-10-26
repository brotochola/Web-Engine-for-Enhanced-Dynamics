// Selection in edit mode (VISUAL_EDITOR_PLAN.md ED-8): a click picks the entity whose collider holds the point, or
// whose sprite box does when it has no collider, the smaller first and the next on a second click; never through
// the spatial grid, which files a wide platform under its center. The selection keeps the entity (its generation),
// knows whether the running scene file placed it, and lets go of it once it despawns.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { Messages } from '../../src/core/messages.js';
import { pickEntityAt, pointInSprite } from '../../src/core/debug/editor/pick.js';
import { Selection } from '../../src/core/debug/editor/selection.js';

const N = 8;
const CLASS_BY_TYPE = ['Platform', 'BluePlatformerPlayer', 'Flash', 'Decoration'];
const classNameOf = (type) => CLASS_BY_TYPE[type];

function initSoA() {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  Transform.rotC = new Float32Array(N).fill(1);
  Transform.rotS = new Float32Array(N);
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(N)), N);
  SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(N)), N);
  SpriteRenderer.scaleX.fill(1);
  SpriteRenderer.scaleY.fill(1);
  SpriteRenderer.anchorX.fill(0.5);
  SpriteRenderer.anchorY.fill(0.5);
  SpriteRenderer.inheritTransformRotation.fill(1);
  Messages.bind({ inboxes: [], spawnGen: Messages.createSpawnGenBuffer(N) }, []);
}

function place(i, type, x, y) {
  Transform.active[i] = 1;
  Transform.entityType[i] = type;
  Transform.x[i] = x;
  Transform.y[i] = y;
}

function box(i, w, h) {
  Collider.active[i] = 1;
  Collider.shapeType[i] = ShapeType.Box;
  Collider.width[i] = w;
  Collider.height[i] = h;
}

function circle(i, r) {
  Collider.active[i] = 1;
  Collider.shapeType[i] = ShapeType.Circle;
  Collider.radius[i] = r;
}

/** A sprite of 8 × 8 frame pixels, without asking the atlas. */
function withFrames(fn) {
  const w = SpriteRenderer.getOriginalWidth;
  const h = SpriteRenderer.getOriginalHeight;
  SpriteRenderer.getOriginalWidth = () => 8;
  SpriteRenderer.getOriginalHeight = () => 8;
  try {
    return fn();
  } finally {
    SpriteRenderer.getOriginalWidth = w;
    SpriteRenderer.getOriginalHeight = h;
  }
}

test('the sprite box is the one the overlay draws: anchor, signed scale, rotation', () => {
  initSoA();
  withFrames(() => {
    place(0, 3, 100, 100);
    SpriteRenderer.active[0] = 1;
    SpriteRenderer.scaleX[0] = 10;
    SpriteRenderer.scaleY[0] = 5;
    assert.equal(pointInSprite(0, 139, 119), true, 'inside 80 × 40 about the center');
    assert.equal(pointInSprite(0, 141, 100), false);
    assert.equal(pointInSprite(0, 100, 121), false);
    SpriteRenderer.anchorX[0] = 0;
    assert.equal(pointInSprite(0, 179, 100), true, 'anchor 0: the box starts at x');
    assert.equal(pointInSprite(0, 99, 100), false);
    SpriteRenderer.scaleX[0] = -10;
    assert.equal(pointInSprite(0, 21, 100), true, 'a flip mirrors it about the anchor');
    assert.equal(pointInSprite(0, 101, 100), false);
    SpriteRenderer.scaleX[0] = 10;
    SpriteRenderer.anchorX[0] = 0.5;
    Transform.rotC[0] = 0;
    Transform.rotS[0] = 1; // a quarter turn: 80 wide becomes 80 tall
    assert.equal(pointInSprite(0, 100, 139), true);
    assert.equal(pointInSprite(0, 139, 100), false);
  });
});

test('a click picks the smaller entity first, the next on a second click, and the far end of a wide platform', () => {
  initSoA();
  place(0, 0, 600, 2050);
  box(0, 1200, 60);
  place(1, 1, 500, 2000);
  circle(1, 30);
  // The player (y 1970 to 2030) stands in the platform's top (2020 to 2080).
  assert.equal(pickEntityAt(500, 2025, -1, classNameOf), 1, 'the player over the platform');
  assert.equal(pickEntityAt(500, 2025, 1, classNameOf), 0, 'again: the platform under it');
  assert.equal(pickEntityAt(500, 2025, 0, classNameOf), 1, 'and round again');
  assert.equal(pickEntityAt(500, 2010, 1, classNameOf), 1, 'above the platform only the player is there');
  assert.equal(pickEntityAt(1150, 2050, -1, classNameOf), 0, '550 px from its center, the player nearby');
  assert.equal(pickEntityAt(1250, 2050, -1, classNameOf), -1, 'past its end: nothing');
});

test('entities without a collider are picked by their sprite; the engine’s helpers and inactive ones never', () => {
  initSoA();
  withFrames(() => {
    place(2, 2, 300, 300);
    SpriteRenderer.active[2] = 1;
    SpriteRenderer.scaleX[2] = 10;
    SpriteRenderer.scaleY[2] = 10;
    assert.equal(pickEntityAt(300, 300, -1, classNameOf), -1, 'a Flash');
    place(3, 3, 300, 300);
    SpriteRenderer.active[3] = 1;
    SpriteRenderer.scaleX[3] = 10;
    SpriteRenderer.scaleY[3] = 10;
    assert.equal(pickEntityAt(330, 300, -1, classNameOf), 3, 'a decoration, by its sprite');
    Transform.active[3] = 0;
    assert.equal(pickEntityAt(330, 300, -1, classNameOf), -1);
  });
});

function selectionFor(scene) {
  const calls = [];
  const debugUI = {
    scene,
    tools: { _classNameForType: classNameOf },
    debugFlags: {
      setSelectedEntity: (i) => calls.push(`select ${i}`),
      clearSelectedEntity: () => calls.push('clear'),
    },
    canvas: { startLoop: () => calls.push('draw'), syncLoop: () => calls.push('sync') },
  };
  const selection = new Selection(debugUI);
  selection._show = () => calls.push('panel');
  return { selection, calls };
}

test('the selection knows what the scene file placed, and lets go of an entity that despawned', () => {
  initSoA();
  place(0, 0, 600, 2050);
  box(0, 1200, 60);
  place(1, 1, 500, 2000);
  circle(1, 30);
  Messages.spawnGen[0] = 3;
  const scene = { sceneFileUrl: 'http://localhost:8000/levels/1-1.scene.json', _namedEntities: new Map([['Platform1', 0 * 65536 + 3]]) };
  const { selection, calls } = selectionFor(scene);

  selection.pickAt(1000, 2050);
  assert.deepEqual([selection.index, selection.name, selection.className, selection.authored], [0, 'Platform1', 'Platform', true]);
  assert.deepEqual(calls, ['select 0', 'draw', 'panel'], 'the overlay boxes it, the panel names it');
  selection.pickAt(500, 2000);
  assert.deepEqual([selection.index, selection.name, selection.authored], [1, null, false], 'the player: runtime');

  selection.select(0);
  Messages.spawnGen[0] = 4; // despawned, and the slot went to another entity
  selection.update();
  assert.equal(selection.index, -1);
  selection.select(1);
  Transform.active[1] = 0;
  selection.update();
  assert.equal(selection.index, -1);
  calls.length = 0;
  selection.pickAt(3000, 100);
  assert.deepEqual(calls, [], 'a click on nothing with nothing selected changes nothing');
});
