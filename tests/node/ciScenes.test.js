// The scenes GitHub times (sceneList.mjs, collect.mjs's sceneTable, measure:all's page): which ones both revisions have,
// whether they are the same scene, and which numbers are not to be read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { page } from '../../scripts/measureAll.mjs';
import { framesDoubt, readJobs, sceneTable } from '../bench/ci/collect.mjs';
import { ALL_SCENE_PATHS, changedModules, exportedScene, sceneModules, scenesOfBoth } from '../bench/ci/sceneList.mjs';
import { repoRoot } from '../bench/revWorktree.mjs';

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-scenes-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test('a scene is the same on both sides when its file and every demo module it reaches are; the engine is not its module', () => {
  const scene = "import WEED from '/src/index.js';\nimport { Boid } from '../boid.js';\nimport('/demos/lazy.js');\nexport class AScene extends WEED.Scene {}\n";
  const a = tree({
    'demos/a/a.js': scene, 'demos/boid.js': "import './deep.js';\n", 'demos/deep.js': '1;', 'demos/lazy.js': '2;', 'src/index.js': 'old',
    'demos/gone.js': 'export class GoneScene extends Scene {}\n',
  });
  const b = tree({
    'demos/a/a.js': scene, 'demos/boid.js': "import './deep.js';\n", 'demos/deep.js': '1; // more', 'demos/lazy.js': '2;', 'src/index.js': 'new',
  });
  try {
    assert.deepEqual(sceneModules(a, '/demos/a/a.js'), ['demos/a/a.js', 'demos/boid.js', 'demos/deep.js', 'demos/lazy.js']);
    assert.deepEqual(changedModules(a, b, '/demos/a/a.js'), ['demos/deep.js']);
    assert.deepEqual(changedModules(a, a, '/demos/a/a.js'), []);
    assert.equal(exportedScene(a, '/demos/a/a.js'), 'AScene');
    const both = scenesOfBoth(a, b, ['/demos/a/a.js', '/demos/gone.js']);
    assert.deepEqual(both.map((s) => [s.key, s.exportName, s.exportNameA, s.changed.length]), [['a', 'AScene', 'AScene', 1]]);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('every scene of the list exports its class in this tree', () => {
  for (const file of ALL_SCENE_PATHS) assert.ok(exportedScene(repoRoot, file), file);
});

test('a worker that ran a few frames, or other frames than its other side, is not to be read', () => {
  assert.equal(framesDoubt(480, 470, 8000), null);
  assert.equal(framesDoubt(480, 2, 8000), 'few frames');
  assert.equal(framesDoubt(119, 480, 8000), 'few frames');
  assert.equal(framesDoubt(130, 140, 8000), null);
  assert.equal(framesDoubt(300, 480, 8000), 'other frames');
});

test('the page says why a scene\'s number is not to be read, and which scenes are not the same', () => {
  const run = (ms, frames) => ({ ms, frames });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-scenes-'));
  try {
    for (const id of ['s-linux-1', 's-linux-2']) {
      fs.mkdirSync(path.join(dir, id));
      fs.writeFileSync(path.join(dir, id, 'job.json'), JSON.stringify({ id, machineKey: 'linux' }));
      fs.writeFileSync(path.join(dir, id, 'result.json'), JSON.stringify({
        kind: 'sceneAb', durationMs: 8000,
        rows: [{
          scene: 'bunnyMark', changed: ['demos/bunnyMarkScene/bunnyMarkScene.js'],
          a: [run({ logic: 1, renderer: 1 }, { logic: 480, renderer: 2 })], b: [run({ logic: 0.8, renderer: 1.4 }, { logic: 480, renderer: 3 })],
        }, {
          scene: 'boids', changed: [], a: [run({ logic: 1 }, { logic: 480 })], b: [run({ logic: 1 }, { logic: 480 })],
        }],
      }));
    }
    const scenes = sceneTable(readJobs(dir));
    const renderer = scenes.rows.find((r) => r.worker === 'renderer');
    assert.equal(renderer.doubt, 'few frames');
    assert.deepEqual([renderer.framesA, renderer.framesB], [2, 3]);
    assert.equal(scenes.rows.find((r) => r.scene === 'bunnyMark' && r.worker === 'logic').doubt, null);
    const facts = { version: '1', bytes: {}, lines: { code: 1, comment: 1 }, tests: { engine: 1, demos: 1 } };
    const text = page({ a: 'A', b: 'B', shaA: 'a'.repeat(40), shaB: 'b'.repeat(40), factsA: facts, factsB: facts, kernels: null, scenes, machines: ['linux'], health: '' });
    assert.match(text, /\| bunnyMark \* \| renderer \| 1 > 1\.4 ms, \+40\.0 %[^|]*\(few frames: 2 \/ 3\)/);
    assert.match(text, /\| bunnyMark \* \| logic \| 1 > 0\.8 ms, \*\*-20\.0 %\*\*/);
    assert.match(text, /\| boids \| logic /);
    assert.match(text, /- bunnyMark \*: demos\/bunnyMarkScene\/bunnyMarkScene\.js/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
