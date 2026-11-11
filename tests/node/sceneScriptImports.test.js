// DX-GUARDS C10: a scene file that imports the engine. With the bundle, the workers rewrite the import and it works.
// From source, the page resolves '@weed.js/engine' through its import map and each worker could not: the worker
// logged the import error, then threw "entity classes not loaded: X. Pass the scene module URL to loadScene()", and
// loadScene never settled. A scene that imports the engine from another URL than the page holds a second copy of
// it: the page read "Scene module has no Scene export". Both now say what happened (checked in Chromium too).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

import { foreignSceneExports, pickSceneClass } from '../../src/util/sceneScript.js';
import { loadEntityScripts, unresolvedImportText } from '../../src/util/utils.js';

class Scene {}
class OtherCopyScene {}
Object.defineProperty(OtherCopyScene, 'name', { value: 'Scene' });
class Town extends OtherCopyScene {}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('a Scene from another copy of the engine is named for what it is', () => {
  assert.deepEqual(foreignSceneExports({ Town, helper: () => 1 }, Scene), ['Town']);
  assert.throws(() => pickSceneClass({ Town }, undefined, Scene), {
    message: /^WeedJS: the scene module exports Town, which extends a Scene from another copy of the engine: the scene file imports the engine from a different URL than the page does\./,
  });
  assert.throws(() => pickSceneClass({ Town }, 'Town', Scene), { message: /another copy of the engine/ });
  class Mine extends Scene {}
  assert.equal(pickSceneClass({ Mine, Town }, undefined, Scene), Mine, 'one of ours is still picked');
  assert.throws(() => pickSceneClass({ helper: () => 1 }, undefined, Scene), { message: 'Scene module has no Scene export' });
});

test("unresolvedImportText reads Chromium's, Firefox's and Node's bare-specifier errors", () => {
  const path = 'http://localhost/game/scene.js';
  for (const message of [
    'Failed to resolve module specifier "@weed.js/engine". Relative references must start with either "/", "./", or "../".',
    'The specifier \u201c@weed.js/engine\u201d was a bare specifier, but was not remapped to anything. Relative module specifiers must start with \u201c./\u201d, \u201c../\u201d or \u201c/\u201d.',
    "Cannot find package '@weed.js/engine' imported from D:\\game\\scene.js",
  ]) {
    assert.equal(
      unresolvedImportText(new TypeError(message), path),
      `WeedJS: ${path} imports "@weed.js/engine", which a worker cannot resolve: workers do not see the page's import ` +
        'map. A scene or entity file does not import the engine; every worker defines WEED, so take the names from it ' +
        '(const { Scene, GameObject } = WEED), as docs/guide/FIRST_GAME.md does.',
      message,
    );
  }
  assert.equal(unresolvedImportText(new SyntaxError('Unexpected token'), path), null);
});

test("a worker that cannot resolve a scene file's import stops with what to do", async () => {
  const url = pathToFileURL('tests/fixtures/c10/bareEngineImportScene.mjs').href;
  const saved = console.error;
  console.error = () => {};
  try {
    await assert.rejects(loadEntityScripts([url], {}, false), {
      message: new RegExp(`^WeedJS: ${escapeRe(url)} imports "weed-engine", which a worker cannot resolve`),
    });
  } finally {
    console.error = saved;
  }
});
