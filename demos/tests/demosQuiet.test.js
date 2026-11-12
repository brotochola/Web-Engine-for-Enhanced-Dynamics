import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import '../../tests/helpers/registerWebRoot.mjs';

// DX-GUARDS: the engine's load-time guards (config keys, entity classes) must not warn about a demo or a stress
// scene that is right. Each scene is built here as the page builds it, and what it warns or logs as an error is
// compared with the list below: the warnings a scene gives today on purpose. A guard that warns about one of these
// scenes is either wrong (fix the guard) or right (fix the scene in a commit of its own).

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEED = (await import('../../src/index.js')).default;
const { resetWarnOnce } = await import('../../src/util/dxWarn.js');
const { checkFirstInstance } = await import('../../src/core/debug/devChecks.js');
globalThis.WEED = WEED; // landingScene reads the global, as a page that imported the engine has it

/** scene file (from the repo root) and export → the lines it gives on purpose. */
const EXPECTED = {
  'tests/bench/stressScenes/bunnyMarkN1HuntScene.js BunnyMarkN1HuntScene': [
    'W WeedJS: renderer.interpolation ignores GPU sprite rows packed on the pre-render worker. Sprite pack runs on Pixi. Set preRender.packGpuSprites to "pixi".',
  ],
};

function sceneFiles() {
  const out = [];
  const demos = join(root, 'demos');
  for (const name of readdirSync(demos, { recursive: true })) {
    if (typeof name !== 'string' || !name.endsWith('.js') || name.replace(/\\/g, '/').startsWith('tests/')) continue;
    if (/extends\s+(WEED\.)?[A-Za-z]*Scene\b/.test(readFileSync(join(demos, name), 'utf8'))) out.push(join(demos, name));
  }
  const stress = join(root, 'tests', 'bench', 'stressScenes');
  for (const name of readdirSync(stress)) if (name.endsWith('.js')) out.push(join(stress, name));
  return out;
}

test('every demo and stress scene builds with only the warnings it gives on purpose', async () => {
  const files = sceneFiles();
  assert.ok(files.length > 80, `only ${files.length} scene files found`);
  const saved = { warn: console.warn, error: console.error, log: console.log, info: console.info };
  const got = {};
  let built = 0;
  let pageChecked = 0;
  try {
    for (const file of files) {
      const rel = relative(root, file).replace(/\\/g, '/');
      const lines = [];
      console.warn = (...a) => lines.push(`W ${a.join(' ')}`);
      console.error = (...a) => lines.push(`E ${a.join(' ')}`);
      console.log = console.info = () => {};
      const ns = await import(pathToFileURL(file).href);
      if (lines.length) got[`${rel} (import)`] = lines.splice(0);
      for (const [name, value] of Object.entries(ns)) {
        if (typeof value !== 'function' || !(value.prototype instanceof WEED.Scene)) continue;
        resetWarnOnce();
        lines.length = 0;
        const scene = new value({});
        built++;
        // E1 (a field that hides an accessor) on each class's first page instance, as Scene._createPageInstances does.
        // A constructor that needs the shared buffers (not made here) is skipped.
        for (const r of scene.registeredClasses) {
          if (!(r.count > 0)) continue;
          let instance = null;
          try {
            instance = new r.class(r.startIndex, scene.config, null, { page: true });
          } catch {
            continue;
          }
          pageChecked++;
          checkFirstInstance(instance);
        }
        const left = lines.splice(0);
        if (left.length) got[`${rel} ${name}`] = left;
      }
    }
  } finally {
    Object.assign(console, saved);
  }
  assert.ok(built > 120, `only ${built} scenes built`);
  assert.ok(pageChecked > 150, `only ${pageChecked} page instances checked`);
  assert.deepEqual(got, EXPECTED);
});
