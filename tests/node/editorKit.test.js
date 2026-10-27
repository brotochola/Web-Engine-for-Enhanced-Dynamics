// The editor as its own package (VISUAL_EDITOR_PLAN.md ED-29): every module the editor imports from outside its
// folder is one the engine's debug build publishes in WEED_EDITOR_KIT, under its path from src/, as that very module;
// the editor's bundle reads them from there (webpack.editor.config.js), and an import the kit lacks fails its build.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { editorKit } from '../../src/core/debug/editorKit.js';
import { editorKitKeys, kitExternal } from '../../webpack.editor.config.js';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const src = path.join(root, 'src');
const editorDir = path.join(src, 'core/debug/editor');

/** Every import of the editor's modules that leads out of its folder, by its path under src/. */
function outsideImports() {
  const keys = new Set();
  for (const name of fs.readdirSync(editorDir)) {
    if (!name.endsWith('.js')) continue;
    const source = fs.readFileSync(path.join(editorDir, name), 'utf8');
    for (const [, request] of source.matchAll(/^\s*(?:import|export)[^'"]*?from\s+'(\.[^']+)'/gm)) {
      const target = path.resolve(editorDir, request);
      if (!target.startsWith(editorDir + path.sep)) keys.add(path.relative(src, target).split(path.sep).join('/'));
    }
  }
  return keys;
}

test('the kit publishes every engine module the editor imports, as that very module', async () => {
  const imports = outsideImports();
  assert.ok(imports.size > 10, 'the editor reads the engine');
  for (const key of imports) {
    assert.ok(Object.hasOwn(editorKit, key), `the editor imports src/${key}: editorKit.js must publish it`);
    const module = await import(pathToFileURL(path.join(src, key)).href);
    assert.equal(editorKit[key], module, `${key}: the engine's own module, not a copy`);
  }
  assert.deepEqual(editorKitKeys(), new Set(Object.keys(editorKit)), 'the build reads the same keys from the source');
});

test('the editor bundle bundles its own modules and reads the engine’s from the kit; an unknown one fails the build', () => {
  const external = kitExternal(new Set(['core/camera.js']));
  const ask = (context, request) => {
    let out;
    external({ context, request }, (error, value, type) => {
      out = error ? { error: error.message } : value === undefined ? 'bundled' : { value, type };
    });
    return out;
  };
  assert.equal(ask(editorDir, './history.js'), 'bundled');
  assert.deepEqual(ask(editorDir, '../../camera.js'), { value: 'globalThis.WEED_EDITOR_KIT["core/camera.js"]', type: 'var' });
  assert.match(ask(editorDir, '../../layer.js').error, /imports src\/core\/layer\.js, which src\/core\/debug\/editorKit\.js does not publish/);
  assert.equal(ask(path.join(src, 'core'), './camera.js'), 'bundled', 'not an import of the editor');
  assert.equal(ask(editorDir, 'node:fs'), 'bundled', 'a bare name is not the kit’s');
});
