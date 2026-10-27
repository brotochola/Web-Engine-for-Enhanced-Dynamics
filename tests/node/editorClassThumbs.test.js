// The palette's class pictures (VISUAL_EDITOR_PLAN.md ED-65): the first frame of what a live entity of the class
// shows (its SpriteRenderer's sprite or animation, stretched by its scale, with its tint), else its spawnParams' sprite
// or animation default, else a mark with its initials. Each class is drawn once per scene; a refresh draws again only
// a class that showed its mark and now has a picture.
import test from 'node:test';
import assert from 'node:assert/strict';

import { SpriteSheetRegistry, bigAtlasChunkName } from '../../src/core/spriteSheetRegistry.js';
import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { AssetCatalog } from '../../src/core/debug/editor/assetPicker.js';
import { spriteFrameOf, atlasEntryOf, animationNameOf, drawAtlasFrame, NO_TINT } from '../../src/core/debug/editor/atlasThumb.js';
import {
  classPicture,
  livePictureOf,
  initialsOf,
  markColor,
  drawClassMark,
  ClassThumbs,
  CLASS_THUMB_SIZE,
  PICTURE_MARK,
  PICTURE_PARAM,
  PICTURE_LIVE,
} from '../../src/core/debug/editor/classThumbs.js';

const N = 32;

const FRAMES = {
  _white: { x: 2, y: 0, w: 8, h: 8 },
  barrel: { x: 20, y: 0, w: 16, h: 32 },
  civil1_walk_down_0: { x: 0, y: 40, w: 64, h: 64 },
  civil1_walk_down_1: { x: 64, y: 40, w: 64, h: 64 },
  civil1_walk_left_0: { x: 128, y: 40, w: 64, h: 64 },
};

/** The registry as a load leaves it: the atlas (sheet id 1), then the civil1 proxy (sheet id 2). */
function loadAtlas() {
  SpriteSheetRegistry.clearForSceneUnload();
  const json = {
    frames: Object.fromEntries(Object.entries(FRAMES).map(([name, frame]) => [name, { frame, sourceSize: { w: frame.w, h: frame.h } }])),
    animations: {
      _white: ['_white'],
      barrel: ['barrel'],
      civil1_walk_down: ['civil1_walk_down_0', 'civil1_walk_down_1'],
      civil1_walk_left: ['civil1_walk_left_0'],
    },
    meta: {},
  };
  SpriteSheetRegistry.register('bigAtlas', json);
  const animations = {
    walk_down: { originalName: 'walk_down', prefixedName: 'civil1_walk_down', index: 0 },
    walk_left: { originalName: 'walk_left', prefixedName: 'civil1_walk_left', index: 1 },
  };
  SpriteSheetRegistry.registerProxy('civil1', {
    isProxy: true,
    targetSheet: 'bigAtlas',
    prefix: 'civil1_',
    animations,
    indexToName: { 0: 'walk_down', 1: 'walk_left' },
  });
  return json;
}

function initSoA() {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(N)), N);
}

/** Entity `i` live with a sprite: sheet id and animation index, as setSprite or setSpritesheet + setAnimation write them. */
function live(i, sheet, animation, { scaleX = 1, scaleY = 1, tint = 0xffffff, visible = 1 } = {}) {
  Transform.active[i] = 1;
  SpriteRenderer.active[i] = 1;
  SpriteRenderer.spritesheetId[i] = sheet;
  SpriteRenderer.animationState[i] = animation;
  SpriteRenderer.scaleX[i] = scaleX;
  SpriteRenderer.scaleY[i] = scaleY;
  SpriteRenderer.baseTint[i] = tint;
  SpriteRenderer.renderVisible[i] = visible;
}

/** A 2D context that records what is drawn, and the canvas state of each call. */
function recorder() {
  const calls = [];
  const ctx = {
    calls,
    imageSmoothingEnabled: true,
    globalCompositeOperation: 'source-over',
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    clearRect: (...args) => calls.push(['clear', ...args]),
    drawImage: (...args) => calls.push(['draw', ctx.globalCompositeOperation, ...args.slice(1)]),
    fillRect: (...args) => calls.push(['fill', ctx.globalCompositeOperation, ctx.fillStyle, ...args]),
    fillText: (...args) => calls.push(['text', ...args]),
  };
  return ctx;
}

function canvas(size = CLASS_THUMB_SIZE) {
  const ctx = recorder();
  return { width: size, height: size, style: {}, dataset: {}, title: '', ctx, getContext: () => ctx };
}

function withCanvases(fn) {
  const made = [];
  globalThis.document = {
    createElement: (tag) => {
      assert.equal(tag, 'canvas');
      const c = canvas();
      made.push(c);
      return c;
    },
  };
  try {
    return fn(made);
  } finally {
    delete globalThis.document;
  }
}

test('a sprite’s first frame from its columns: a static sprite of the atlas, a spritesheet animation’s first', () => {
  loadAtlas();
  const atlas = SpriteSheetRegistry.getSpritesheetId('bigAtlas');
  const civil1 = SpriteSheetRegistry.getSpritesheetId('civil1');
  assert.equal(spriteFrameOf(atlas, SpriteSheetRegistry.getAnimationIndex('bigAtlas', 'barrel')), 'barrel');
  assert.equal(spriteFrameOf(civil1, 0), 'civil1_walk_down_0', 'walk_down: its first frame');
  assert.equal(spriteFrameOf(civil1, 1), 'civil1_walk_left_0');
  assert.equal(spriteFrameOf(civil1, 9), null, 'no such animation');
  assert.equal(spriteFrameOf(0, 0), null, 'no sheet');
  assert.equal(spriteFrameOf(77, 0), null, 'an id the registry does not have');
});

test('what a sprite shows, as a param holds it: the atlas entry (a sprite), the animation’s own name (an animation)', () => {
  loadAtlas();
  // A chunk of the atlas (ED-74): its names are the atlas's sprites.
  SpriteSheetRegistry.registerProxy(bigAtlasChunkName(1), {
    isProxy: true,
    targetSheet: 'bigAtlas',
    prefix: '',
    animations: { barrel: { originalName: 'barrel', prefixedName: 'barrel', index: 0 } },
    indexToName: { 0: 'barrel' },
  });
  const atlas = SpriteSheetRegistry.getSpritesheetId('bigAtlas');
  const civil1 = SpriteSheetRegistry.getSpritesheetId('civil1');
  const chunk = SpriteSheetRegistry.getSpritesheetId(bigAtlasChunkName(1));
  const barrel = SpriteSheetRegistry.getAnimationIndex('bigAtlas', 'barrel');
  assert.deepEqual(
    [atlasEntryOf(atlas, barrel), atlasEntryOf(civil1, 1), atlasEntryOf(chunk, 0), atlasEntryOf(civil1, 9), atlasEntryOf(0, 0)],
    ['barrel', 'civil1_walk_left', 'barrel', null, null],
  );
  assert.deepEqual(
    [animationNameOf(civil1, 0), animationNameOf(civil1, 1), animationNameOf(atlas, barrel), animationNameOf(chunk, 0), animationNameOf(77, 0)],
    ['walk_down', 'walk_left', null, null, null],
    'a static sprite (the atlas or a chunk of it) plays no animation',
  );
});

test('the picture’s source: a live entity first, else a sprite or animation param’s default, else the mark', () => {
  loadAtlas();
  initSoA();
  const catalog = new AssetCatalog(() => null);
  class Crate {
    static spawnParams = { size: { value: 3 }, look: { value: 'barrel', type: 'sprite' } };
  }
  Object.assign(Crate, { startIndex: 4, poolSize: 4 });
  class Walker {
    static spawnParams = { anim: { value: 'walk_left', type: 'animation' } };
  }
  Object.assign(Walker, { startIndex: 8, poolSize: 4 });
  class Rock {}
  Object.assign(Rock, { startIndex: 12, poolSize: 4 });

  assert.deepEqual(
    [classPicture(Crate, catalog), classPicture(Walker, catalog), classPicture(Rock, catalog)].map((p) => [p.source, p.frame]),
    [[PICTURE_PARAM, 'barrel'], [PICTURE_PARAM, 'civil1_walk_left_0'], [PICTURE_MARK, null]],
    'nothing live: the params’ defaults, and a class without one shows its mark',
  );

  live(3, 2, 0); // the slot before Crate's pool: not a crate
  live(5, 2, 0, { visible: 0 }); // a hidden crate shows nothing
  assert.equal(classPicture(Crate, catalog).source, PICTURE_PARAM);
  live(6, 2, 0, { scaleX: -2, scaleY: 1, tint: 0x495870 });
  const picture = classPicture(Crate, catalog);
  assert.deepEqual(
    { ...picture },
    { source: PICTURE_LIVE, frame: 'civil1_walk_down_0', scaleX: -2, scaleY: 1, tint: 0x495870, index: 6 },
    'what the live crate shows wins over the default: its frame, scale and tint',
  );
  live(13, 1, SpriteSheetRegistry.getAnimationIndex('bigAtlas', '_white'));
  assert.equal(livePictureOf(Rock).frame, '_white', 'a class without params: its live entity');
  SpriteRenderer.active[13] = 0;
  assert.equal(livePictureOf(Rock), null, 'no SpriteRenderer on: no picture');
});

test('drawn as an entity’s scale stretches it (within 4:1) and with its tint; a uniform scale or a flip keeps its shape', () => {
  const json = loadAtlas();
  const image = { tagName: 'CANVAS' };
  const scene = { bigAtlasCanvas: image, bigAtlasJson: json };
  const c = canvas(32);
  // A platform: _white (8 × 8) at 27.5 × 4.5, 220 × 36 in the world: a bar of 4:1.
  assert.equal(drawAtlasFrame(c, scene, '_white', 27.5, 4.5, 0x495870), true);
  assert.deepEqual(c.ctx.calls, [
    ['clear', 0, 0, 32, 32],
    ['draw', 'source-over', 2, 0, 8, 8, 0, 12, 32, 8],
    ['fill', 'multiply', '#495870', 0, 12, 32, 8],
    ['draw', 'destination-in', 2, 0, 8, 8, 0, 12, 32, 8],
  ]);
  assert.equal(c.ctx.globalCompositeOperation, 'source-over', 'put back');
  c.ctx.calls.length = 0;
  // A goal: 80 × 160 of _white, 1:2.
  drawAtlasFrame(c, scene, '_white', 10, 20, NO_TINT);
  assert.deepEqual(c.ctx.calls, [['clear', 0, 0, 32, 32], ['draw', 'source-over', 2, 0, 8, 8, 8, 0, 16, 32]], 'no tint: one draw');
  c.ctx.calls.length = 0;
  drawAtlasFrame(c, scene, 'barrel', -1.5, 1.5);
  assert.deepEqual(c.ctx.calls[1], ['draw', 'source-over', 20, 0, 16, 32, 8, 0, 16, 32], 'a flipped tree: its own 1:2');
  c.ctx.calls.length = 0;
  assert.equal(drawAtlasFrame(c, scene, 'nope', 1, 1), false);
  assert.deepEqual(c.ctx.calls, [['clear', 0, 0, 32, 32]]);
});

test('the mark: the initials of the name’s first two words, on a color of the name’s own', () => {
  assert.deepEqual(
    ['CityHouse', 'Platform', 'BluePlatformerPlayer', 'enemy_2', 'UFO', 'HTTPServer', 'Goal', '_'].map(initialsOf),
    ['CH', 'P', 'BP', 'E2', 'U', 'HS', 'G', '?'],
  );
  assert.equal(markColor('CityHouse'), markColor('CityHouse'), 'the same each time');
  assert.notEqual(markColor('CityHouse'), markColor('CityTree'));
  const c = canvas(32);
  drawClassMark(c, 'CityHouse');
  assert.deepEqual(c.ctx.calls.map((call) => call[0]), ['clear', 'fill', 'text']);
  assert.deepEqual(c.ctx.calls[1], ['fill', 'source-over', markColor('CityHouse'), 0, 0, 32, 32]);
  assert.deepEqual(c.ctx.calls[2], ['text', 'CH', 16, 17]);
});

test('each class is drawn once per scene; a refresh draws again only a mark that can show a picture now', () =>
  withCanvases((made) => {
    const json = loadAtlas();
    initSoA();
    let scene = { bigAtlasCanvas: {}, bigAtlasJson: json };
    const thumbs = new ClassThumbs(() => scene);
    class House {}
    Object.assign(House, { startIndex: 0, poolSize: 4 });
    class Tree {}
    Object.assign(Tree, { startIndex: 4, poolSize: 4 });
    live(1, 1, SpriteSheetRegistry.getAnimationIndex('bigAtlas', 'barrel'));

    const house = thumbs.get(House);
    const tree = thumbs.get(Tree);
    assert.equal(made.length, 2, 'a canvas per class');
    assert.equal(house.canvas.width, CLASS_THUMB_SIZE);
    assert.equal(house.source, PICTURE_LIVE);
    assert.equal(house.frame, 'barrel');
    assert.match(house.canvas.title, /House: as a live one shows it/);
    assert.equal(tree.source, PICTURE_MARK);
    assert.match(tree.canvas.title, /Tree: no picture yet/);
    const drawn = (thumb) => thumb.canvas.ctx.calls.length;
    const houseCalls = drawn(house);
    const treeCalls = drawn(tree);

    assert.equal(thumbs.get(House), house, 'asked again: the same picture');
    assert.equal(thumbs.retry(), 1, 'the tree still shows its mark');
    assert.equal(drawn(house), houseCalls, 'a class with a picture is not drawn again');
    assert.equal(drawn(tree), treeCalls, 'nor a mark that has nothing new to show');

    live(6, 2, 1); // a tree goes live: a walker's frame, say
    assert.equal(thumbs.retry(), 0);
    assert.equal(tree.source, PICTURE_LIVE);
    assert.equal(tree.frame, 'civil1_walk_left_0');
    assert.ok(drawn(tree) > treeCalls, 'drawn with its picture');
    assert.match(tree.canvas.title, /as a live one shows it/);
    const after = drawn(tree);
    Transform.active[6] = 0;
    live(7, 1, SpriteSheetRegistry.getAnimationIndex('bigAtlas', '_white'));
    thumbs.retry();
    assert.equal(drawn(tree), after, 'another live one later does not draw it again');

    scene = { bigAtlasCanvas: {}, bigAtlasJson: json }; // a full load: another scene
    const again = thumbs.get(House);
    assert.notEqual(again, house, 'made anew for another scene');
    assert.equal(made.length, 3);
  }));

test('a picture the atlas cannot draw yet leaves the mark, and is tried again', () =>
  withCanvases(() => {
    loadAtlas();
    initSoA();
    let scene = { bigAtlasCanvas: null, bigAtlasJson: null }; // the atlas canvas not there yet
    const thumbs = new ClassThumbs(() => scene);
    class Crate {}
    Object.assign(Crate, { startIndex: 0, poolSize: 2 });
    live(0, 1, SpriteSheetRegistry.getAnimationIndex('bigAtlas', 'barrel'));
    const crate = thumbs.get(Crate);
    assert.equal(crate.source, PICTURE_MARK);
    assert.equal(crate.canvas.ctx.calls.filter((c) => c[0] === 'text').length, 1, 'its mark');
    const json = loadAtlas();
    live(0, 1, SpriteSheetRegistry.getAnimationIndex('bigAtlas', 'barrel'));
    scene.bigAtlasCanvas = {};
    scene.bigAtlasJson = json;
    assert.equal(thumbs.retry(), 0);
    assert.equal(crate.source, PICTURE_LIVE);
  }));
