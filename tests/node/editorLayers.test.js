// Per-layer hide and lock in edit mode (VISUAL_EDITOR_PLAN.md ED-24): a hidden layer is not drawn while editing (its
// Layer.visible, put back when edit mode is left, hidden again after a fast swap while editing, dropped with the
// scene); a click in the view leaves out what a locked layer holds, or what only hidden layers draw; the move tool
// does not move a locked layer's entity; the scene list marks it; the palette's Layers section has a row per layer.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Layer } from '../../src/core/layer.js';
import { DEFAULT_LAYERS, LAYER_KIND, ShapeType } from '../../src/util/configDefaults.js';
import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Messages } from '../../src/core/messages.js';
import { Time } from '../../src/core/timeScale.js';
import { Camera } from '../../src/core/camera.js';
import { Mouse } from '../../src/core/mouse.js';
import { EditMode } from '../../src/core/debug/editor/editMode.js';
import { EditorLayers, entityLayerMask, editorLayersOf, lockable } from '../../src/core/debug/editor/editorLayers.js';
import { EntityTree } from '../../src/core/debug/editor/entityTree.js';
import { Palette } from '../../src/core/debug/editor/palette.js';

const N = 16;

function initLayers() {
  Layer.reset();
  Layer.initializeFromConfig(
    {
      ground: { kind: LAYER_KIND.TILEMAP, tilemap: 'ground', zIndex: 0 },
      props: { zIndex: 3.5, maxItems: 64 },
    },
    DEFAULT_LAYERS,
    true,
  );
}

function initSoA() {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  Transform.rotC = new Float32Array(N).fill(1);
  Transform.rotS = new Float32Array(N);
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(N)), N);
  SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(N)), N);
  Messages.bind({ inboxes: [], spawnGen: Messages.createSpawnGenBuffer(N) }, []);
}

/** A 100 × 100 box at (x, y), drawn in the layers of `layers` (names; none: the default). */
function entity(i, x, y, layers = []) {
  Transform.active[i] = 1;
  Transform.x[i] = x;
  Transform.y[i] = y;
  Collider.active[i] = 1;
  Collider.shapeType[i] = ShapeType.Box;
  Collider.width[i] = 100;
  Collider.height[i] = 100;
  SpriteRenderer.active[i] = 1;
  let mask = 0;
  for (const name of layers) mask |= 1 << Layer.getId(name);
  SpriteRenderer.layerMask[i] = mask;
}

const bit = (name) => 1 << Layer.getId(name);

function makeEditor() {
  Time.bind(new SharedArrayBuffer(4));
  const data = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
  data.set([1, 0, 0, 400, 300, 1]);
  Camera.initialize(data, 800, 600);
  Camera.worldWidth = Infinity;
  Camera.worldHeight = Infinity;
  Mouse.initialize(new SharedArrayBuffer(Mouse.BUFFER_SIZE));
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  const scene = {
    config: { lighting: { enabled: false }, particle: { decals: false } },
    sceneFile: {
      format: 1,
      script: 's.js',
      entities: [
        { name: 'Crate1', class: 'Crate', x: 100, y: 100 },
        { name: 'Lamp1', class: 'Crate', x: 100, y: 100 },
      ],
    },
    registeredClasses: [],
    _namedEntities: new Map([
      ['Crate1', 1 * 65536],
      ['Lamp1', 2 * 65536],
    ]),
  };
  const debugUI = {
    scene,
    gameEngine: { canvas: {} },
    tools: { deactivateAll() {}, updateToolIndicator() {}, _syncDebugToolFlag() {}, _classNameForType: () => 'Crate' },
    panels: { scene: { updateEditButton() {} } },
    debugFlags: { setSelectedEntity() {}, clearSelectedEntity() {} },
    canvas: { startLoop() {}, syncLoop() {} },
    _ensureTickLoop() {},
  };
  const editMode = new EditMode(debugUI);
  debugUI.editMode = editMode;
  editMode.palette = { show() {}, hide() {}, refresh() {}, destroy() {} };
  editMode.selection._show = () => {};
  return { editMode, scene, debugUI };
}

function done(editMode) {
  editMode.exit();
  clearTimeout(editMode._statusTimer);
  delete globalThis.document;
  Camera.held = false;
  Camera.setFree(false);
}

test('an entity is in the layers its sprite and collider name, and with the entities when no sprite layer is one', () => {
  initLayers();
  initSoA();
  try {
    entity(1, 0, 0);
    entity(2, 0, 0, ['props']);
    assert.equal(entityLayerMask(1), bit('entities'), 'no layer named: drawn with the entities');
    assert.equal(entityLayerMask(2), bit('props'));
    SpriteRenderer.active[3] = 0;
    Collider.active[3] = 1;
    Collider.layerMask[3] = bit('props');
    assert.equal(entityLayerMask(3), bit('props'), 'a collider alone');
    SpriteRenderer.layerMask[2] = bit('props') | bit('entities');
    assert.equal(entityLayerMask(2), bit('props') | bit('entities'), 'two sprite layers');
  } finally {
    Layer.reset();
  }
});

test('the layers offered: the scene’s own and the engine’s it uses, highest first; lock only where entities go', () => {
  initLayers();
  try {
    const off = { config: { lighting: { enabled: false }, particle: { decals: false } } };
    assert.deepEqual(editorLayersOf(off).map((l) => l.name), ['props', 'entities', 'ground']);
    const lit = { config: { lighting: { enabled: true, shadowsEnabled: true }, particle: { decals: true } } };
    assert.deepEqual(
      editorLayersOf(lit).map((l) => l.name),
      ['lightGlows', 'lighting', 'props', 'entities', 'castedShadows', 'decals', 'ground'],
    );
    assert.deepEqual(
      editorLayersOf(lit).filter(lockable).map((l) => l.name),
      ['props', 'entities'],
      'scenery, lighting, shadows and decals hold no entities',
    );
  } finally {
    Layer.reset();
  }
});

test('hide: the layer goes while editing, comes back on leaving, hides again on entering and after a swap', () => {
  initLayers();
  initSoA();
  Layer.snapshotBootLiveValues();
  const { editMode } = makeEditor();
  const props = Layer.get('props');
  const ground = Layer.get('ground');
  try {
    editMode.layers.setHidden(props.id, true);
    assert.equal(props.visible, true, 'not editing: only the choice');
    editMode.enter();
    assert.equal(props.visible, false, 'entering hides it');
    assert.equal(Atomics.load(Layer._visibleDirty, props.id), 1, 'the renderer is told');
    editMode.layers.setHidden(ground.id, true);
    assert.equal(ground.visible, false, 'while editing, at once');
    editMode.layers.setHidden(ground.id, false);
    assert.equal(ground.visible, true);
    editMode.exit();
    assert.equal(props.visible, true, 'leaving puts it back: the game plays with all of it');
    editMode.enter();
    assert.equal(props.visible, false, 'the choice is kept');
    // A fast swap puts every layer back as it booted (Scene._resetSceneWideStateForSwap), then calls the editor.
    Layer.restoreBootLiveValues();
    assert.equal(props.visible, true, 'the swap shows it as it booted');
    editMode.onContentSwapped();
    assert.equal(props.visible, false, 'hidden again after the swap');
    editMode.exit();
    assert.equal(props.visible, true);
  } finally {
    done(editMode);
    Layer.reset();
  }
});

test('hide puts back what it found: a layer the game hid stays hidden; one shown meanwhile stays shown', () => {
  initLayers();
  initSoA();
  const { editMode } = makeEditor();
  const props = Layer.get('props');
  const ground = Layer.get('ground');
  try {
    ground.visible = false; // the game's own choice
    editMode.layers.setHidden(ground.id, true);
    editMode.layers.setHidden(props.id, true);
    editMode.enter();
    props.visible = true; // the Layers panel's checkbox, while editing
    editMode.exit();
    assert.equal(ground.visible, false, 'the game had hidden it');
    assert.equal(props.visible, true);
  } finally {
    done(editMode);
    Layer.reset();
  }
});

test('a full load puts the layers back and drops the choices: the next scene’s layers are others', () => {
  initLayers();
  initSoA();
  const { editMode } = makeEditor();
  const props = Layer.get('props');
  try {
    editMode.layers.setHidden(props.id, true);
    editMode.layers.setLocked(props.id, true);
    editMode.enter();
    editMode.onDetach();
    assert.equal(props.visible, true);
    assert.equal(editMode.layers.hiddenMask, 0);
    assert.equal(editMode.layers.lockedMask, 0);
  } finally {
    done(editMode);
    Layer.reset();
  }
});

test('a click leaves out a locked layer’s entities, and what only hidden layers draw', () => {
  initLayers();
  initSoA();
  const { editMode } = makeEditor();
  const { selection, layers } = editMode;
  try {
    entity(1, 100, 100); // entities
    entity(2, 100, 100, ['props']);
    Collider.width[2] = 50; // smaller: picked first
    editMode.enter();
    selection.pickAt(100, 100);
    assert.equal(selection.index, 2, 'the smaller one');
    selection.clear();
    layers.setLocked(Layer.getId('props'), true);
    selection.pickAt(100, 100);
    assert.equal(selection.index, 1, 'props is locked: the one under it');
    layers.setHidden(Layer.entitiesId, true);
    selection.pickAt(100, 100);
    assert.equal(selection.index, -1, 'the entities are hidden: nothing to pick there');
    SpriteRenderer.layerMask[1] = bit('entities') | bit('props');
    layers.setLocked(Layer.getId('props'), false);
    selection.pickAt(100, 100);
    assert.equal(selection.index, 2, 'props unlocked: the smaller one again');
    selection.pickAt(100, 100);
    assert.equal(selection.index, 1, 'and the next: its entities layer is hidden, but it draws in props too');
    editMode.exit();
    assert.equal(layers.unpickable(1), false, 'out of edit mode nothing is hidden');
  } finally {
    done(editMode);
    Layer.reset();
  }
});

test('the move tool does not move a locked layer’s entity, nor keep it on a press', () => {
  initLayers();
  initSoA();
  const { editMode } = makeEditor();
  const { selection, layers } = editMode;
  try {
    entity(1, 100, 100);
    editMode.enter();
    selection.select(1);
    assert.equal(selection.name, 'Crate1');
    layers.setLocked(Layer.entitiesId, true);
    assert.equal(editMode.move.nudge(1, 0), false);
    assert.equal(editMode.status, 'Crate1 is on a locked layer (entities)');
    assert.equal(editMode.statusIsError, true);
    editMode.move.press(100, 100, 0, 0);
    assert.equal(selection.index, -1, 'a press there does not keep it: nothing pickable under it');
    layers.setLocked(Layer.entitiesId, false);
    selection.select(1);
    let moved = null;
    editMode.editSelected = (label) => (moved = label);
    assert.equal(editMode.move.nudge(1, 0), true);
    assert.equal(moved, 'move Crate1', 'unlocked, it moves');
  } finally {
    done(editMode);
    Layer.reset();
  }
});

// ---- the DOM: the scene list's mark, the palette's rows ----

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.checked = false;
    this.title = '';
    this.type = '';
    this.className = '';
    this.clientHeight = 400;
    this.scrollTop = 0;
    this._text = '';
  }
  appendChild(node) {
    this.children.push(node);
    return node;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  addEventListener() {}
  removeEventListener() {}
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
}

test('the scene list marks a locked layer’s entities, at once', () => {
  initLayers();
  initSoA();
  const { editMode, scene, debugUI } = makeEditor();
  globalThis.document = { createElement: (tag) => new El(tag), addEventListener() {}, removeEventListener() {} };
  try {
    entity(1, 100, 100);
    entity(2, 300, 100, ['props']);
    entity(5, 500, 100, ['props']); // runtime
    const Crate = { name: 'Crate', startIndex: 0, poolSize: 8, endIndex: 8 };
    scene.registeredClasses = [{ class: Crate }];
    const tree = new EntityTree(debugUI);
    debugUI.hosted = { tree };
    tree.attach(scene);
    tree.model.groups[0].open = true;
    tree.render();
    const texts = () => tree._rows.filter((r) => r.style.display !== 'none').map((r) => r.textContent);
    assert.deepEqual(texts(), ['▾ Crate  ·  2 placed, 1 runtime', 'Crate1  #1', 'Lamp1  #2', '#5  runtime']);
    editMode.layers.setLocked(Layer.getId('props'), true);
    assert.deepEqual(texts(), ['▾ Crate  ·  2 placed, 1 runtime', 'Crate1  #1', 'Lamp1  #2  🔒 locked', '#5  runtime  🔒 locked']);
  } finally {
    done(editMode);
    Layer.reset();
  }
});

test('the palette’s Layers section: a row per layer with hide and lock, built once per scene', () => {
  initLayers();
  const { editMode } = makeEditor();
  globalThis.document = { createElement: (tag) => new El(tag), addEventListener() {}, removeEventListener() {} };
  try {
    const palette = new Palette(editMode);
    palette._files = new El('div');
    palette._layers = new El('div');
    palette._list = new El('div');
    editMode.palette = palette;
    palette.refresh();
    const rows = palette._layers.children.slice(1);
    assert.deepEqual(rows.map((r) => r.dataset.layer), ['props', 'entities', 'ground']);
    const switches = (row) => [...row.all()].filter((el) => el.type === 'checkbox').map((el) => el.dataset.switch);
    assert.deepEqual(switches(rows[0]), ['hide', 'lock']);
    assert.deepEqual(switches(rows[2]), ['hide'], 'a tilemap holds no entities: nothing to lock');
    const [hide, lock] = [...rows[0].all()].filter((el) => el.type === 'checkbox');
    lock.checked = true;
    lock.onchange();
    assert.equal(editMode.layers.isLocked(Layer.getId('props')), true);
    hide.checked = true;
    hide.onchange();
    assert.equal(editMode.active, false, 'in its own page the palette shows only while editing');
    assert.equal(editMode.layers.isHidden(Layer.getId('props')), true);
    const built = palette._layers.children[1];
    palette.refresh();
    assert.equal(palette._layers.children[1], built, 'a refresh of the same scene keeps the rows');
    editMode.layers.reset();
    palette.refresh();
    assert.notEqual(palette._layers.children[1], built, 'another scene: built again');
    assert.equal([...palette._layers.children[1].all()].find((el) => el.dataset.switch === 'lock').checked, false);
  } finally {
    done(editMode);
    Layer.reset();
  }
});

test('in the editor page, hiding a layer while the game plays enters edit mode, as the palette’s + does', () => {
  initLayers();
  initSoA();
  const { editMode, debugUI } = makeEditor();
  try {
    debugUI.hosted = { tree: null, onEditorChanged() {}, onPlay() {}, onDocumentChanged() {}, onSelectionChanged() {} };
    const props = Layer.get('props');
    editMode.layers.setHidden(props.id, true);
    assert.equal(editMode.active, true);
    assert.equal(props.visible, false);
    editMode.layers.setHidden(props.id, false);
    assert.equal(props.visible, true);
  } finally {
    done(editMode);
    Layer.reset();
  }
});

test('EditorLayers alone: no scene, no layers, nothing to do', () => {
  Layer.reset();
  const layers = new EditorLayers({ active: true, debugUI: { scene: null } });
  layers.setHidden(3, true);
  layers.apply();
  layers.restore();
  assert.equal(layers.unpickable(0), false);
  assert.equal(layers.isHidden(3), true);
});
