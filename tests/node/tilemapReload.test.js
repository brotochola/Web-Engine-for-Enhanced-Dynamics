// A Tiled tilemap loaded again in place (VISUAL_EDITOR_PLAN.md ED-26): when the file's shape is the same, its tiles
// go into the tilemap's shared memory (every thread's queries see them) and the layers configured to show it are
// posted to the renderer again, which packs its pages anew; no page reload, so the editor keeps its state. Another
// shape, or a layer showing a tilemap the scene set at runtime, cannot go in place: hot reload then reloads the page
// with the scene's state. A file that does not load changes nothing, and the scene runs on.
import test from 'node:test';
import assert from 'node:assert/strict';

import { TileMap } from '../../src/core/tileMap.js';
import { Layer } from '../../src/core/layer.js';
import { DEFAULT_LAYERS, LAYER_KIND } from '../../src/util/configDefaults.js';
import { HotReload } from '../../src/core/debug/hotReload.js';
import { TilemapList } from '../../src/core/debug/editor/tilemapList.js';
import {
  sceneTilemaps,
  tilemapOfFile,
  tilemapShapeChange,
  reloadTilemap,
  layersShowing,
} from '../../src/core/debug/tilemapReload.js';

const W = 6;
const H = 4;

/** A Tiled map: each layer [name, a tile id for every cell, or the cells]. */
function tiled(layers, { width = W, height = H, tilesets } = {}) {
  return {
    type: 'map',
    orientation: 'orthogonal',
    infinite: false,
    width,
    height,
    tilewidth: 24,
    tileheight: 24,
    layers: layers.map(([name, cells], k) => ({
      id: k + 1,
      name,
      type: 'tilelayer',
      width,
      height,
      x: 0,
      y: 0,
      visible: true,
      opacity: 1,
      data: Array.isArray(cells) ? cells : new Array(width * height).fill(cells),
    })),
    tilesets: tilesets ?? [{ firstgid: 1, columns: 24, tilewidth: 24, tileheight: 24, image: 'tiles.png' }],
  };
}

/** The running scene, its loaded tilemap, a layer showing it, a page location and a fetch of `files`. */
function setup({ layers = { ground: { kind: LAYER_KIND.TILEMAP, tilemap: 'ground', zIndex: 0 } } } = {}) {
  const map = tiled([
    ['bg', 1],
    ['walls', 0],
  ]);
  TileMap.reset();
  TileMap.initializeFromLoaded({ ground: { data: map } });
  Layer.reset();
  Layer.initializeFromConfig(layers, DEFAULT_LAYERS, true);
  const posted = [];
  Layer._postToRenderer = (msg) => {
    posted.push(msg);
    Layer.resolveLayerContentReady(msg.layerId, msg.requestId);
  };
  const scene = {
    sceneScriptUrl: 'http://localhost:8000/game/scene.js',
    imageUrls: { tilemaps: { ground: { json: '/maps/ground.json', png: '/maps/tiles.png' } } },
    loadedTilemaps: { ground: { data: map } },
  };
  const files = new Map();
  const fetches = [];
  globalThis.fetch = async (url, options) => {
    fetches.push([url, options]);
    const body = files.get(url);
    if (body === undefined) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  };
  let reloads = 0;
  globalThis.location = { origin: 'http://localhost:8000', href: 'http://localhost:8000/game/index.html', reload: () => reloads++ };
  return { scene, map, posted, files, fetches, reloads: () => reloads };
}

function teardown() {
  delete globalThis.fetch;
  delete globalThis.location;
  TileMap.reset();
  Layer.reset();
}

const tiles = (layer) => Array.from(TileMap.get('ground').getLayer(layer).data);

test('the scene’s tilemaps: file, tileset, size and the layers that show each; a changed file is matched by its URL', () => {
  const { scene } = setup();
  try {
    scene.imageUrls.tilemaps.caves = { json: 'maps/caves.json', png: 'maps/caves.png' };
    const maps = sceneTilemaps(scene);
    assert.deepEqual(
      maps.map((m) => [m.id, m.json, m.png, m.tilemap === null ? null : m.tilemap.mapWidth, m.shownBy]),
      [
        ['ground', 'http://localhost:8000/maps/ground.json', 'http://localhost:8000/maps/tiles.png', W, ['ground']],
        ['caves', 'http://localhost:8000/game/maps/caves.json', 'http://localhost:8000/game/maps/caves.png', null, []],
      ],
      'a relative URL resolves against the page, as fetch does; a map that did not load has no TileMap',
    );
    assert.equal(tilemapOfFile(scene, 'http://localhost:8000/maps/ground.json'), 'ground');
    assert.equal(tilemapOfFile(scene, 'http://localhost:8000/maps/ground.json?t=2'), 'ground', 'a query is not part of the file');
    assert.equal(tilemapOfFile(scene, 'http://localhost:8000/maps/tiles.png'), null, 'the tileset is not the map’s file');
    assert.equal(tilemapOfFile({}, 'http://localhost:8000/maps/ground.json'), null, 'a scene without tilemaps');
    assert.deepEqual(layersShowing('ground'), ['ground']);
  } finally {
    teardown();
  }
});

test('the shape a file must keep to go in place', () => {
  const { map } = setup();
  try {
    const tilemap = TileMap.get('ground');
    const same = structuredClone(map);
    same.layers[0].data[5] = 7;
    assert.equal(tilemapShapeChange(tilemap, same), null, 'other tiles, same shape');
    const variants = {
      size: tiled([['bg', 1], ['walls', 0]], { width: W + 1 }),
      renamed: tiled([['bg', 1], ['wall', 0]]),
      added: tiled([['bg', 1], ['walls', 0], ['roof', 0]]),
      tileset: tiled([['bg', 1], ['walls', 0]], { tilesets: [{ firstgid: 1, columns: 12, tilewidth: 24, tileheight: 24 }] }),
    };
    assert.match(tilemapShapeChange(tilemap, variants.size), /size changed \(6×4 tiles, now 7×4\)/);
    assert.match(tilemapShapeChange(tilemap, variants.renamed), /tile layers changed/);
    assert.match(tilemapShapeChange(tilemap, variants.added), /tile layers changed/);
    assert.match(tilemapShapeChange(tilemap, variants.tileset), /tilesets changed/);
    const hidden = structuredClone(map);
    hidden.layers[1].visible = false;
    assert.match(tilemapShapeChange(tilemap, hidden), /walls was shown or hidden/, 'the renderer keeps its own copy');
    const faded = structuredClone(map);
    faded.layers[0].opacity = 0.5;
    assert.match(tilemapShapeChange(tilemap, faded), /opacity/);
    const base64 = structuredClone(map);
    base64.layers[0].data = 'AQAAAAEAAAA=';
    base64.layers[0].encoding = 'base64';
    assert.match(tilemapShapeChange(tilemap, base64), /save tile layers as CSV/);
    const withObjects = structuredClone(map);
    withObjects.layers.push({ name: 'spawns', type: 'objectgroup', objects: [] });
    assert.equal(tilemapShapeChange(tilemap, withObjects), null, 'an object layer is not kept: not part of the shape');
    assert.equal(tilemapShapeChange(tilemap, { width: W }), 'it is not a Tiled map');
  } finally {
    teardown();
  }
});

test('in place: the tiles go into the shared memory every thread reads, and the layers that show the map are drawn again', async () => {
  const { scene, posted, files, fetches } = setup();
  try {
    const sab = TileMap._sabs[TileMap.get('ground').id];
    const next = tiled([
      ['bg', 1],
      ['walls', [0, 0, 0, 0x80000005, 0, 0, ...new Array(W * H - 6).fill(9)]],
    ]);
    files.set('/maps/ground.json', JSON.stringify(next));
    const outcome = await reloadTilemap(scene, 'ground');
    assert.deepEqual(outcome, { result: 'reloaded', reason: '' });
    assert.deepEqual(fetches, [['/maps/ground.json', { cache: 'no-store' }]], 'fresh from the server');
    assert.equal(tiles('walls')[3], 0x80000005 | 0, 'a flipped tile keeps its flags, as the load stores them');
    assert.equal(tiles('walls')[10], 9);
    const workerView = new Int32Array(sab, W * H * 4, W * H); // what a worker's TileMap reads: the same memory
    assert.equal(workerView[10], 9);
    assert.deepEqual(
      posted.map((msg) => [msg.msg, msg.type, Layer.getName(msg.layerId), msg.tilemapId]),
      [['setLayerContent', 'tilemap', 'ground', 'ground']],
      'the renderer packs the layer’s pages again',
    );
    assert.equal(scene.loadedTilemaps.ground.data.layers[1].data[10], 9, 'the page’s copy of the file follows');
  } finally {
    teardown();
  }
});

test('what cannot go in place changes nothing: another shape, a layer set at runtime, a file that does not load', async () => {
  const { scene, posted, files } = setup({
    layers: {
      ground: { kind: LAYER_KIND.TILEMAP, tilemap: 'ground', zIndex: 0 },
      extra: { kind: LAYER_KIND.TILEMAP, zIndex: 1 },
    },
  });
  try {
    const before = tiles('bg');
    files.set('/maps/ground.json', JSON.stringify(tiled([['bg', 3], ['walls', 0]], { width: W + 2 })));
    assert.equal((await reloadTilemap(scene, 'ground')).result, 'reload', 'a layer configured without a map: set at runtime');
    Layer.reset();
    Layer.initializeFromConfig({ ground: { kind: LAYER_KIND.TILEMAP, tilemap: 'ground', zIndex: 0 } }, DEFAULT_LAYERS, true);
    Layer._postToRenderer = (msg) => posted.push(msg);
    const shape = await reloadTilemap(scene, 'ground');
    assert.equal(shape.result, 'reload');
    assert.match(shape.reason, /size changed/);
    files.set('/maps/ground.json', '{ "width": 6, "hei');
    const broken = await reloadTilemap(scene, 'ground');
    assert.equal(broken.result, 'failed');
    assert.match(broken.reason, /\/maps\/ground\.json did not load/);
    files.delete('/maps/ground.json');
    assert.equal((await reloadTilemap(scene, 'ground')).result, 'failed', 'gone (404)');
    assert.equal((await reloadTilemap(scene, 'nowhere')).result, 'failed', 'not a tilemap of the scene');
    assert.deepEqual(tiles('bg'), before);
    assert.equal(posted.length, 0, 'nothing drawn again');
  } finally {
    teardown();
  }
});

test('hot reload: a tilemap’s file goes in place with no page reload; another shape reloads keeping the state', async () => {
  const { scene, files } = setup();
  const keep = HotReload.reloadKeepingState;
  let kept = 0;
  HotReload.reloadKeepingState = async () => {
    kept++;
  };
  const quiet = [console.info, console.warn];
  const said = [];
  console.info = (m) => said.push(String(m));
  console.warn = (m) => said.push(String(m));
  try {
    const game = { currentScene: scene, state: 1 };
    const event = (file) => JSON.stringify({ file });
    files.set('/maps/ground.json', JSON.stringify(tiled([['bg', 2], ['walls', 0]])));
    assert.equal(await HotReload.onFileChanged(game, event('maps/ground.json')), 'tilemap');
    assert.equal(tiles('bg')[0], 2);
    assert.equal(kept, 0, 'no reload: the editor keeps its document, undo and selection');
    assert.match(said.at(-1), /tilemap "ground" reloaded in place/);
    files.set('/maps/ground.json', '{');
    assert.equal(await HotReload.onFileChanged(game, event('maps/ground.json')), 'failed', 'half written');
    assert.equal(kept, 0);
    files.set('/maps/ground.json', JSON.stringify(tiled([['bg', 2]])));
    assert.equal(await HotReload.onFileChanged(game, event('maps/ground.json')), 'reloaded');
    assert.equal(kept, 1, 'another shape: the page reload that keeps the scene’s state');
    assert.match(said.at(-1), /tile layers changed.*reloading the page/);
    await HotReload.onFileChanged(game, event('maps/other.json'));
    assert.equal(kept, 2, 'a file that is no tilemap of the scene: as before');
    game.state = 0;
    await HotReload.onFileChanged(game, event('maps/ground.json'));
    assert.equal(kept, 3, 'a scene still loading: as before');
  } finally {
    HotReload.reloadKeepingState = keep;
    [console.info, console.warn] = quiet;
    teardown();
  }
});

// ---- the palette's Tilemaps section, against a fake DOM ----

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.title = '';
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
}

test('the Assets dock lists the scene’s tilemaps, built once per scene; its button reloads one in place', async () => {
  const { scene, files } = setup();
  globalThis.document = { createElement: (tag) => new El(tag) };
  try {
    const statuses = [];
    const editMode = { debugUI: { scene }, _setStatus: (text, error) => statuses.push([text, error]) };
    const list = new TilemapList(editMode);
    const box = new El('div');
    list.fill(box);
    assert.equal(box.style.display, '');
    const row = box.children[1];
    assert.equal(row.dataset.tilemap, 'ground');
    assert.deepEqual(
      row.children.map((c) => c.textContent),
      ['ground  ·  ground.json', '↻', '6×4 tiles of 24 px, 2 layers; on ground'],
    );
    list.fill(box);
    assert.equal(box.children[1], row, 'the same scene: the rows stay');

    files.set('/maps/ground.json', JSON.stringify(tiled([['bg', 4], ['walls', 0]])));
    await row.children[1].onclick();
    assert.equal(tiles('bg')[0], 4);
    files.set('/maps/ground.json', JSON.stringify(tiled([['bg', 4], ['walls', 0]], { height: H + 1 })));
    assert.equal(await list.reload('ground'), 'reload');
    assert.deepEqual(statuses, [
      ['Tilemap ground reloaded from its file', false],
      ['Tilemap ground: its size changed (6×4 tiles, now 6×5). Reload the game to load it', true],
    ]);

    editMode.debugUI.scene = { imageUrls: {} };
    list.fill(box);
    assert.equal(box.style.display, 'none', 'a scene without tilemaps: no section');
    assert.equal(box.children.length, 0);
  } finally {
    delete globalThis.document;
    teardown();
  }
});
