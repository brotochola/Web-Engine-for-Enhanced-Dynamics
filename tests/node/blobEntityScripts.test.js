import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectBlobScriptDeps,
  expandBlobEntityScripts,
  rewriteBlobImports,
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
