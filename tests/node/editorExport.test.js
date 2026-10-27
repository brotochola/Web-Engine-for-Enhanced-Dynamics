// The editor's Export (VISUAL_EDITOR_PLAN.md ED-32), its page side: what the running game is made of, read from the
// running scene (its module and class, its scene file and that folder's others, the files its class declares, its
// atlas baked) and sent to the dev server's export route; the Assets dock's Export button and the toolbar's say where
// the game went.
import test from 'node:test';
import assert from 'node:assert/strict';

import { declaredFiles, exportRequestOf, exportRunningGame, filePathsIn } from '../../src/core/debug/editor/gameExport.js';
import { ShipRow, exportFromEditor } from '../../src/core/debug/editor/shipRow.js';
import { EditorToolbar } from '../../src/core/debug/editor/toolbar.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

class LevelScene {
  static config = {
    worldWidth: 100,
    layers: { bloom: { blendMode: 'normal', shader: { fragment: '/demos/shaders/bloom.frag', uniforms: { t: { value: 0.5 } } } } },
  };
  static assets = {
    textures: { crate: '/demos/img/crate.png', cdn: 'https://cdn.example/x.png' },
    spritesheets: { hero: { json: '/demos/img/hero.json', png: '/demos/img/hero.png' } },
    AdobeAnimateAnimations: { blue: { atlas: './adobe/spritemap1.json', animation: './adobe/Animation.json', png: './adobe/spritemap1.png' } },
    shaders: { glow: { webgl: '/demos/shaders/glow.frag', webgpu: '/demos/shaders/glow.wgsl' } },
    tilemaps: { ground: { json: '/demos/maps/ground.json', png: '/demos/maps/ground.png' } },
    bigAtlas: { json: '/demos/baked/old.json', png: '/demos/baked/old.png' },
  };
  static audios = [{ name: 'jump', src: '/demos/audio/jump.mp3' }, 'bloom', { name: 'land', url: '/demos/audio/land.ogg?v=2' }];
}

function runningScene() {
  const scene = new LevelScene();
  scene.sceneScriptUrl = 'http://127.0.0.1:8000/demos/game/levelScene.js';
  scene.sceneFileUrl = 'http://127.0.0.1:8000/demos/game/levels/1-1.scene.json';
  scene.bigAtlasCanvas = { width: 2, height: 2, toBlob: (cb) => cb(new Blob([PNG])) };
  scene.bigAtlasJson = { frames: { a: {} }, animations: { a: ['a'] }, meta: { size: { w: 2, h: 2 } } };
  return scene;
}

test('the files a scene class declares: paths only, the packed images left out when the atlas is baked', () => {
  assert.deepEqual([...filePathsIn({ a: 'bloom', b: ['/x/y.png', 0.5, null], c: { d: './z.frag?v=1' }, e: '0.25' })], ['/x/y.png', './z.frag?v=1']);
  const all = declaredFiles(LevelScene, { baked: false });
  for (const f of ['/demos/img/crate.png', '/demos/img/hero.json', '/demos/baked/old.png', '/demos/maps/ground.png', '/demos/shaders/glow.wgsl', '/demos/audio/land.ogg?v=2', '/demos/shaders/bloom.frag']) {
    assert.ok(all.includes(f), f);
  }
  const baked = declaredFiles(LevelScene, { baked: true });
  assert.deepEqual(baked.filter((f) => /crate|hero|old/.test(f)), [], 'textures, spritesheets and an earlier bake are what the atlas replaces');
  assert.ok(baked.includes('./adobe/spritemap1.png'), 'Adobe files are still fetched with a baked atlas');
  assert.ok(baked.includes('/demos/maps/ground.json') && baked.includes('/demos/audio/jump.mp3') && baked.includes('/demos/shaders/bloom.frag'));
});

test('the request: site paths of this server, another site’s files left alone, the start and its folder’s files, the atlas', () => {
  const scene = runningScene();
  const request = exportRequestOf(scene, {
    pageUrl: 'http://127.0.0.1:8000/demos/game/index.html?level=1',
    sceneFiles: ['http://127.0.0.1:8000/demos/game/levels/1-1.scene.json', 'http://127.0.0.1:8000/demos/game/levels/my%20level.scene.json'],
    atlas: { json: '{"a":1}', png: PNG },
  });
  assert.equal(request.scene, '/demos/game/levelScene.js');
  assert.equal(request.export, 'LevelScene');
  assert.equal(request.start, '/demos/game/levels/1-1.scene.json');
  assert.deepEqual(request.sceneFiles, ['/demos/game/levels/1-1.scene.json', '/demos/game/levels/my level.scene.json']);
  assert.deepEqual(Buffer.from(request.atlas.png, 'base64'), Buffer.from(PNG));
  assert.equal(request.atlas.json, '{"a":1}');
  const byUrl = Object.fromEntries(request.assets.map((a) => [a.url, a.path]));
  assert.equal(byUrl['./adobe/spritemap1.json'], '/demos/game/adobe/spritemap1.json', 'relative to the page, as the engine fetches it');
  assert.equal(byUrl['/demos/audio/land.ogg?v=2'], '/demos/audio/land.ogg');
  assert.equal(byUrl['https://cdn.example/x.png'], undefined, 'another site: not copied');
  assert.equal(byUrl['/demos/img/crate.png'], undefined, 'baked: the atlas has it');

  const noFile = runningScene();
  noFile.sceneFileUrl = null;
  assert.equal(exportRequestOf(noFile, { pageUrl: 'http://127.0.0.1:8000/', sceneFiles: [], atlas: null }).start, null);
  assert.throws(() => exportRequestOf({ constructor: LevelScene }, { pageUrl: 'http://127.0.0.1:8000/', sceneFiles: [], atlas: null }), /Nothing to export/);
});

/** A fake dev server: the list route, and the export route answering `answer`. */
function devServer(answer, status = 200) {
  const asked = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    asked.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method ?? 'GET', body: init.body });
    if (u.pathname === '/__weed/list') return new Response(JSON.stringify({ files: ['1-1.scene.json', '1-2.scene.json'] }), { status: 200 });
    if (u.pathname === '/__weed/export' && status !== 404) return new Response(JSON.stringify(answer), { status });
    return new Response('<h1>404</h1>', { status: 404 });
  };
  return { fetch, asked };
}

test('exportRunningGame lists the level’s folder, bakes the atlas and posts the request; the route’s refusal is said', async () => {
  const done = { outDir: 'D:/x/scratch/export/LevelScene', url: '/scratch/export/LevelScene/', files: ['index.html'], bytes: 10, gameBytes: 5, warnings: [] };
  const server = devServer(done);
  const env = { fetch: server.fetch, origin: 'http://127.0.0.1:8000', pageUrl: 'http://127.0.0.1:8000/demos/game/index.html' };
  assert.deepEqual(await exportRunningGame(runningScene(), env), done);
  assert.deepEqual(server.asked.map((a) => `${a.method} ${a.path}`), ['GET /__weed/list', 'POST /__weed/export']);
  assert.equal(server.asked[0].query.dir, '/demos/game/levels');
  const sent = JSON.parse(server.asked[1].body);
  assert.deepEqual(sent.sceneFiles, ['/demos/game/levels/1-1.scene.json', '/demos/game/levels/1-2.scene.json']);
  assert.deepEqual(Buffer.from(sent.atlas.png, 'base64'), Buffer.from(PNG));

  const refused = devServer({ error: 'game.min.js does not export X' }, 400);
  await assert.rejects(exportRunningGame(runningScene(), { ...env, fetch: refused.fetch }), /^Error: Export failed: game\.min\.js does not export X$/);
  const plain = devServer(null, 404);
  await assert.rejects(exportRunningGame(runningScene(), { ...env, fetch: plain.fetch }), /cannot export \(HTTP 404\): serve the game with npm run dev/);
});

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.disabled = false;
    this.classList = { toggle() {} };
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

async function withPage(answer, fn) {
  const realFetch = globalThis.fetch;
  globalThis.document = { createElement: (tag) => new El(tag) };
  globalThis.location = { origin: 'http://127.0.0.1:8000', href: 'http://127.0.0.1:8000/demos/game/index.html' };
  const server = devServer(answer);
  globalThis.fetch = server.fetch;
  const info = console.info;
  console.info = () => {};
  try {
    await fn(server);
  } finally {
    console.info = info;
    globalThis.fetch = realFetch;
    delete globalThis.document;
    delete globalThis.location;
    delete globalThis.confirm;
  }
}

test('the Export button says where the game went, with a link when the server serves it; unsaved edits ask first', async () => {
  const done = { outDir: 'D:/x/scratch/export/LevelScene', url: '/scratch/export/LevelScene/', files: ['a', 'b'], bytes: 3 * 1024 * 1024, gameBytes: 2048, warnings: ['not found, not exported: /demos/img/none.png'] };
  await withPage(done, async (server) => {
    const statuses = [];
    const editMode = { debugUI: { scene: runningScene() }, dirty: false, sceneFileName: '1-1.scene.json', _setStatus: (t, e) => statuses.push([t, e]) };
    const row = new ShipRow(editMode);
    const [bake, exportButton] = row._buttons.children;
    assert.deepEqual([bake.textContent, exportButton.textContent], ['Bake atlas', 'Export']);
    assert.deepEqual(await exportButton.onclick(), done);
    assert.equal(row._note.textContent, `Exported to D:/x/scratch/export/LevelScene: 2 files, 3.0 MB (game.min.js 2.0 KB). not found, not exported: /demos/img/none.png. Open /scratch/export/LevelScene/`);
    assert.equal(row._note.children[0].href, '/scratch/export/LevelScene/');
    assert.deepEqual(statuses, [['Exported to D:/x/scratch/export/LevelScene', false]]);

    // Unsaved edits: the author is asked, and a no exports nothing.
    editMode.dirty = true;
    let asked = '';
    globalThis.confirm = (text) => {
      asked = text;
      return false;
    };
    const posts = server.asked.length;
    assert.equal(await row.exportGame(), null);
    assert.match(asked, /1-1\.scene\.json has unsaved changes, which the export leaves out/);
    assert.equal(server.asked.length, posts);
  });
});

test('the toolbar’s Export goes through the Assets dock’s row when there is one, else a row of its own', async () => {
  const done = { outDir: 'D:/out', url: null, files: [], bytes: 0, gameBytes: 0, warnings: [] };
  await withPage(done, async () => {
    const editMode = {
      debugUI: { scene: runningScene() },
      dirty: false,
      active: false,
      playing: false,
      status: '',
      statusIsError: false,
      sceneFileName: '1-1.scene.json',
      history: { canUndo: false, canRedo: false },
      palette: { ship: null },
      _setStatus() {},
    };
    const toolbar = new EditorToolbar(editMode);
    const button = toolbar.el.children.find((b) => b.textContent === 'Export');
    assert.ok(button, 'the toolbar has an Export button');
    assert.deepEqual(await button.onclick(), done, 'with no dock yet: a row of its own');
    const dockRow = new ShipRow(editMode);
    editMode.palette.ship = dockRow;
    await exportFromEditor(editMode);
    assert.match(dockRow._note.textContent, /^Exported to D:\/out: 0 files/, 'the dock’s row says where it went');
  });
});
