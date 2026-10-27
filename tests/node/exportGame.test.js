// The editor's Export (VISUAL_EDITOR_PLAN.md ED-32), on a tiny fixture game (tests/fixtures/exportGame): esbuild
// bundles the scene and entity modules and the scene files into game.min.js, with the engine as the global WEED and
// class names kept; the output is what both the page and the engine's blob workers can run; the assets the scene
// declares are copied under assets/ and the page points the scene at them; the baked atlas goes with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ExportError, checkWorkerLoadable, exportGame, planExport } from '../../server/exportGame.js';
import { collectBlobScriptDeps, evaluateBlobModule, transformBlobScript } from '../../src/util/utils.js';
import { bindSceneGraph } from '../../src/util/sceneScript.js';
import { WORKER_WEED } from '../../src/workers/workerWeed.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const F = '/tests/fixtures/exportGame';
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ATLAS_JSON = JSON.stringify({ frames: { crate: {} }, animations: { crate: ['crate'] }, meta: { size: { w: 1, h: 1 } } });
/** A stand-in for the engine's production bundle: an engine that can run an export names registerSceneFile. */
const ENGINE = '/* the engine */ WEED.registerSceneFile';

const asset = (p) => ({ url: p, path: p });
const request = (over = {}) => ({
  scene: `${F}/game/fixtureScene.js`,
  export: 'FixtureScene',
  start: `${F}/game/levels/a.scene.json`,
  sceneFiles: [`${F}/game/levels/a.scene.json`, `${F}/game/levels/b.scene.json`],
  assets: [asset(`${F}/img/crate.png`), asset(`${F}/audio/thud.wav`), asset(`${F}/shaders/glow.frag`)],
  atlas: { json: ATLAS_JSON, png: PNG_1PX },
  title: 'Fixture <game>',
  ...over,
});

/** A temporary folder with a stand-in engine bundle (and its isolation worker), and a folder to export into. */
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-export-'));
  fs.mkdirSync(path.join(dir, 'engine'));
  const engineBundle = path.join(dir, 'engine', 'weed.prod.bundle.min.js');
  fs.writeFileSync(engineBundle, ENGINE);
  fs.writeFileSync(path.join(dir, 'engine', 'weed-sw.js'), '/* sw */');
  return { dir, engineBundle, outDir: path.join(dir, 'out'), remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** One export of the fixture, shared by the tests that read it. */
let exported = null;
async function fixtureExport() {
  if (exported === null) {
    const ws = workspace();
    const done = await exportGame(request(), { root: ROOT, outDir: ws.outDir, engineBundle: ws.engineBundle });
    exported = { ws, done, code: fs.readFileSync(path.join(ws.outDir, 'game.min.js'), 'utf8') };
  }
  return exported;
}
test.after(() => exported?.ws.remove());

test('the export’s layout: page, engine, game, assets, baked atlas, headers', async () => {
  const { ws, done, code } = await fixtureExport();
  assert.deepEqual(done.files, [
    '_headers',
    'assets/FixtureScene.atlas.json',
    'assets/FixtureScene.atlas.png',
    'assets/audio/thud.wav',
    'assets/img/crate.png',
    'assets/shaders/glow.frag',
    'game.min.js',
    'index.html',
    'vendor/weed.js',
    'weed-sw.js',
  ]);
  const out = (rel) => path.join(ws.outDir, rel);
  assert.equal(fs.readFileSync(out('vendor/weed.js'), 'utf8'), ENGINE, 'the engine bundle, unchanged');
  assert.ok(fs.readFileSync(out('assets/img/crate.png')).equals(fs.readFileSync(path.join(ROOT, F, 'img/crate.png'))));
  assert.ok(fs.readFileSync(out('assets/FixtureScene.atlas.png')).equals(Buffer.from(PNG_1PX, 'base64')));
  assert.equal(fs.readFileSync(out('assets/FixtureScene.atlas.json'), 'utf8'), ATLAS_JSON);
  assert.match(fs.readFileSync(out('_headers'), 'utf8'), /Cross-Origin-Opener-Policy: same-origin\n {2}Cross-Origin-Embedder-Policy: require-corp/);
  const html = fs.readFileSync(out('index.html'), 'utf8');
  assert.match(html, /<title>Fixture &lt;game&gt;<\/title>/);
  assert.match(html, /<script src="\.\/vendor\/weed\.js"><\/script>/);
  assert.match(html, /import '\.\/game\.min\.js';/);
  assert.match(html, /game\.loadScene\(new URL\("\.\/levels\/a\.scene\.json", import\.meta\.url\)\.href/);
  assert.equal(done.gameBytes, Buffer.byteLength(code));
  assert.deepEqual(done.warnings, []);

  // Minified, with no engine code or path in it, ending in the export list the workers read.
  assert.ok(code.split('\n').length <= 2, 'one line');
  assert.doesNotMatch(code, /\/src\/|fixtures\/exportGame\/game/);
  assert.match(code, /export \{ [^}]*\bFixtureScene\b[^}]* \};\n$/);
});

test('in a worker: the engine’s blob loader runs game.min.js and finds the scene’s entity classes by name', async () => {
  const { code } = await fixtureExport();
  const gameUrl = 'https://game.example/play/game.min.js';
  assert.deepEqual(collectBlobScriptDeps(code, gameUrl), [], 'nothing more for the worker to fetch');
  const workerSelf = { WEED: WORKER_WEED, ...WORKER_WEED };
  const exports = evaluateBlobModule(code, gameUrl, workerSelf);
  assert.deepEqual(Object.keys(exports).sort(), ['FIXTURE_LEVELS', 'FixtureScene']);
  const { FixtureScene } = exports;
  assert.equal(FixtureScene.name, 'FixtureScene');
  assert.ok(FixtureScene.prototype instanceof WORKER_WEED.Scene);
  // What a worker does next (abstractWorker.js): the scene class by its name, then its entity graph.
  bindSceneGraph(FixtureScene, workerSelf, WORKER_WEED.GameObject, WORKER_WEED.SharedResource);
  assert.equal(workerSelf.Crate.name, 'Crate');
  assert.ok(workerSelf.Crate.prototype instanceof WORKER_WEED.GameObject);
  assert.deepEqual(Object.keys(workerSelf.Crate.spawnParams), ['size']);
  // A worker leaves the assets alone: no page there.
  assert.equal(FixtureScene.assets.textures.crate, `${F}/img/crate.png`);
});

test('on the page: the levels load from game.min.js, the assets point at assets/, the scene loads the baked atlas', async () => {
  const { ws, code } = await fixtureExport();
  const { default: WEED } = await import('../../src/index.js');
  const { fetchSceneFile, sceneFileScriptUrl, defaultSceneFileUrl } = await import('../../src/core/sceneFile.js');
  const { pickSceneClass } = await import('../../src/util/sceneScript.js');
  const gameFile = path.join(ws.dir, 'page', 'game.min.js');
  fs.mkdirSync(path.dirname(gameFile));
  fs.writeFileSync(gameFile, code);
  const gameUrl = pathToFileURL(gameFile).href;
  const realFetch = globalThis.fetch;
  globalThis.window = globalThis;
  globalThis.WEED = WEED;
  globalThis.fetch = async (url) => {
    throw new Error(`fetched ${url}`);
  };
  try {
    const ns = await import(gameUrl);
    const Scene = pickSceneClass(ns, 'FixtureScene', WEED.Scene);
    assert.equal(Scene.name, 'FixtureScene');
    assert.ok(Scene.prototype instanceof WEED.Scene);
    assert.equal(Scene.entities[0][0].name, 'Crate', 'the entity class keeps its name');

    const levelA = new URL('levels/a.scene.json', gameUrl).href;
    const a = await fetchSceneFile(levelA);
    const source = JSON.parse(fs.readFileSync(path.join(ROOT, F, 'game/levels/a.scene.json'), 'utf8'));
    assert.deepEqual(a, { ...source, script: '../game.min.js' });
    assert.equal(sceneFileScriptUrl(a, levelA), gameUrl, 'the file names game.min.js');
    assert.equal((await fetchSceneFile(new URL('levels/b.scene.json', gameUrl).href)).entities[0].config.size, 16);
    assert.equal(defaultSceneFileUrl(Scene, gameUrl), levelA, 'loaded by its module, the scene starts at its first level');

    const at = (rel) => new URL(rel, gameUrl).href;
    assert.equal(Scene.assets.textures.crate, at('assets/img/crate.png'));
    assert.deepEqual(Scene.assets.bigAtlas, { json: at('assets/FixtureScene.atlas.json'), png: at('assets/FixtureScene.atlas.png') });
    assert.equal(Scene.audios.thud, at('assets/audio/thud.wav'));
    assert.equal(Scene.config.layers.glow.shader.fragment, at('assets/shaders/glow.frag'));
    assert.equal(Scene.config.layers.glow.zIndex, 2, 'the rest of the config as it was');
    assert.equal(ns.FIXTURE_LEVELS, 2);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.window;
    delete globalThis.WEED;
  }
});

test('the workers’ loader: the export list gets its space; text it would rewrite as code is refused', () => {
  assert.equal(checkWorkerLoadable('var a=1,c=2;export{a as B,c as D};'), 'var a=1,c=2;export { a as B,c as D };\n');
  assert.match(transformBlobScript(checkWorkerLoadable('var a=1;export{a as B};'), 'http://x/g.js'), /exports\.B = a;/);
  for (const code of [
    'var s="import x from \'./y.js\'";export{s as S};',
    'var s="export const X = 1";export{s as S};',
    'var s="from \'./level.js\'";export{s as S};',
    'var s=1;export{s as S};var t=2;',
  ]) {
    assert.throws(() => checkWorkerLoadable(code), ExportError, code);
  }
});

test('what an export refuses, and what it only warns about', async () => {
  const ws = workspace();
  const run = (over, outDir = ws.outDir) => exportGame(request(over), { root: ROOT, outDir, engineBundle: ws.engineBundle });
  const refuses = async (over, status, why) => {
    await assert.rejects(run(over), (error) => error instanceof ExportError && error.status === status && why.test(error.message));
  };
  try {
    await refuses({ scene: '/../outside.js' }, 400, /not a path in the served folder/);
    await refuses({ scene: `${F}/game/none.js` }, 404, /scene module not found/);
    await refuses({ export: 'not a name' }, 400, /"export" must name/);
    await refuses({ sceneFiles: [`${F}/outside/elsewhere.scene.json`] }, 400, /outside the scene module's folder/);
    await refuses({ sceneFiles: [`${F}/game/fixtureScene.js`] }, 400, /not a scene file/);
    await refuses({ export: 'NoSuchScene', start: null, sceneFiles: [] }, 400, /does not export NoSuchScene/);
    await refuses({ atlas: { json: ATLAS_JSON, png: Buffer.from('not a png').toString('base64') } }, 400, /not a PNG/);
    await refuses({ scene: `${F}/outside/internalScene.js`, export: 'InternalScene', start: null, sceneFiles: [] }, 400,
      /imports \/src\/core\/sceneFile\.js, an engine module/);
    // An engine from before exports cannot load the game's levels: refused before anything is built.
    const old = path.join(ws.dir, 'old', 'weed.prod.bundle.min.js');
    fs.mkdirSync(path.dirname(old));
    fs.writeFileSync(old, '/* an older engine */');
    await assert.rejects(exportGame(request(), { root: ROOT, outDir: ws.outDir, engineBundle: old }),
      (error) => error.status === 500 && /older than exports \(it has no registerSceneFile\)/.test(error.message));
    assert.equal(fs.existsSync(ws.outDir), false, 'a refused export writes nothing');

    // A folder of other files is not replaced; an earlier export is.
    fs.mkdirSync(path.join(ws.dir, 'busy'));
    fs.writeFileSync(path.join(ws.dir, 'busy', 'notes.txt'), 'mine');
    await assert.rejects(run({}, path.join(ws.dir, 'busy')), (error) => error.status === 409);
    assert.equal(fs.readFileSync(path.join(ws.dir, 'busy', 'notes.txt'), 'utf8'), 'mine');

    const first = await run({ atlas: null, start: null, assets: [asset(`${F}/img/crate.png`), asset(`${F}/img/none.png`)] });
    assert.deepEqual(first.warnings, [`not found, not exported: ${F}/img/none.png`]);
    assert.ok(first.files.includes('assets/crate.png'), 'one asset: its own folder is the shared one');
    assert.ok(!first.files.some((f) => f.includes('atlas')));
    assert.match(fs.readFileSync(path.join(ws.outDir, 'index.html'), 'utf8'), /new URL\('\.\/game\.min\.js', import\.meta\.url\)\.href, \{ export: "FixtureScene"/);
    fs.writeFileSync(path.join(ws.outDir, 'stale.txt'), 'from before');
    const second = await run({});
    assert.ok(second.files.includes('assets/img/crate.png'));
    assert.equal(fs.existsSync(path.join(ws.outDir, 'stale.txt')), false, 'an earlier export is replaced whole');
  } finally {
    ws.remove();
  }
});

test('planExport: each scene file lands beside game.min.js at its path below the scene module, naming game.min.js', () => {
  const plan = planExport(request(), ROOT);
  assert.deepEqual(Object.keys(plan.files), ['levels/a.scene.json', 'levels/b.scene.json']);
  assert.equal(plan.files['levels/a.scene.json'].script, '../game.min.js');
  assert.equal(plan.startUrl, 'levels/a.scene.json');
  assert.deepEqual(plan.modules, [`${F}/game/fixtureScene.js`]);
  assert.deepEqual(plan.assetFiles.map((a) => a.target), ['assets/img/crate.png', 'assets/audio/thud.wav', 'assets/shaders/glow.frag']);
});
