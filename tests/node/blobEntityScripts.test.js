import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blobModules,
  collectBlobScriptDeps,
  evaluateBlobModule,
  expandBlobEntityScripts,
  rewriteBlobImports,
  transformBlobScript,
} from '../../src/util/utils.js';

const CAMERA = `import { MySoldier } from './mySoldier.js';
import WEED from '/src/index.js';
export class CameraController {}
`;

const SOLDIER = `import { Person } from './person.js';
export class MySoldier extends Person {}
`;

test('collectBlobScriptDeps follows relative sibling, skips /src/', () => {
  const base = 'http://127.0.0.1/demos/predatorScene/gameObjects/cameraController.js';
  const deps = collectBlobScriptDeps(CAMERA, base);
  assert.deepEqual(deps, [
    'http://127.0.0.1/demos/predatorScene/gameObjects/mySoldier.js',
  ]);
});

test('rewriteBlobImports: a sibling import reads the worker global; a renamed one is bound; /src/ dropped', () => {
  const out = rewriteBlobImports(`import { MySoldier } from './mySoldier.js';
import { DIRECTION_UP as UP } from './dirs.js';
import WEED from '/src/index.js';
MySoldier.getAllActive();
`);
  assert.equal(
    out,
    `
if (!('DIRECTION_UP' in globalThis)) throw new Error('blob-dep DIRECTION_UP');
const UP = globalThis.DIRECTION_UP;

MySoldier.getAllActive();
`
  );
});

test('a renamed sibling export that is 0 counts as loaded (Predator could not load from a bundle)', () => {
  const body = rewriteBlobImports(`import { DIRECTION_ZERO as D } from './dirs.js';\nreturn D;\n`);
  globalThis.DIRECTION_ZERO = 0;
  try {
    assert.equal(new Function(body)(), 0);
  } finally {
    delete globalThis.DIRECTION_ZERO;
  }
  assert.throws(() => new Function(body)(), /blob-dep DIRECTION_ZERO/, 'still deferred before it is exported');
});

test('modules that import each other load: a method reads the other class when it runs', () => {
  // person.js imports Destination, destination.js imports Person (as Predator's do).
  const person = new Function(
    'exports',
    rewriteBlobImports(`import { Destination } from './destination.js';\nexports.Person = class Person { where() { return Destination.name; } };\n`),
  );
  const destination = new Function(
    'exports',
    rewriteBlobImports(`import { Person } from './person.js';\nexports.Destination = class Destination extends Person {};\n`),
  );
  const exports = {};
  try {
    assert.throws(() => destination(exports), ReferenceError, 'extends needs Person first: retried next pass');
    person(exports);
    globalThis.Person = exports.Person;
    destination(exports);
    globalThis.Destination = exports.Destination;
    assert.equal(new exports.Person().where(), 'Destination');
  } finally {
    delete globalThis.Person;
    delete globalThis.Destination;
  }
});

test('expandBlobEntityScripts DFS: deps before importer', async () => {
  const files = {
    'http://x/cameraController.js': CAMERA,
    'http://x/mySoldier.js': SOLDIER,
    'http://x/person.js': 'export class Person {}',
  };
  const fetchText = async (url) => ({
    ok: Object.prototype.hasOwnProperty.call(files, url),
    text: async () => files[url],
  });
  const ordered = await expandBlobEntityScripts(
    ['http://x/cameraController.js'],
    fetchText
  );
  assert.deepEqual(ordered, [
    'http://x/person.js',
    'http://x/mySoldier.js',
    'http://x/cameraController.js',
  ]);
});

// N-96: `export default` reached the worker's `new Function` untouched, a syntax error the loader's quiet retries hid;
// `import simplify2 from './vendor/simplify2.js'` then read a worker global nobody set ("simplify2 is not defined").
test('a default export in a bundled worker: every form of it', () => {
  const run = (src) => {
    const exports = {};
    new Function('exports', '__blobDefault', transformBlobScript(src, 'http://x/m.js'))(exports, null);
    return exports;
  };
  assert.equal(run('export default 42;').default, 42);
  const named = run('export default class Foo { static n() { return Foo.name; } }\nexport const k = Foo.n();\n');
  assert.equal(named.default.name, 'Foo');
  assert.equal(named.k, 'Foo', 'the class stays a declaration its module can name');
  assert.equal(run('export default function twice(x) { return 2 * x; }\nexport const four = twice(2);\n').four, 4);
  assert.equal(typeof run('export default class {}\n').default, 'function');
  assert.equal(run('const a = 1;\nexport { a as default };\n').default, 1);
});

test('a default import reads its module\'s default export by URL, once that module has run', () => {
  const base = 'http://x/demos/terrain/';
  const vendor = 'const simplify = (points) => points.length;\nexport default simplify;\n';
  const importer = "import simplify2 from './vendor/simplify2.js';\nexport const count = simplify2([1, 2, 3]);\n";
  const error = console.error;
  console.error = () => {};
  try {
    assert.throws(
      () => evaluateBlobModule(importer, `${base}worldGrid.js`, {}),
      /blob-dep http:\/\/x\/demos\/terrain\/vendor\/simplify2\.js/,
      'deferred until the vendor module has run',
    );
  } finally {
    console.error = error;
  }
  try {
    blobModules.set(`${base}vendor/simplify2.js`, evaluateBlobModule(vendor, `${base}vendor/simplify2.js`, {}));
    assert.equal(evaluateBlobModule(importer, `${base}worldGrid.js`, {}).count, 3);
  } finally {
    blobModules.delete(`${base}vendor/simplify2.js`);
  }
});

test('a default and named imports from one module', () => {
  assert.equal(
    rewriteBlobImports("import Grid, { CELL as C } from './grid.js';\n", 'http://x/a/b.js'),
    `const Grid = __blobDefault("http://x/a/grid.js");
if (!('CELL' in globalThis)) throw new Error('blob-dep CELL');
const C = globalThis.CELL;
`,
  );
});

test('a module a bundled worker cannot compile is reported by name', () => {
  const lines = [];
  const error = console.error;
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try {
    assert.throws(() => evaluateBlobModule('this is not javascript', 'http://x/broken.js', {}), SyntaxError);
  } finally {
    console.error = error;
  }
  assert.match(lines[0], /http:\/\/x\/broken\.js/);
});
