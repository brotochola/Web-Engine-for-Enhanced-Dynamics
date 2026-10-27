// The editor's scatter brush (VISUAL_EDITOR_PLAN.md ED-25): a drag fills the brush's circle with the chosen
// decoration class up to its density, at random points on the editor's grid, each decoration with its own draws of
// what the class varies; Shift+drag takes them out. The document holds them as the file's flat arrays, the pool holds
// them live, and each dab spawns or despawns only its own. One stroke is one undo (the class's record before and
// after, as data); undo and redo keep the slots of the decorations both sides have.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPoolScene } from '../helpers/poolScene.mjs';
import { DecorationPool } from '../../src/core/decorationPool.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { Scene } from '../../src/core/scene.js';
import { checkSceneFile, serializeSceneFile, parseSceneFile } from '../../src/core/sceneFile.js';
import { spawnSceneFileDecorations } from '../../src/core/sceneFileDecorations.js';
import { EditMode } from '../../src/core/debug/editor/editMode.js';

class Meadow extends Scene {
  static decorations = {
    Grass: { texture: ['grass1', 'grass2', 'grass3'], scale: { min: 0.2, max: 0.4 }, anchorY: 1 },
    Rock: { texture: 'rock', scale: 0.5 },
  };
}

/** Random numbers that repeat from a seed. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function setup({ maxDecorations = 256, rocks = [[500, 500]] } = {}) {
  buildPoolScene({ decorations: maxDecorations, world: [4000, 4000] });
  SpriteSheetRegistry.register('bigAtlas', { animations: { grass1: ['g1'], grass2: ['g2'], grass3: ['g3'], rock: ['r'] } });
  const scene = Object.create(Meadow.prototype);
  Object.assign(scene, {
    sceneFile: checkSceneFile(
      {
        format: 1,
        script: 's.js',
        entities: [],
        decorations: [{ class: 'Rock', x: rocks.map((r) => r[0]), y: rocks.map((r) => r[1]) }],
      },
      'meadow.scene.json',
    ),
    sceneFileUrl: 'http://host/levels/meadow.scene.json',
    config: { decoration: { maxDecorations } },
    _fileDecorations: new Map(),
    registeredClasses: [],
    _namedEntities: new Map(),
  });
  spawnSceneFileDecorations(scene);
  const canvas = { tagName: 'CANVAS' };
  const loops = [];
  const debugUI = {
    scene,
    gameEngine: { canvas },
    tools: { _classNameForType: () => '', updateToolIndicator() {} },
    debugFlags: { setSelectedEntity() {}, clearSelectedEntity() {} },
    canvas: { startLoop: () => loops.push('start'), syncLoop: () => loops.push('sync') },
  };
  const editMode = new EditMode(debugUI);
  editMode.selection._show = () => {};
  editMode.active = true; // edit mode, without its listeners
  const brush = editMode.brush;
  brush.random = seeded(7);
  const at = (x, y, shiftKey = false) => [x, y, { shiftKey, target: canvas }];
  return { scene, editMode, brush, at, loops };
}

function teardown(editMode) {
  clearTimeout(editMode._statusTimer);
  SpriteSheetRegistry.spritesheets.delete('bigAtlas');
  DecorationPool.reset();
}

const grassOf = (scene) => scene.sceneFile.decorations?.find((r) => r.class === 'Grass') ?? null;

test('a stroke paints the class up to its density, on the grid, with its own draws; one undo', () => {
  const { scene, editMode, brush, at, loops } = setup();
  try {
    brush.radius = 50;
    brush.density = 80; // a dab fills its circle with round(80 · π · 50² / 100²) = 63
    brush.select('Grass');
    assert.equal(brush.className, 'Grass');
    assert.ok(loops.includes('start'), 'the overlay runs for the circle');
    assert.equal(brush.press(...at(200, 200)), true);
    brush.move(...at(210, 200)); // not a third of the radius away: no dab
    const afterOne = grassOf(scene).x.length;
    assert.equal(afterOne, 63);
    brush.move(...at(300, 200));
    brush.release(...at(300, 200));
    const grass = grassOf(scene);
    const n = grass.x.length;
    assert.ok(n > 63 && n <= 126, `${n} after two dabs`);
    for (let i = 0; i < n; i++) {
      assert.equal(Number.isInteger(grass.x[i]) && Number.isInteger(grass.y[i]), true, 'whole pixels: the grid of 1');
      const near = (cx) => (grass.x[i] - cx) ** 2 + (grass.y[i] - 200) ** 2 <= 50 * 50;
      assert.ok(near(200) || near(300), `${grass.x[i]}, ${grass.y[i]} is in a dab’s circle`);
      assert.ok([0, 1, 2].includes(grass.frame[i]));
      assert.ok(grass.scale[i] >= 0.2 && grass.scale[i] <= 0.4 && Math.round(grass.scale[i] * 1000) === grass.scale[i] * 1000);
    }
    assert.equal(grass.rotation, undefined, 'what the class does not vary has no array');
    assert.equal(DecorationPool.getActiveCount(), 1 + n, 'the rock and every blade, live');
    const indices = scene._fileDecorations.get(grass);
    assert.equal(indices.length, n);
    const C = DecorationComponent;
    for (let i = 0; i < n; i++) {
      assert.deepEqual([C.x[indices[i]], C.y[indices[i]], C.textureId[indices[i]]], [grass.x[i], grass.y[i], grass.frame[i]]);
      assert.ok(Math.abs(C.scaleX[indices[i]] - grass.scale[i]) < 1e-6);
    }
    assert.equal(editMode.history._done.length, 1);
    assert.equal(editMode.history._done[0].kind, 'decorations');
    assert.equal(editMode.history._done[0].before, null, 'the file had no grass');

    // The file as written: flat arrays, and it reads back.
    const text = serializeSceneFile(scene.sceneFile);
    assert.deepEqual(parseSceneFile(text, 'x.scene.json').decorations[1].x, grass.x);

    editMode.undo();
    assert.equal(grassOf(scene), null);
    assert.equal(DecorationPool.getActiveCount(), 1);
    editMode.redo();
    assert.deepEqual(grassOf(scene).x, grass.x);
    assert.equal(DecorationPool.getActiveCount(), 1 + n);
  } finally {
    teardown(editMode);
  }
});

test('Shift+drag erases inside the circle; undo puts them back and the others keep their slots', () => {
  const { scene, editMode, brush, at } = setup();
  try {
    brush.radius = 60;
    brush.density = 60;
    brush.select('Grass');
    brush.press(...at(400, 400));
    brush.release(...at(400, 400));
    const painted = structuredClone(grassOf(scene));
    const slots = scene._fileDecorations.get(grassOf(scene)).slice();
    brush.radius = 20;
    brush.press(...at(400, 400, true));
    brush.release(...at(400, 400, true));
    const grass = grassOf(scene);
    const inside = painted.x.filter((x, i) => (x - 400) ** 2 + (painted.y[i] - 400) ** 2 <= 400).length;
    assert.ok(inside > 0);
    assert.equal(grass.x.length, painted.x.length - inside);
    for (let i = 0; i < grass.x.length; i++) assert.ok((grass.x[i] - 400) ** 2 + (grass.y[i] - 400) ** 2 > 400);
    assert.equal(grass.frame.length, grass.x.length, 'every array keeps its decorations in step');
    assert.equal(DecorationPool.getActiveCount(), 1 + grass.x.length);
    assert.equal(editMode.history._done.at(-1).label, 'erase Grass');

    const kept = scene._fileDecorations.get(grass).slice();
    editMode.undo();
    assert.deepEqual(grassOf(scene), painted);
    assert.equal(DecorationPool.getActiveCount(), 1 + painted.x.length);
    const back = scene._fileDecorations.get(grassOf(scene));
    // The ones the erase left kept their slots through the undo.
    let k = 0;
    for (let i = 0; i < painted.x.length; i++) {
      if ((painted.x[i] - 400) ** 2 + (painted.y[i] - 400) ** 2 > 400) assert.equal(back[i], kept[k++]);
    }
    assert.equal(slots.length, back.length);
    editMode.redo();
    assert.equal(grassOf(scene).x.length, painted.x.length - inside);

    // Erasing everything takes the class out of the file; its undo puts it back where it was.
    brush.radius = 2000;
    brush.press(...at(400, 400, true));
    brush.release(...at(400, 400, true));
    assert.equal(grassOf(scene), null);
    assert.deepEqual(scene.sceneFile.decorations.map((r) => r.class), ['Rock']);
    editMode.undo();
    assert.deepEqual(scene.sceneFile.decorations.map((r) => r.class), ['Rock', 'Grass']);
  } finally {
    teardown(editMode);
  }
});

test('a coarse grid puts decorations on its points, one per point; a full pool keeps only what it took', () => {
  const { scene, editMode, brush, at } = setup({ maxDecorations: 21 });
  try {
    editMode.move.snap = 16;
    brush.radius = 40;
    brush.density = 50;
    brush.select('Grass');
    brush.press(...at(800, 800));
    brush.release(...at(800, 800));
    const grass = grassOf(scene);
    const points = new Set(grass.x.map((x, i) => `${x},${grass.y[i]}`));
    assert.equal(points.size, grass.x.length, 'no two on one point');
    for (const x of grass.x) assert.equal(x % 16, 0);
    assert.equal(grass.x.length, 20, 'the pool took 20 beside the rock');
    assert.equal(DecorationPool.getActiveCount(), 21);
    assert.match(editMode.status, /The decoration pool is full: raise Meadow's config\.decoration\.maxDecorations/);
  } finally {
    teardown(editMode);
  }
});

test('the history is data: a new page’s editor undoes a stroke made before it (D9)', () => {
  const { scene, editMode, brush, at } = setup();
  try {
    brush.select('Rock');
    brush.radius = 30;
    brush.press(...at(100, 100));
    brush.release(...at(100, 100));
    const rocks = grassOf(scene) === null ? scene.sceneFile.decorations[0] : null;
    assert.ok(rocks.x.length > 1);
    const data = structuredClone(editMode.history.toData());
    const next = new EditMode(editMode.debugUI);
    next.history.load(data);
    next.undo();
    assert.deepEqual(scene.sceneFile.decorations[0].x, [500]);
    assert.equal(DecorationPool.getActiveCount(), 1);
    clearTimeout(next._statusTimer);
  } finally {
    teardown(editMode);
  }
});

test('the circle on the overlay: where the pointer is, dashed red with Shift; nothing with the brush down', () => {
  const { editMode, brush, at } = setup();
  try {
    const calls = [];
    const ctx = new Proxy(
      {},
      {
        get: (_, key) => (key in ctxValues ? ctxValues[key] : (...args) => calls.push([key, ...args])),
        set: (_, key, value) => {
          calls.push([`${String(key)}=`, value]);
          return true;
        },
      },
    );
    const ctxValues = {};
    brush.hover(...at(150, 250));
    brush.drawOverlay(ctx, { x: 100, y: 200 }, 2);
    assert.deepEqual(calls, [], 'the brush is down');
    brush.select('Grass');
    brush.radius = 30;
    brush.hover(...at(150, 250));
    brush.drawOverlay(ctx, { x: 100, y: 200 }, 2);
    assert.deepEqual(calls.find((c) => c[0] === 'arc'), ['arc', 100, 100, 60, 0, Math.PI * 2]);
    assert.deepEqual(calls.find((c) => c[0] === 'setLineDash'), ['setLineDash', []]);
    calls.length = 0;
    brush.hover(...at(150, 250, true));
    brush.drawOverlay(ctx, { x: 100, y: 200 }, 2);
    assert.deepEqual(calls.find((c) => c[0] === 'setLineDash'), ['setLineDash', [5, 4]]);
    assert.equal(editMode.wantsOverlay(), true);
    assert.equal(brush.onKey({ key: ']' }), true);
    assert.equal(brush.radius, 38);
    assert.equal(brush.onKey({ key: 'Escape' }), true);
    assert.equal(brush.className, null);
    assert.equal(editMode.wantsOverlay(), false);
  } finally {
    teardown(editMode);
  }
});

// ---- the palette's section, against a fake DOM ----

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.classList = { set: new Set(), add(c) { this.set.add(c); } };
    this.value = '';
    this._text = '';
  }
  appendChild(node) {
    this.children.push(node);
    return node;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(text) {
    this._text = text;
    this.children = [];
  }
  *all() {
    for (const child of this.children) {
      yield child;
      yield* child.all();
    }
  }
  find(fn) {
    for (const el of this.all()) if (fn(el)) return el;
    return null;
  }
}

test('the palette’s Decorations: each class with the file’s count, Paint, the radius and the density', () => {
  globalThis.document = { createElement: (tag) => new El(tag) };
  try {
    const { scene, editMode, brush } = setup({ rocks: [[1, 1], [2, 2]] });
    const body = new El('div');
    brush.mountPalette(body);
    const rows = [...body.all()].filter((el) => el.dataset.decorationClass !== undefined);
    assert.deepEqual(rows.map((r) => [r.dataset.decorationClass, r.children[2].textContent]), [['Grass', '0'], ['Rock', '2']]);
    rows[1].children[0].onclick();
    assert.equal(brush.className, 'Rock');
    const again = [...body.all()].filter((el) => el.dataset.decorationClass === 'Rock')[0];
    assert.equal(again.children[0].classList.set.has('active'), true);
    const radius = body.find((el) => el.dataset.brushRadius !== undefined);
    radius.value = '120';
    radius.onchange();
    assert.equal(brush.radius, 120);
    const density = body.find((el) => el.dataset.brushDensity !== undefined);
    density.value = '2.5';
    density.onchange();
    assert.equal(brush.density, 2.5);
    assert.equal(scene.sceneFile.decorations.length, 1);
    clearTimeout(editMode._statusTimer);
  } finally {
    delete globalThis.document;
    SpriteSheetRegistry.spritesheets.delete('bigAtlas');
    DecorationPool.reset();
  }
});
