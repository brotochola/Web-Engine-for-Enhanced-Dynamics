// The sprite and animation params' picker (VISUAL_EDITOR_PLAN.md D4, ED-45): its choices are what the running scene
// loaded (the atlas's entries for a sprite, the spritesheets' animations for an animation, each once with the sheets
// that have it), with a thumbnail of the name's first frame drawn from the atlas when the name changes. Any name can
// still be typed; one the scene did not load is marked. A pick from the list commits at once, typing when the field
// is left.
import test from 'node:test';
import assert from 'node:assert/strict';

import { SpriteSheetRegistry, bigAtlasChunkName } from '../../src/core/spriteSheetRegistry.js';
import { describeSpawnParams, KIND_SPRITE, KIND_ANIMATION } from '../../src/core/spawnParams.js';
import { AssetCatalog, assetPickerWidget, THUMB_SIZE } from '../../src/core/debug/editor/assetPicker.js';
import { buildParamFields } from '../../src/core/debug/editor/paramWidgets.js';

const FRAMES = {
  _empty: { x: 0, y: 0, w: 1, h: 1 },
  _white: { x: 2, y: 0, w: 8, h: 8 },
  barrel: { x: 20, y: 0, w: 16, h: 32 },
  bunny: { x: 40, y: 0, w: 26, h: 37 },
  civil1_walk_down_0: { x: 0, y: 40, w: 64, h: 64 },
  civil1_walk_down_1: { x: 64, y: 40, w: 64, h: 64 },
  civil1_walk_left_0: { x: 128, y: 40, w: 64, h: 64 },
  civil2_walk_left_0: { x: 192, y: 40, w: 64, h: 64 },
};

function proxy(sheet, names) {
  const animations = {};
  const indexToName = {};
  names.forEach((name, index) => {
    animations[name] = { originalName: name, prefixedName: `${sheet}_${name}`, index };
    indexToName[index] = name;
  });
  return { isProxy: true, targetSheet: 'bigAtlas', prefix: `${sheet}_`, animations, indexToName };
}

/** The registry as a scene's load leaves it: the atlas, then a proxy per spritesheet. */
function loadAtlas() {
  SpriteSheetRegistry.clearForSceneUnload();
  const json = {
    frames: Object.fromEntries(Object.entries(FRAMES).map(([name, frame]) => [name, { frame, sourceSize: { w: frame.w, h: frame.h } }])),
    animations: {
      _empty: ['_empty'],
      barrel: ['barrel'],
      bunny: ['bunny'],
      civil1_walk_down: ['civil1_walk_down_0', 'civil1_walk_down_1'],
      civil1_walk_left: ['civil1_walk_left_0'],
      civil2_walk_left: ['civil2_walk_left_0'],
      _white: ['_white'],
    },
    meta: {},
  };
  SpriteSheetRegistry.register('bigAtlas', json);
  SpriteSheetRegistry.registerProxy('civil1', proxy('civil1', ['walk_down', 'walk_left']));
  SpriteSheetRegistry.registerProxy('civil2', proxy('civil2', ['walk_left']));
  return json;
}

/** A 2D context that records what is drawn. */
function recorder() {
  const calls = [];
  return {
    calls,
    imageSmoothingEnabled: true,
    clearRect: (...args) => calls.push(['clear', ...args]),
    drawImage: (...args) => calls.push(['draw', ...args]),
  };
}

test('the choices: the atlas’s sprites (the engine’s own last), and each animation once with its sheets', () => {
  loadAtlas();
  const catalog = new AssetCatalog(() => null);
  assert.deepEqual(
    catalog.options(KIND_SPRITE).map(([name]) => name),
    ['barrel', 'bunny', 'civil1_walk_down', 'civil1_walk_left', 'civil2_walk_left', '_empty', '_white'],
  );
  assert.deepEqual(catalog.options(KIND_ANIMATION), [
    ['walk_down', 'civil1'],
    ['walk_left', 'civil1, civil2'],
  ]);
  assert.equal(catalog.has(KIND_SPRITE, 'bunny'), true);
  assert.equal(catalog.has(KIND_SPRITE, 'walk_left'), false, 'an animation is not a sprite name');
  assert.equal(catalog.has(KIND_ANIMATION, 'walk_left'), true);
  assert.equal(catalog.has(KIND_ANIMATION, 'run'), false);
  assert.equal(catalog.frameOf(KIND_SPRITE, 'civil1_walk_down'), 'civil1_walk_down_0', 'a sheet’s animation shows its first frame');
  assert.equal(catalog.frameOf(KIND_ANIMATION, 'walk_left'), 'civil1_walk_left_0', 'the first sheet that has it');
  assert.equal(catalog.frameOf(KIND_ANIMATION, 'run'), null);

  // bigAtlas's chunk sheets (ED-74: indices past 255) are proxy sheets of the atlas's own names, not animations.
  const chunk = new AssetCatalog(() => null);
  SpriteSheetRegistry.registerProxy(bigAtlasChunkName(1), {
    isProxy: true,
    targetSheet: 'bigAtlas',
    prefix: '',
    animations: { bunny: { originalName: 'bunny', prefixedName: 'bunny', index: 0 } },
    indexToName: { 0: 'bunny' },
  });
  assert.deepEqual(chunk.options(KIND_ANIMATION), [
    ['walk_down', 'civil1'],
    ['walk_left', 'civil1, civil2'],
  ]);
  assert.equal(chunk.has(KIND_ANIMATION, 'bunny'), false);

  // A full load registers another atlas: the lists follow.
  SpriteSheetRegistry.clearForSceneUnload();
  SpriteSheetRegistry.register('bigAtlas', { frames: {}, animations: { rock: ['rock'] }, meta: {} });
  assert.deepEqual(catalog.options(KIND_SPRITE), [['rock', '']]);
  assert.deepEqual(catalog.options(KIND_ANIMATION), []);
  SpriteSheetRegistry.clearForSceneUnload();
  assert.deepEqual(catalog.options(KIND_SPRITE), [], 'no atlas: nothing to offer');
});

test('the thumbnail: the first frame from the atlas, scaled to fit and centered; nothing for an unknown name', () => {
  const json = loadAtlas();
  const atlas = { tagName: 'CANVAS' };
  const catalog = new AssetCatalog(() => ({ bigAtlasCanvas: atlas, bigAtlasJson: json }));
  const ctx = recorder();
  const canvas = { width: THUMB_SIZE, height: THUMB_SIZE, getContext: () => ctx };
  assert.equal(catalog.drawThumbnail(canvas, KIND_SPRITE, 'barrel'), true);
  // 16 × 32 into 28 × 28: 14 × 28, centered.
  assert.deepEqual(ctx.calls, [
    ['clear', 0, 0, 28, 28],
    ['draw', atlas, 20, 0, 16, 32, 7, 0, 14, 28],
  ]);
  assert.equal(ctx.imageSmoothingEnabled, true, 'drawn smaller: smoothed');
  ctx.calls.length = 0;
  assert.equal(catalog.drawThumbnail(canvas, KIND_SPRITE, '_white'), true);
  assert.deepEqual(ctx.calls[1], ['draw', atlas, 2, 0, 8, 8, 0, 0, 28, 28]);
  assert.equal(ctx.imageSmoothingEnabled, false, 'drawn larger: crisp');
  ctx.calls.length = 0;
  assert.equal(catalog.drawThumbnail(canvas, KIND_ANIMATION, 'walk_left'), true);
  assert.deepEqual(ctx.calls[1].slice(2, 6), [128, 40, 64, 64]);
  ctx.calls.length = 0;
  assert.equal(catalog.drawThumbnail(canvas, KIND_SPRITE, 'nope'), false);
  assert.deepEqual(ctx.calls, [['clear', 0, 0, 28, 28]], 'cleared, nothing drawn');
  const noAtlas = new AssetCatalog(() => null);
  assert.equal(noAtlas.drawThumbnail(canvas, KIND_SPRITE, 'barrel'), false, 'no scene: nothing to draw from');
});

// ---- the field, against a fake DOM ----

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.value = '';
    this.title = '';
    this.type = '';
    this.id = '';
    this.width = 0;
    this.height = 0;
    this._text = '';
    this._ctx = tag === 'canvas' ? recorder() : null;
  }
  appendChild(node) {
    this.children.push(node);
    return node;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getContext() {
    return this._ctx;
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

function withDocument(fn) {
  globalThis.document = { createElement: (tag) => new El(tag) };
  try {
    return fn();
  } finally {
    delete globalThis.document;
  }
}

test('the field: the scene’s names as its list, its thumbnail, a pick commits at once, typing on leaving', () =>
  withDocument(() => {
    const json = loadAtlas();
    const catalog = new AssetCatalog(() => ({ bigAtlasCanvas: {}, bigAtlasJson: json }));
    const commits = [];
    const box = assetPickerWidget(KIND_SPRITE, 'barrel', (v) => commits.push(v), catalog);
    const input = box.find((el) => el.tagName === 'INPUT');
    assert.equal(box.find((el) => el.tagName === 'DATALIST'), null, 'no list in the page until the field gets the focus');
    input.onfocus();
    const list = box.find((el) => el.tagName === 'DATALIST');
    const thumb = box.find((el) => el.tagName === 'CANVAS');
    assert.equal(input.value, 'barrel');
    assert.equal(input.attributes.list, list.id, 'the input suggests from its list');
    assert.match(list.id, /^weed-editor-sprites-\d+$/);
    assert.deepEqual(list.children.map((o) => o.value).slice(0, 2), ['barrel', 'bunny']);
    assert.equal(thumb._ctx.calls.filter((c) => c[0] === 'draw').length, 1, 'drawn once, when built');

    input.value = 'bun';
    input.oninput({ inputType: 'insertText' });
    assert.equal(input.style.borderColor, '#f87171', 'not a name the scene loaded (yet)');
    assert.deepEqual(commits, [], 'typing does not commit');
    input.value = 'bunny';
    input.oninput({ inputType: 'insertReplacementText' });
    assert.deepEqual(commits, ['bunny'], 'a pick from the list commits');
    assert.equal(input.style.borderColor, '');
    assert.deepEqual(thumb._ctx.calls.filter((c) => c[0] === 'draw').at(-1).slice(2, 6), [40, 0, 26, 37], 'its frame');

    input.value = 'my_sprite';
    input.oninput({ inputType: 'insertReplacementText' });
    assert.deepEqual(commits, ['bunny'], 'a name the scene lacks is not a pick');
    input.onchange();
    assert.deepEqual(commits, ['bunny', 'my_sprite'], 'typed: committed when the field is left, marked');
    assert.match(input.title, /no sprite of that name/);
    input.value = '_white';
    input.oninput({});
    assert.deepEqual(commits.at(-1), '_white', 'older Chrome sends a pick as a plain event');

    const plain = assetPickerWidget(KIND_SPRITE, 'x', (v) => commits.push(v), null);
    assert.equal(plain.find((el) => el.tagName === 'DATALIST'), null, 'no catalog: a text field');
  }));

test('the panel builds the picker for sprite and animation params, a text field for a string', () =>
  withDocument(() => {
    const json = loadAtlas();
    class Walker {}
    Walker.spawnParams = {
      look: { value: 'barrel', type: 'sprite' },
      anim: { value: 'walk_down', type: 'animation' },
      next: { value: '' },
    };
    const container = new El('div');
    const changes = [];
    buildParamFields(container, describeSpawnParams(Walker), { anim: 'walk_left' }, {
      onChange: (key, value) => changes.push([key, value]),
      onConfig() {},
      entityNames: () => [],
      assets: new AssetCatalog(() => ({ bigAtlasCanvas: {}, bigAtlasJson: json })),
    });
    const row = (key) => container.children.find((r) => r.dataset.key === key);
    const anim = row('anim');
    anim.find((el) => el.tagName === 'INPUT').onfocus();
    const options = anim.find((el) => el.tagName === 'DATALIST').children;
    assert.deepEqual(options.map((o) => [o.value, o.textContent]), [['walk_down', 'civil1'], ['walk_left', 'civil1, civil2']]);
    assert.equal(anim.find((el) => el.tagName === 'INPUT').value, 'walk_left');
    assert.match(anim.textContent, /default walk_down/);
    assert.ok(row('look').find((el) => el.tagName === 'CANVAS'), 'a sprite has its thumbnail');
    assert.equal(row('next').find((el) => el.tagName === 'DATALIST'), null, 'a string stays a text field');
    const pick = anim.find((el) => el.tagName === 'INPUT');
    pick.value = 'walk_down';
    pick.oninput({ inputType: 'insertReplacementText' });
    assert.deepEqual(changes, [['anim', 'walk_down']]);
  }));
