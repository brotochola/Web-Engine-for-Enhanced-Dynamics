// The debug UI's time controls (VISUAL_EDITOR_PLAN.md ED-14): a speed slider (Time.scale; while editing, the speed
// leaving edit mode plays at), and Step, one frame of the paused game through the workers' step message.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Scene } from '../../src/core/scene.js';
import { Time } from '../../src/core/timeScale.js';
import { EditMode } from '../../src/core/debug/editor/editMode.js';
import { ScenePanel } from '../../src/core/debug/panels/scenePanel.js';

function pausedScene(paused) {
  const scene = Object.create(Scene.prototype);
  const calls = [];
  scene.state = { pause: paused };
  scene._steppingPaused = false;
  scene.workers = {
    logicWorkers: ['logic0', 'logic1'],
    physics: 'physics',
    spatialWorkers: ['spatial0'],
    particle: 'particle',
    preRenderWorkers: ['preRender0'],
    renderer: 'pixi',
  };
  scene.updateInternal = (dt) => calls.push(`page ${dt}`);
  scene._stepWorkerGroup = async (group, dt) => {
    calls.push(`${group.join('+') || 'none'} ${dt}`);
  };
  return { scene, calls };
}

test('Step runs one frame of a paused scene, page first, then the workers in pipeline order', async () => {
  const { scene, calls } = pausedScene(true);
  assert.equal(await scene.stepPaused(), true);
  assert.deepEqual(calls, [
    'page 16.67',
    'logic0+logic1 16.67',
    'physics 16.67',
    'spatial0 16.67',
    'particle 16.67',
    'preRender0 16.67',
    'pixi 16.67',
  ]);
});

test('Step is refused while the game runs, and while a step is still running', async () => {
  const running = pausedScene(false);
  assert.equal(await running.scene.stepPaused(), false);
  assert.deepEqual(running.calls, []);
  const { scene, calls } = pausedScene(true);
  const first = scene.stepPaused();
  assert.equal(await scene.stepPaused(), false, 'a second click while the first frame runs');
  assert.equal(await first, true);
  assert.equal(calls.filter((c) => c.startsWith('page')).length, 1);
});

function editor() {
  Time.bind(new SharedArrayBuffer(4));
  Time.scale = 1;
  const debugUI = {
    scene: {},
    tools: { deactivateAll() {}, updateToolIndicator() {}, _syncDebugToolFlag() {} },
    panels: { scene: { updateEditButton() {} } },
    _ensureTickLoop() {},
    gameEngine: { canvas: {} },
  };
  const editMode = new EditMode(debugUI);
  editMode.palette = { show() {}, hide() {}, refresh() {}, destroy() {} };
  return editMode;
}

test('the play speed is Time.scale; while editing it is the speed leaving edit mode plays at', () => {
  const editMode = editor();
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  try {
    editMode.playSpeed = 0.5;
    assert.equal(Time.scale, 0.5);
    editMode.playSpeed = 9;
    assert.equal(Time.scale, 4, 'at most MAX_TIME_SCALE');
    editMode.playSpeed = 0.25;
    editMode.enter();
    assert.equal(Time.scale, 0, 'edit mode holds the world');
    assert.equal(editMode.playSpeed, 0.25);
    editMode.playSpeed = 2;
    assert.equal(Time.scale, 0, 'still held');
    editMode.exit();
    assert.equal(Time.scale, 2, 'leaving plays at the speed set while editing');
  } finally {
    delete globalThis.document;
  }
});

// ---- the panel, against a fake DOM ----

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.classList = { set: new Set(), toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); } };
  }
  appendChild(node) {
    this.children.push(node);
    return node;
  }
}

test('the Scene panel: the slider sets the speed, a tick shows a speed set elsewhere, Step only while paused', () => {
  globalThis.document = { createElement: (tag) => new El(tag) };
  try {
    const steps = [];
    const debugUI = {
      editing: false,
      playSpeed: 1,
      scene: { state: { pause: false }, stepPaused: () => steps.push('step') },
      registeredScenes: [],
    };
    const panel = new ScenePanel(debugUI);
    panel.create();
    const { speedSlider, speedText, stepBtn } = panel.elements;
    speedSlider.value = '0.35';
    speedSlider.oninput();
    assert.equal(debugUI.playSpeed, 0.35);
    assert.equal(speedText.textContent, '0.35×');
    debugUI.playSpeed = 0; // a game's hitstop
    panel.update();
    assert.deepEqual([speedSlider.value, speedText.textContent], ['0', '0.00×']);
    assert.equal(stepBtn.disabled, true, 'running: no step');
    debugUI.scene.state.pause = true;
    panel.update();
    assert.equal(stepBtn.disabled, false);
    stepBtn.onclick();
    assert.deepEqual(steps, ['step']);
    debugUI.editing = true;
    panel.updateEditButton();
    assert.equal(stepBtn.disabled, true, 'editing: the world is held');
  } finally {
    delete globalThis.document;
  }
});
