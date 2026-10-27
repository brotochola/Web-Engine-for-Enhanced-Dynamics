// Baking the running scene's atlas from the editor (VISUAL_EDITOR_PLAN.md ED-31): the canvas and JSON a load keeps
// (scene.bigAtlasCanvas, scene.bigAtlasJson) are written as <Scene>.atlas.png and .atlas.json next to the scene's
// module through the dev server's file route, and the editor says which assets entry makes the scene load them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { atlasFileUrls, atlasOf, bakeAtlas, canvasPngBytes } from '../../src/core/debug/editor/atlasBake.js';
import { ShipRow } from '../../src/core/debug/editor/shipRow.js';
import { handleDevRoute } from '../../server/devRoutes.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** A page canvas: toBlob, as HTMLCanvasElement has. */
const pageCanvas = (bytes = PNG) => ({ width: 64, height: 32, toBlob: (cb, type) => cb(type === 'image/png' ? new Blob([bytes]) : null) });

function sceneWithAtlas(canvas = pageCanvas()) {
  class MyScene {}
  const scene = new MyScene();
  scene.sceneScriptUrl = 'http://127.0.0.1:8000/demos/game/myScene.js';
  scene.bigAtlasCanvas = canvas;
  scene.bigAtlasJson = { frames: { a: {}, b: {} }, animations: { a: ['a'] }, meta: { size: { w: 64, h: 32 } } };
  return scene;
}

test('the atlas as files: PNG bytes from a page canvas or an OffscreenCanvas, and its JSON', async () => {
  assert.deepEqual(await canvasPngBytes(pageCanvas()), PNG);
  const offscreen = { width: 8, height: 8, convertToBlob: async ({ type }) => new Blob([type === 'image/png' ? PNG : []]) };
  assert.deepEqual(await canvasPngBytes(offscreen), PNG);
  await assert.rejects(canvasPngBytes({ toBlob: (cb) => cb(null) }), /gave no PNG/);

  const atlas = await atlasOf(sceneWithAtlas());
  assert.deepEqual(JSON.parse(atlas.json), sceneWithAtlas().bigAtlasJson);
  assert.deepEqual([atlas.width, atlas.height, atlas.frames], [64, 32, 2]);
  await assert.rejects(atlasOf({ bigAtlasCanvas: null, bigAtlasJson: null }), /no atlas to bake/);
  await assert.rejects(atlasOf(null), /no atlas to bake/);
});

test('a bake goes next to the scene’s module, named after its class', () => {
  assert.deepEqual(atlasFileUrls(sceneWithAtlas()), {
    png: 'http://127.0.0.1:8000/demos/game/MyScene.atlas.png',
    json: 'http://127.0.0.1:8000/demos/game/MyScene.atlas.json',
  });
  const noModule = sceneWithAtlas();
  noModule.sceneScriptUrl = null;
  assert.throws(() => atlasFileUrls(noModule), /no folder/);
});

test('bakeAtlas writes both files through the dev server’s route and says what makes the scene load them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-bake-'));
  fs.mkdirSync(path.join(root, 'demos', 'game'), { recursive: true });
  const server = http.createServer((req, res) => {
    if (!handleDevRoute(req, res, root)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const scene = sceneWithAtlas();
    scene.sceneScriptUrl = `${origin}/demos/game/myScene.js`;
    const baked = await bakeAtlas(scene, { origin });
    assert.deepEqual(fs.readFileSync(path.join(root, 'demos/game/MyScene.atlas.png')), Buffer.from(PNG));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'demos/game/MyScene.atlas.json'), 'utf8')), scene.bigAtlasJson);
    assert.equal(baked.png, '/demos/game/MyScene.atlas.png');
    assert.equal(baked.json, '/demos/game/MyScene.atlas.json');
    assert.equal(baked.assets, "bigAtlas: { json: '/demos/game/MyScene.atlas.json', png: '/demos/game/MyScene.atlas.png' }");

    // A canvas that does not give a PNG is refused by the route, and the editor says why.
    const broken = sceneWithAtlas(pageCanvas(Uint8Array.from([1, 2, 3])));
    broken.sceneScriptUrl = scene.sceneScriptUrl;
    await assert.rejects(bakeAtlas(broken, { origin }), /could not save \/demos\/game\/MyScene\.atlas\.png: not a PNG/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
  // A server without the route.
  const scene = sceneWithAtlas();
  const fetch404 = async () => new Response('<h1>404</h1>', { status: 404 });
  await assert.rejects(bakeAtlas(scene, { origin: 'http://127.0.0.1:8000', fetch: fetch404 }), /cannot save files \(HTTP 404\)/);
});

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.disabled = false;
    this._text = '';
  }
  appendChild(node) {
    this.children.push(node);
    return node;
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(text) {
    this._text = text;
    this.children = [];
  }
}

test('the Bake atlas button: one bake at a time, its outcome on the row and the status line', async () => {
  globalThis.document = { createElement: (tag) => new El(tag) };
  const realFetch = globalThis.fetch;
  const puts = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  globalThis.location = { origin: 'http://127.0.0.1:8000' };
  globalThis.fetch = async (url, init) => {
    puts.push(String(url));
    await gate;
    return new Response(JSON.stringify({ mtimeMs: 1 }), { status: 200 });
  };
  try {
    const statuses = [];
    const scene = sceneWithAtlas();
    const editMode = { debugUI: { scene }, _setStatus: (text, isError) => statuses.push([text, isError]) };
    const row = new ShipRow(editMode);
    const button = row._buttons.children[0];
    assert.equal(button.textContent, 'Bake atlas');
    const first = button.onclick();
    const second = row.bake(); // while the first runs: nothing more is written
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(button.disabled, true);
    assert.match(row._note.textContent, /Baking/);
    release();
    const baked = await first;
    assert.equal(await second, null);
    assert.equal(baked.png, '/demos/game/MyScene.atlas.png');
    assert.equal(button.disabled, false);
    assert.match(row._note.textContent, /^Baked \/demos\/game\/MyScene\.atlas\.png \(64 × 32, 2 frames\)/);
    assert.match(row._note.textContent, /bigAtlas: \{ json: '\/demos\/game\/MyScene\.atlas\.json'/);
    assert.deepEqual(statuses, [['Baked MyScene.atlas.png', false]]);
    assert.deepEqual(puts.map((u) => decodeURIComponent(new URL(u).searchParams.get('path'))), [
      '/demos/game/MyScene.atlas.png',
      '/demos/game/MyScene.atlas.json',
    ]);

    // Nothing loaded yet: the row says so, in red.
    const errors = console.error;
    console.error = () => {};
    try {
      editMode.debugUI.scene = null;
      assert.equal(await row.bake(), null);
    } finally {
      console.error = errors;
    }
    assert.match(row._note.textContent, /no atlas to bake/);
    assert.equal(row._note.style.color, '#f87171');
    assert.equal(statuses.at(-1)[1], true);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.document;
    delete globalThis.location;
  }
});
