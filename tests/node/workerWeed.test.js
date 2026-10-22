import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WEED from '../../src/index.js';
import { WORKER_WEED } from '../../src/workers/workerWeed.js';
import { loadEntityScripts, transformBlobScript } from '../../src/util/utils.js';
import { bindSceneGraph } from '../../src/util/sceneScript.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Adding a WEED export? Add it to workerWeed.js too, or here if workers must not have it.
const MAIN_THREAD_ONLY = [
  'author',
  'github',
  'GameEngine',
  'BigAtlasInspector',
  'SaveGame',
  'SaveStore',
  'saveGame',
  'loadGame',
  'buildSavePayload',
  'encodeSave',
  'decodeSave',
  'setupWorkerCommunication',
];

test('worker WEED has every WEED name except the main-thread-only ones', () => {
  const missing = Object.keys(WEED).filter((k) => !(k in WORKER_WEED));
  assert.deepEqual(missing.sort(), [...MAIN_THREAD_ONLY].sort());
  assert.deepEqual(Object.keys(WORKER_WEED).filter((k) => !(k in WEED)), ['DecorationPool']);
  assert.deepEqual(Object.keys(WORKER_WEED.enums), Object.keys(WEED.enums));
});

test('worker WEED shares the engine objects; Scene and DebugUI are worker stand-ins', () => {
  const differ = Object.keys(WORKER_WEED).filter(
    (k) => k in WEED && k !== 'enums' && WORKER_WEED[k] !== WEED[k],
  );
  assert.deepEqual(differ.sort(), ['DebugUI', 'Scene']);
  assert.equal(WORKER_WEED.DebugUI, WEED.DebugDraw);
  assert.equal(typeof WORKER_WEED.Scene, 'function');
});

test('transformBlobScript keeps WEED destructuring as var, renames and nesting included', () => {
  const out = transformBlobScript(
    `const { Scene: Base, GameObject } = WEED;
let {
  Tween,
  enums: { ShapeType },
} = WEED;
const { BLEND_MODES } = enums;
const { CAMERA_TYPES } = WEED.enums;
const { a } = other; const { Time } = WEED;
export class S extends Base {}
`,
    'http://x/s.js',
  );
  assert.equal(
    out,
    `var { Scene: Base, GameObject } = WEED;
var {
  Tween,
  enums: { ShapeType },
} = WEED;
var { BLEND_MODES } = enums;
var { CAMERA_TYPES } = WEED.enums;
const { a } = other; var { Time } = WEED;
exports.S = class S extends Base {}
`,
  );
});

/** Load `files` the way a bundled (blob) worker does, with `globals` on the worker's global. */
async function loadInBlobWorker(files, entry, globals) {
  const saved = { self: globalThis.self, fetch: globalThis.fetch };
  const added = Object.keys(globals).filter((k) => !(k in globalThis));
  globalThis.self = { location: { href: 'blob:http://x/worker' } };
  globalThis.fetch = async (url) => ({
    ok: Object.prototype.hasOwnProperty.call(files, url),
    status: 404,
    statusText: 'Not Found',
    text: async () => files[url],
  });
  for (const k of added) globalThis[k] = globals[k];
  try {
    const context = { ...globals, WEED: WORKER_WEED };
    await loadEntityScripts([entry], context, false);
    return context;
  } finally {
    for (const k of added) delete globalThis[k];
    globalThis.self = saved.self;
    globalThis.fetch = saved.fetch;
  }
}

const ONE_FILE_SCENE = `// No import: the bundle defines WEED on the page and in every worker.
const { Scene, GameObject, SpriteRenderer, Tween, Time } = WEED;

class Dot extends GameObject {
  static components = [SpriteRenderer];
  tick() {
    Tween.to(this.index, { alpha: 0 }, 100 * Time.scale);
  }
}

export class OneFileScene extends Scene {
  static entities = [[Dot, 3]];
  create() {
    document.title = 'main thread only';
  }
}
`;

test('a one-file scene using the global WEED evaluates in a blob worker', async () => {
  const context = await loadInBlobWorker({ 'http://x/scene.js': ONE_FILE_SCENE }, 'http://x/scene.js', {});
  const SceneClass = context.OneFileScene;
  assert.equal(typeof SceneClass, 'function');
  assert.equal(Object.getPrototypeOf(SceneClass), WORKER_WEED.Scene);
  bindSceneGraph(SceneClass, context, WORKER_WEED.GameObject, WORKER_WEED.SharedResource);
  assert.equal(context.Dot, SceneClass.entities[0][0]);
  assert.deepEqual(context.Dot.components, [WORKER_WEED.SpriteRenderer]);
});

test('named imports from the package resolve to worker globals in a blob worker', async () => {
  const scene = `import { Scene, GameObject, Tween } from '@weed.js/engine';
class Dot extends GameObject {
  tick() { Tween.cancel(this.index); }
}
export class PackageScene extends Scene {
  static entities = [[Dot, 1]];
}
`;
  const context = await loadInBlobWorker({ 'http://x/scene.js': scene }, 'http://x/scene.js', WORKER_WEED);
  assert.equal(Object.getPrototypeOf(context.PackageScene), WORKER_WEED.Scene);
  assert.equal(Object.getPrototypeOf(context.PackageScene.entities[0][0]), WORKER_WEED.GameObject);
});

test('every demo and guide script that is a scene or entity module compiles after the blob transform', () => {
  const utils = fs.readFileSync(path.join(ROOT, 'src/util/utils.js'), 'utf8');
  const start = utils.indexOf('const moduleWrapper = new Function(');
  const end = utils.indexOf('transformedScript', start + 1);
  assert.ok(start >= 0 && end > start, 'wrapper not found');
  const wrapper = utils.slice(start, end);
  const params = [...wrapper.matchAll(/'([A-Za-z_$][\w$]*)'/g)].map((m) => m[1]);
  assert.ok(params.includes('WEED') && params.includes('GameObject'), 'wrapper params not found');

  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', 'tests', 'assets'].includes(e.name)) walk(f);
      } else if (e.name.endsWith('.js')) {
        files.push(f);
      }
    }
  })(path.join(ROOT, 'demos'));
  files.push(path.join(ROOT, 'docs/guide/first-game/coinRushScene.js'));

  const failures = [];
  let checked = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    if (!/extends\s+(GameObject|Scene|Component)\b/.test(text)) continue;
    checked++;
    try {
      new Function(...params, transformBlobScript(text, 'http://x/s.js'));
    } catch (e) {
      failures.push(`${path.relative(ROOT, f)}: ${e.message}`);
    }
  }
  assert.ok(checked > 50, `only ${checked} scripts checked`);
  assert.deepEqual(failures, []);
});

test('registerCoreClasses keeps the worker seeded rng; WEED.rng is the wrapper that calls it', async () => {
  // In a browser worker self === globalThis: WEED.rng on self.rng calls itself forever.
  const { loadWorker } = await import('../bench/workerHarness.mjs');
  const worker = await loadWorker('logicWorker.js', 'logicWorker');
  worker.initSeededRandom(42, 'w');
  const seeded = self.rng;
  worker.registerCoreClasses();
  assert.equal(self.rng, seeded);
  assert.equal(self.WEED, WORKER_WEED);
  assert.equal(self.Scene, WORKER_WEED.Scene);
  assert.equal(self.Tween, WORKER_WEED.Tween);
});
