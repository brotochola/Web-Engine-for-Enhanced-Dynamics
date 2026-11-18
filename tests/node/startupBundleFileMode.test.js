/**
 * SST-8, the bundle's file mode (scripts/buildBundle.js --files): the page's bundle starts its workers, Box2D and
 * engine.wasm from files in a folder beside it, so the browser can cache them and their compiled code, instead of
 * blobs made from strings on every visit. These run the build's real pieces: the folder writer on a stand-in for
 * webpack's worker output, the generated page entry in a vm with a fake Worker, and the Box2D worker script as a
 * physics worker would run it. The browser smoke (scripts/smokeBundleBrowser.mjs) boots a scene on the built files.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  ASSET_WORKER_NAMES,
  SCENE_WORKER_NAMES,
  WORKER_NAMES,
  buildBox2dWorkerSource,
  wasmAssetNames,
  weedFileModeUrl,
  writeFileModeBundleEntry,
  writeFileModeFolder,
} from '../../scripts/buildBundle.js';
import { createPhysicsWorker } from '../../src/util/sceneWorkerBootstrap.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BOX2D_DIR = path.join(root, 'src', 'box2d');

/**
 * What webpack's worker build writes (webpack.config.js), reduced to what the file mode depends on: each entry's
 * runtime takes its public path from its own URL (the folder + "../", minified as webpack writes it) and loads the
 * shared chunk with importScripts(p + u(id)); engine.js, in the shared chunk, names engine.wasm from p.
 */
const ENTRY_RUNTIME =
  'var i={g:self};' +
  '(()=>{var e;i.g.importScripts&&(e=i.g.location+"");' +
  'if(!e)throw new Error("Automatic publicPath is not supported in this browser");' +
  'e=e.replace(/^blob:/,"").replace(/#.*$/,"").replace(/\\?.*$/,"").replace(/\\/[^\\/]+$/,"/"),i.p=e+"../"})();' +
  'i.u=t=>"workers/worker_common.min.js";' +
  'importScripts(i.p+i.u(0));';

const FAKE_ENGINE_WASM = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);

function fakeWorkerBuild(dir, { wasmBytes = FAKE_ENGINE_WASM } = {}) {
  fs.mkdirSync(path.join(dir, 'workers'), { recursive: true });
  for (const name of SCENE_WORKER_NAMES) {
    fs.writeFileSync(path.join(dir, 'workers', `${name}.min.js`), `/*${name}*/${ENTRY_RUNTIME}`);
  }
  // An asset worker is one file with no chunk or asset to load: no public path at all.
  for (const name of ASSET_WORKER_NAMES) {
    fs.writeFileSync(path.join(dir, 'workers', `${name}.min.js`), `/*${name}*/self.onmessage=()=>{};`);
  }
  fs.writeFileSync(path.join(dir, 'workers', 'worker_common.min.js'), 'self.engineWasmUrl=new URL(i.p+"0a1b2c3d4e5f.wasm").href;');
  fs.writeFileSync(path.join(dir, '0a1b2c3d4e5f.wasm'), wasmBytes);
}

test('the wasm assets a webpack output names through its public path', () => {
  assert.deepEqual(wasmAssetNames('a=new URL(n.p+"ab12.wasm",n.b),b=new URL(n.p+"ab12.wasm",n.b);c=x.p + \'cd.wasm\''), [
    'ab12.wasm',
    'cd.wasm',
  ]);
  assert.deepEqual(wasmAssetNames('fetch("x.wasm")'), []);
});

test('the file mode folder: the worker build as webpack laid it out, Box2D beside it, named by its contents', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-file-mode-'));
  try {
    fakeWorkerBuild(tmp);
    const out = path.join(tmp, 'files');
    const first = writeFileModeFolder({ prod: true, box2dFileSource: '/* box2d */', workerBuildDir: tmp, outDir: out, engineWasmBytes: FAKE_ENGINE_WASM });
    assert.match(first.dirName, /^prod-[0-9a-f]{10}$/);
    assert.equal(first.box2dWorkerFile, `${first.dirName}/box2d/box2dWasm.js`);
    assert.deepEqual(Object.keys(first.workerFiles), WORKER_NAMES);

    for (const name of SCENE_WORKER_NAMES) {
      const code = fs.readFileSync(path.join(out, first.workerFiles[name]), 'utf8');
      assert.match(code, /\.p=self\.__weedWorkerFolder\|\|e\+"\.\.\/"/, name);
    }
    for (const name of ASSET_WORKER_NAMES) {
      assert.equal(fs.readFileSync(path.join(out, first.workerFiles[name]), 'utf8'), `/*${name}*/self.onmessage=()=>{};`);
    }
    const folder = path.join(out, first.dirName);
    assert.equal(fs.readFileSync(path.join(folder, 'box2d', 'box2dWasm.js'), 'utf8'), '/* box2d */');
    assert.ok(fs.readFileSync(path.join(folder, 'box2d', 'box2dWasm.wasm')).equals(fs.readFileSync(path.join(BOX2D_DIR, 'box2dWasm.wasm'))));

    // The same files give the same folder; one changed byte, another (a host may cache the old one for good).
    const again = writeFileModeFolder({ prod: true, box2dFileSource: '/* box2d */', workerBuildDir: tmp, outDir: out, engineWasmBytes: FAKE_ENGINE_WASM });
    assert.equal(again.dirName, first.dirName);
    const changedWasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 1]);
    fakeWorkerBuild(tmp, { wasmBytes: changedWasm });
    const changed = writeFileModeFolder({ prod: true, box2dFileSource: '/* box2d */', workerBuildDir: tmp, outDir: out, engineWasmBytes: changedWasm });
    assert.notEqual(changed.dirName, first.dirName);
    const debug = writeFileModeFolder({ prod: false, box2dFileSource: '/* box2d */', workerBuildDir: tmp, outDir: out, engineWasmBytes: changedWasm });
    // The engine's module is told from the other wasm by its bytes; none of them, and the build stops.
    assert.equal(changed.engineWasmFile, `${changed.dirName}/0a1b2c3d4e5f.wasm`);
    assert.throws(
      () => writeFileModeFolder({ prod: true, box2dFileSource: '', workerBuildDir: tmp, outDir: out, engineWasmBytes: FAKE_ENGINE_WASM }),
      /no worker names engine.wasm/,
    );
    assert.match(debug.dirName, /^debug-/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a file URL resolves from the bundle folder, and a folder on another origin says what to use instead', () => {
  const folder = 'https://game.test/dist/files/';
  assert.equal(
    weedFileModeUrl('prod-abc/workers/logicWorker.min.js', folder, 'https://game.test'),
    'https://game.test/dist/files/prod-abc/workers/logicWorker.min.js',
  );
  assert.equal(weedFileModeUrl('prod-abc/box2d/box2dWasm.js', 'https://cdn.test/x/', ''), 'https://cdn.test/x/prod-abc/box2d/box2dWasm.js');
  assert.throws(
    () => weedFileModeUrl('prod-abc/workers/logicWorker.min.js', 'https://cdn.test/x/', 'https://game.test'),
    /only from the page's own origin \(https:\/\/game\.test\).*single-file bundle/,
  );
});

/**
 * The generated page entry (the part buildBundle.js writes; webpack adds the engine and the public path), run in a
 * vm: the two lines that import the engine become a stand-in, __webpack_public_path__ is the bundle's folder.
 */
function runFileModeEntry({ bundleFolderUrl, pageOrigin, folder = 'prod-abc' }) {
  const entry = writeFileModeBundleEntry({
    workerFiles: Object.fromEntries(WORKER_NAMES.map((n) => [n, `${folder}/workers/${n}.min.js`])),
    box2dWorkerFile: `${folder}/box2d/box2dWasm.js`,
    engineWasmFile: `${folder}/0a1b2c3d4e5f.wasm`,
    audioWorkletSource: '/* worklet */',
    debugUICSS: '',
    engineShaders: { '/src/shaders/a.frag': 'void main(){}' },
    prod: true,
  });
  const lines = entry.split('\n');
  const swap = (from, to) => {
    const i = lines.indexOf(from);
    assert.ok(i >= 0, `the entry has no line ${from}`);
    lines[i] = to;
  };
  swap("import WEED_BASE from './index.js';", 'const WEED_BASE = { GameEngine: function GameEngine() {}, params: { a: 1 } };');
  swap("export * from './index.js';", '');
  swap('export default WEED;', 'globalThis.exported = WEED;');
  const created = [];
  const blobs = new Map();
  class PageURL extends URL {
    static createObjectURL(blob) {
      const url = `blob:${pageOrigin}/${blobs.size}`;
      blobs.set(url, blob.text);
      return url;
    }
  }
  const context = vm.createContext({
    __webpack_public_path__: bundleFolderUrl,
    location: { origin: pageOrigin },
    window: {},
    URL: PageURL,
    Blob: class {
      constructor(parts, options) {
        this.text = parts.join('');
        this.type = options?.type;
      }
    },
    Worker: class {
      constructor(url, options) {
        this.url = url;
        created.push({ url, options, script: blobs.get(url) ?? null });
      }

      terminate() {}
    },
  });
  vm.runInContext(lines.join('\n'), context);
  return { WEED: context.exported, window: context.window, created };
}

/**
 * A classic worker as the browser runs it: `scriptText` evaluated with self.location at `workerUrl`; importScripts
 * reads the files a static server would serve from `servedDir` at `servedUrl` and evaluates them in the same global.
 */
function runClassicWorker({ scriptText, workerUrl, servedUrl, servedDir }) {
  const imported = [];
  const context = vm.createContext({ location: { href: workerUrl, toString: () => workerUrl }, URL });
  context.self = context;
  context.importScripts = (...urls) => {
    for (const url of urls) {
      imported.push(url);
      assert.ok(url.startsWith(servedUrl), `importScripts(${url}) is outside the bundle folder`);
      const file = path.join(servedDir, ...url.slice(servedUrl.length).split('/'));
      vm.runInContext(fs.readFileSync(file, 'utf8'), context);
    }
  };
  vm.runInContext(scriptText, context);
  return { imported, context };
}

test('a file mode worker, started from its blob or from its own URL, loads its shared chunk and wasm from its folder', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-file-mode-'));
  try {
    fakeWorkerBuild(tmp);
    const out = path.join(tmp, 'files');
    const folder = writeFileModeFolder({ prod: true, box2dFileSource: '', workerBuildDir: tmp, outDir: out, engineWasmBytes: FAKE_ENGINE_WASM });
    const servedUrl = 'https://game.test/dist/files/';
    const { WEED, created } = runFileModeEntry({
      bundleFolderUrl: servedUrl,
      pageOrigin: 'https://game.test',
      folder: folder.dirName,
    });
    const workerFile = `${servedUrl}${folder.dirName}/workers/logicWorker.min.js`;
    const folderUrl = `${servedUrl}${folder.dirName}/`;

    WEED.createWorker('logicWorker');
    const [{ url: starterUrl, script, options }] = created;
    assert.match(starterUrl, /^blob:/);
    assert.equal(options, undefined); // classic, as webpack's worker build (importScripts) needs
    // Its own URL a blob, as the single-file bundle's workers: the engine evaluates game scripts from their text.
    const fromBlob = runClassicWorker({ scriptText: script, workerUrl: starterUrl, servedUrl, servedDir: out });
    assert.deepEqual(fromBlob.imported, [workerFile, `${folderUrl}workers/worker_common.min.js`]);
    assert.equal(fromBlob.context.engineWasmUrl, `${folderUrl}0a1b2c3d4e5f.wasm`);
    // The page compiles the same file (SST-2), so the module it posts is the one the workers name.
    assert.equal(WEED.EngineWasmUrl, fromBlob.context.engineWasmUrl);
    assert.ok(fs.existsSync(path.join(out, folder.dirName, '0a1b2c3d4e5f.wasm')));

    // The same file started from its own URL finds the same folder.
    const direct = runClassicWorker({
      scriptText: fs.readFileSync(path.join(out, folder.workerFiles.logicWorker), 'utf8'),
      workerUrl: workerFile,
      servedUrl,
      servedDir: out,
    });
    assert.equal(direct.context.engineWasmUrl, `${folderUrl}0a1b2c3d4e5f.wasm`);

    // One starter a worker name: the spatial workers share theirs.
    WEED.createWorker('spatialWorker');
    WEED.createWorker('spatialWorker');
    assert.equal(created[1].url, created[2].url);
    assert.notEqual(created[1].url, created[0].url);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the file mode entry starts each engine worker on its file beside the bundle', async () => {
  const { WEED, window, created } = runFileModeEntry({
    bundleFolderUrl: 'https://game.test/dist/files/',
    pageOrigin: 'https://game.test',
  });
  assert.equal(window.WEED, WEED);
  assert.equal(WEED.BUNDLE_MODE, true);
  assert.equal(WEED.BUNDLE_WORKER_FILES, true);
  assert.equal(WEED.params.a, 1);
  await WEED.ensureEmbeddedSources();
  assert.equal(WEED.AudioWorkletSource, '/* worklet */');
  assert.equal(WEED.EngineShaders['/src/shaders/a.frag'], 'void main(){}');
  // sceneWorkerBootstrap takes the bundle's path when WEED.WorkerSources is set.
  assert.equal(WEED.WorkerSources.logicWorker, 'https://game.test/dist/files/prod-abc/workers/logicWorker.min.js');
  for (const name of WORKER_NAMES) WEED.createWorker(name);
  assert.deepEqual(
    created.map((c) => c.script),
    WORKER_NAMES.map(
      (n) => 'self.__weedWorkerFolder="https://game.test/dist/files/prod-abc/";'
        + `importScripts("https://game.test/dist/files/prod-abc/workers/${n}.min.js");`,
    ),
  );
  assert.throws(() => WEED.createWorker('nope'), /Unknown worker: nope/);
  assert.equal(WEED.getBox2dWorkerUrl(), 'https://game.test/dist/files/prod-abc/box2d/box2dWasm.js');
  assert.equal(WEED.EngineWasmUrl, 'https://game.test/dist/files/prod-abc/0a1b2c3d4e5f.wasm');
});

test('the file mode entry loaded from another origin evaluates, and stops only when it starts a worker', () => {
  const { WEED, created } = runFileModeEntry({ bundleFolderUrl: 'https://cdn.test/npm/x/dist/files/', pageOrigin: 'https://game.test' });
  assert.ok(WEED.WorkerSources.spatialWorker.startsWith('https://cdn.test/'));
  assert.throws(() => WEED.createWorker('spatialWorker'), /page's own origin/);
  assert.throws(() => WEED.getBox2dWorkerUrl(), /page's own origin/);
  assert.equal(created.length, 0);
});

test("the scene's asset workers (atlas, tilemap) start from the file mode bundle, as the page asks for them", async () => {
  const { startAssetWorker } = await import('../../src/core/assetWorkerClient.js');
  const { WEED, created } = runFileModeEntry({ bundleFolderUrl: 'https://game.test/dist/files/', pageOrigin: 'https://game.test' });
  const hadWindow = 'window' in globalThis;
  const originalWindow = globalThis.window;
  const hadOffscreen = 'OffscreenCanvas' in globalThis;
  const hadWorker = 'Worker' in globalThis;
  globalThis.window = { WEED };
  if (!hadOffscreen) globalThis.OffscreenCanvas = class {};
  if (!hadWorker) globalThis.Worker = class {}; // startAssetWorker asks whether the page has workers at all
  try {
    for (const name of ASSET_WORKER_NAMES) {
      const worker = await startAssetWorker(name);
      assert.ok(worker, name);
      worker.close();
    }
  } finally {
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
    if (!hadOffscreen) delete globalThis.OffscreenCanvas;
    if (!hadWorker) delete globalThis.Worker;
  }
  assert.deepEqual(
    created.map((c) => c.script.match(/importScripts\("([^"]+)"\)/)[1]),
    ASSET_WORKER_NAMES.map((n) => `https://game.test/dist/files/prod-abc/workers/${n}.min.js`),
  );
});

test("the engine's physics worker starts on the file mode's Box2D file, its memory size in its name", () => {
  const { WEED } = runFileModeEntry({ bundleFolderUrl: 'https://game.test/dist/files/', pageOrigin: 'https://game.test' });
  const OriginalWorker = globalThis.Worker;
  const hadWindow = 'window' in globalThis;
  const originalWindow = globalThis.window;
  const created = [];
  globalThis.Worker = class {
    constructor(url, options) {
      created.push({ url, options });
    }
  };
  globalThis.window = { WEED };
  try {
    createPhysicsWorker(true, '?v=1', { wasmMemoryMB: 64 });
  } finally {
    globalThis.Worker = OriginalWorker;
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
  }
  assert.deepEqual(created, [
    { url: 'https://game.test/dist/files/prod-abc/box2d/box2dWasm.js', options: { name: 'physics pages=1024 mb=64' } },
  ]);
});

/**
 * The Box2D worker script run as the browser runs it in a worker at `scriptUrl` (the glue, the pre-js that sizes its
 * memory, the preamble that hands the embedded siblings to importScripts), up to the wasm load: fetch, importScripts,
 * blobs and WebAssembly are fakes that record what they were asked for.
 */
function runBox2dWorkerScript(source, { workerName, scriptUrl }) {
  const calls = { fetch: [], instantiateStreaming: 0, instantiate: 0, importScripts: [], workers: [] };
  const blobs = new Map();
  class FakeMemory {
    constructor(descriptor) {
      this.descriptor = { ...descriptor };
    }
  }
  const webAssembly = Object.create(WebAssembly);
  webAssembly.Memory = FakeMemory;
  webAssembly.instantiateStreaming = () => {
    calls.instantiateStreaming++;
    return new Promise(() => {});
  };
  webAssembly.instantiate = () => {
    calls.instantiate++;
    return new Promise(() => {});
  };
  class FakeURL extends URL {
    static createObjectURL(blob) {
      const url = `blob:https://game.test/${blobs.size}`;
      blobs.set(url, blob.text);
      return url;
    }
  }
  const context = vm.createContext({
    name: workerName,
    location: { href: scriptUrl },
    WorkerGlobalScope: function WorkerGlobalScope() {},
    WebAssembly: webAssembly,
    URL: FakeURL,
    // A real Blob (the single-file script inflates its wasm through one), its text kept for importScripts.
    Blob: class extends Blob {
      constructor(parts, options) {
        super(parts, options);
        this.text = parts.every((p) => typeof p === 'string') ? parts.join('') : null;
      }
    },
    atob,
    Response,
    DecompressionStream,
    fetch: (url) => {
      calls.fetch.push(String(url));
      return new Promise(() => {});
    },
    importScripts: (...urls) => calls.importScripts.push(...urls.map((u) => blobs.get(u) ?? u)),
    Worker: class {
      constructor(url) {
        calls.workers.push(url);
      }
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    performance,
    navigator: { hardwareConcurrency: 4 },
    TextDecoder,
    addEventListener() {},
  });
  context.self = context;
  context.globalThis = context;
  vm.runInContext(source, context);
  return { calls, context };
}

const SCRIPT_URL = 'https://game.test/dist/files/prod-abc/box2d/box2dWasm.js';

test('the file mode Box2D worker streams box2dWasm.wasm from beside it and loads its siblings from the script', () => {
  const { calls } = runBox2dWorkerScript(buildBox2dWorkerSource({ embedWasm: false }), {
    workerName: 'physics pages=256 mb=16',
    scriptUrl: SCRIPT_URL,
  });
  assert.deepEqual(calls.fetch, ['https://game.test/dist/files/prod-abc/box2d/box2dWasm.wasm']);
  assert.equal(calls.instantiateStreaming, 1);
  assert.equal(calls.instantiate, 0);
  // weedjsPost.js and physicsHostImpl.js, from the script's own strings (blobs), not one request each.
  assert.deepEqual(calls.importScripts, [
    fs.readFileSync(path.join(BOX2D_DIR, 'weedjsPost.js'), 'utf8'),
    fs.readFileSync(path.join(BOX2D_DIR, 'physicsHostImpl.js'), 'utf8'),
  ]);
});

test('the single-file Box2D worker inflates its embedded wasm and fetches nothing', () => {
  const { calls, context } = runBox2dWorkerScript(buildBox2dWorkerSource(), {
    workerName: 'physics pages=256 mb=16',
    scriptUrl: 'blob:https://game.test/box2d',
  });
  assert.deepEqual(calls.fetch, []);
  assert.equal(calls.instantiateStreaming, 0);
  assert.equal(typeof context.Module.instantiateWasm, 'function');
  assert.equal(calls.importScripts.length, 2);
});

test("the file mode Box2D worker's pthread helpers load no sibling and no wasm (they receive the module)", () => {
  const { calls } = runBox2dWorkerScript(buildBox2dWorkerSource({ embedWasm: false }), {
    workerName: 'em-pthread',
    scriptUrl: SCRIPT_URL,
  });
  assert.deepEqual(calls.fetch, []);
  assert.deepEqual(calls.importScripts, []);
  assert.equal(calls.instantiateStreaming, 0);
});
