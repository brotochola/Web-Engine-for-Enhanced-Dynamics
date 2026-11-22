/**
 * DBG-4: the debug UI's Layers panel lists every layer the scene registered (built-in, engine-made such as
 * volumeShadows, custom, SCREEN, GPU particles), says what each one is, and its controls follow changes made by game
 * code. The panel runs against the real Layer table (initializeFromConfig) and a small DOM shim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Layer } from '../../src/core/layer.js';
import { DEFAULT_LAYERS, LAYER_KIND } from '../../src/util/configDefaults.js';
import { LayersPanel, layerDetailsText } from '../../src/core/debug/panels/layersPanel.js';

class El {
  constructor(tag) {
    this.tagName = tag;
    this.className = '';
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this.textContent = '';
    this.title = '';
    this.type = '';
    this.value = '';
    this.min = '';
    this.max = '';
    this.step = '';
    this.checked = false;
    this.disabled = false;
    this.onchange = null;
    this.oninput = null;
    this.onblur = null;
    this.onclick = null;
  }
  get firstChild() { return this.children[0] ?? null; }
  get nextSibling() {
    const list = this.parentNode ? this.parentNode.children : null;
    if (!list) return null;
    return list[list.indexOf(this) + 1] ?? null;
  }
  get options() { return this.children.filter((c) => c.tagName === 'option'); }
  set innerHTML(_html) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
  }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    node.parentNode = null;
    return node;
  }
}

const BUILT_INS = {
  ...DEFAULT_LAYERS,
  entities: { ...DEFAULT_LAYERS.entities, ySorting: true },
};

// One layer of each kind the panel used to miss or mislabel: an engine-made MESH (Scene._applyVolumeConfig's
// volumeShadows), GPU particles, a SCREEN pass, a look layer, and two sprite layers (one sorted, one not).
const LAYERS = {
  volumeShadows: { zIndex: 1.5, kind: LAYER_KIND.MESH, sunProjected: true, volumeFloor: true },
  props: { zIndex: 3.2 },
  trees: { zIndex: 3.5, ySorting: true },
  sparks: { zIndex: 6, kind: LAYER_KIND.GPU_PARTICLES, sortWithEntities: true },
  water: { zIndex: 7, shader: { fragment: 'void main() {}' } },
  crt: { zIndex: 20, kind: LAYER_KIND.SCREEN, shader: { fragment: 'void main() {}' } },
};

function setup({ sources = {} } = {}) {
  globalThis.document = {
    activeElement: null,
    createElement(tag) { return new El(tag); },
  };
  Layer.reset();
  Layer.initializeFromConfig(LAYERS, BUILT_INS);
  const debugUI = {
    scene: {
      config: { lighting: { enabled: true, shadowsEnabled: true }, particle: { decals: true } },
      _loadedShaderSources: sources,
    },
  };
  const panel = new LayersPanel(debugUI);
  panel.create();
  panel.attach();
  return panel;
}

function rowNames(panel) {
  return panel.panel.children.slice(1).map((w) => w.dataset.layerName);
}

function controls(panel, name) {
  return panel.elements.layerControls[name];
}

test('a row per registered layer, engine-made, SCREEN and GPU particle ones included, highest z first', () => {
  const panel = setup();
  try {
    const names = Layer.getAll().map((l) => l.name);
    assert.deepEqual(new Set(rowNames(panel)), new Set(names));
    for (const name of ['volumeShadows', 'sparks', 'crt', 'lightGlows']) assert.ok(rowNames(panel).includes(name), name);
    const zs = rowNames(panel).map((n) => Layer.get(n).zIndex);
    assert.deepEqual(zs, zs.slice().sort((a, b) => b - a));
    assert.equal(rowNames(panel)[0], 'crt');
  } finally {
    Layer.reset();
  }
});

test('the details line says what a layer is: kind, target, queue, sun projection, GPU particle options', () => {
  const panel = setup();
  try {
    const details = (name) => controls(panel, name).details.textContent;
    // sunProjected takes alphaBySun 'shadow' unless its config says otherwise (normalizeAlphaBySun).
    assert.match(details('volumeShadows'), /^mesh · Res 1\.000x linear · sunProjected · volumeFloor · alphaBySun shadow$/);
    assert.match(details('sparks'), /^gpuParticles · .* · gpuParticles sortWithEntities$/);
    assert.match(details('trees'), /^sprites · Res 1\.000x linear · maxItems 5000$/);
    assert.match(details('water'), /Density sprites/);
    assert.match(details('crt'), /^screen /);
    assert.match(details('entities'), /^sprites \(built-in\)/);
    const meta = { maxItems: 0, alphaBySun: { from: 0.2, to: 0.8 }, worldRect: { width: 64, height: 32 }, shaderCache: true };
    assert.match(layerDetailsText(Layer.get('props'), meta), /alphaBySun 0\.2\.\.0\.8 · worldRect 64×32 cached$/);
  } finally {
    Layer.reset();
  }
});

test('the controls follow changes made by game code, and leave a focused control alone', () => {
  const panel = setup();
  try {
    const trees = Layer.get('trees');
    trees.alpha = 0.25;
    trees.visible = false;
    trees.blendMode = 'add';
    Layer.get('water').containerBlendMode = 'screen';
    trees.resolution = 0.5;
    panel.update();
    const c = controls(panel, 'trees');
    assert.equal(c.alpha.value, '25');
    assert.equal(c.alphaValue.textContent, '25%');
    assert.equal(c.visible.checked, false);
    assert.equal(c.blendMode.value, 'add');
    assert.equal(controls(panel, 'water').containerBlend.value, 'screen');
    assert.match(c.details.textContent, /Res 0\.500x/);

    document.activeElement = c.alpha;
    trees.alpha = 0.75;
    panel.update();
    assert.equal(c.alpha.value, '25', 'the slider being dragged keeps its value');
    document.activeElement = null;
    panel.update();
    assert.equal(c.alpha.value, '75');
  } finally {
    Layer.reset();
  }
});

test('a z set by game code moves the row; a z typed in the panel moves it once the field loses focus', () => {
  const panel = setup();
  try {
    Layer.get('props').zIndex = 9;
    panel.update();
    assert.equal(controls(panel, 'props').zIndex.value, '9');
    assert.deepEqual(rowNames(panel).slice(0, 2), ['crt', 'props']);

    const z = controls(panel, 'volumeShadows').zIndex;
    document.activeElement = z;
    z.value = '15';
    z.onchange();
    panel.update();
    assert.equal(Layer.get('volumeShadows').zIndex, 15);
    assert.deepEqual(rowNames(panel).slice(0, 2), ['crt', 'props'], 'no re-sort while the field is edited');
    document.activeElement = null;
    z.onblur();
    assert.deepEqual(rowNames(panel).slice(0, 2), ['crt', 'volumeShadows']);
  } finally {
    Layer.reset();
  }
});

test('Y-Sort goes through the Layer setter, only where the scene reserved a painter', () => {
  const panel = setup();
  try {
    const trees = controls(panel, 'trees').ySorting;
    assert.equal(trees.disabled, false);
    assert.equal(trees.checked, true);
    trees.checked = false;
    trees.onchange();
    assert.equal(Layer.get('trees').ySorting, false);
    Layer.get('trees').ySorting = true;
    panel.update();
    assert.equal(trees.checked, true);

    assert.equal(controls(panel, 'entities').ySorting.disabled, false, 'renderer.ySort reserved the entities\' painter');
    const props = controls(panel, 'props').ySorting;
    assert.equal(props.disabled, true);
    assert.match(props.title, /started unsorted/);
    assert.match(controls(panel, 'volumeShadows').ySorting.title, /no sprite queue/);
    assert.throws(() => { Layer.get('props').ySorting = true; }, /"props" cannot sort by y at run time: it started unsorted/);
    assert.throws(() => { Layer.get('sparks').ySorting = true; }, /it has no sprite queue/);
    Layer.get('props').ySorting = false;
    assert.equal(Layer.get('props').ySorting, false, 'turning an unsorted layer off is allowed');
  } finally {
    Layer.reset();
  }
});

test('Cont Blend shows every layer\'s value and is disabled, with the reason, where it cannot apply', () => {
  const panel = setup();
  try {
    assert.equal(controls(panel, 'water').containerBlend.disabled, false);
    assert.match(controls(panel, 'entities').containerBlend.title, /Built-in layers/);
    assert.equal(controls(panel, 'entities').containerBlend.disabled, true);
    assert.equal(controls(panel, 'props').containerBlend.disabled, true);
    assert.match(controls(panel, 'props').containerBlend.title, /No look shader/);
    const lighting = controls(panel, 'lighting').blendMode;
    assert.equal(lighting.disabled, true, 'the light\'s blend stays off after attach and ticks');
    assert.match(lighting.title, /multiplies the scene/);
  } finally {
    Layer.reset();
  }
});

test('a scene without shaders does not rebuild the rows and options every tick', () => {
  const panel = setup({ sources: {} });
  try {
    let rebuilds = 0;
    const original = panel._updateLayersAvailability.bind(panel);
    panel._updateLayersAvailability = () => {
      rebuilds++;
      original();
    };
    for (let i = 0; i < 5; i++) panel.update();
    assert.equal(rebuilds, 0);
    panel.debugUI.scene._loadedShaderSources = { glow: 'void main() {}' };
    panel.update();
    panel.update();
    assert.equal(rebuilds, 1, 'a new set of sources rebuilds the options once');
    assert.ok(controls(panel, 'water').shader.options.some((o) => o.value === 'glow'));
  } finally {
    Layer.reset();
  }
});
