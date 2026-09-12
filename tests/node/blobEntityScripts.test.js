import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectBlobScriptDeps,
  expandBlobEntityScripts,
  rewriteBlobImports,
} from '../../src/core/utils.js';

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

test('rewriteBlobImports: sibling named import becomes globalThis const, /src/ dropped', () => {
  const out = rewriteBlobImports(`import { MySoldier } from './mySoldier.js';
import WEED from '/src/index.js';
MySoldier.getAllActive();
`);
  assert.equal(
    out,
    `if (!globalThis.MySoldier) throw new Error('blob-dep MySoldier');
const MySoldier = globalThis.MySoldier;

MySoldier.getAllActive();
`
  );
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
