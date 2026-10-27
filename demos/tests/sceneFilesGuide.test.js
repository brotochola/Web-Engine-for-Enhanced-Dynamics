// docs/guide/SCENE_FILES.md (VISUAL_EDITOR_PLAN.md ED-1): the guide's examples must run. A js block whose first
// line names a demo file is that file's code, word for word ("// …" skips lines). The scene file loads in the
// platformer; the entity lines spawn in the order the guide says; the other classes are evaluated, and their
// spawnParams fill and their onSpawned runs as the guide says. The kinds table, the debug warning and the full-load
// reasons are what the engine has and prints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../../tests/helpers/registerWebRoot.mjs';

import { parseSceneFile, sceneFileScriptUrl, sceneFileSpawnOrder, sceneFileSpawnConfig } from '../../src/core/sceneFile.js';
import {
  describeSpawnParams,
  createSpawnParamsState,
  fillSpawnParams,
  releaseSpawnParams,
  SPAWN_PARAM_KINDS,
} from '../../src/core/spawnParams.js';
import { checkSpawnConfig } from '../../src/core/debug/spawnParamsCheck.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Component } from '../../src/core/component.js';
import { Layer } from '../../src/core/layer.js';
import { clearSceneDirty } from '../../src/core/sceneDirty.js';
import { Joint } from '../../src/core/joint.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import { addFileJoint, JOINT_TYPES, JOINT_SETTINGS } from '../../src/core/sceneFileJoints.js';
import { decorationClassOf, decorationSpawnConfig } from '../../src/core/sceneFileDecorations.js';

const { PlatformerGameScene } = await import('../platformerGameScene/platformerGameScene.js');
const { Platform } = await import('../platformerGameScene/gameObjects/platform.js');

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8').replace(/\r\n/g, '\n');
const guide = read('docs/guide/SCENE_FILES.md');
const blocks = [...guide.matchAll(/^```(\w+)\n([\s\S]*?)\n```$/gm)].map(([, lang, body]) => ({ lang, body }));
const jsonBlocks = blocks.filter((b) => b.lang === 'json');
/** A block that is one of a file's sections (joints, decorations), as it sits in the file. */
const SECTION = /^"(joints|decorations)": \[/;
const sectionBlock = (name) => {
  const found = jsonBlocks.filter((b) => b.body.startsWith(`"${name}": [`));
  assert.equal(found.length, 1, `one "${name}" block`);
  return found[0].body;
};

/** The lines of a block in runs, split at its `// …` lines, without blank lines at either end of a run. */
function runs(lines) {
  const out = [[]];
  for (const line of lines) {
    if (line.trim() === '// …') out.push([]);
    else out[out.length - 1].push(line.trimEnd());
  }
  return out
    .map((run) => {
      let a = 0;
      let b = run.length;
      while (a < b && run[a] === '') a++;
      while (b > a && run[b - 1] === '') b--;
      return run.slice(a, b);
    })
    .filter((run) => run.length > 0);
}

function indexOfRun(lines, run, from) {
  for (let i = from; i + run.length <= lines.length; i++) {
    let j = 0;
    while (j < run.length && lines[i + j] === run[j]) j++;
    if (j === run.length) return i;
  }
  return -1;
}

/** Evaluate a block that declares classes; returns them by name. */
function evaluate(body) {
  const names = [...body.matchAll(/^class (\w+) extends/gm)].map((m) => m[1]);
  return new Function('GameObject', 'Component', `${body}\nreturn { ${names.join(', ')} };`)(GameObject, Component);
}

test('a block that names a demo file is that file’s code, in order', () => {
  const quoted = blocks.filter((b) => b.lang === 'js' && b.body.startsWith('// demos/'));
  assert.ok(quoted.length >= 4, `found ${quoted.length}`);
  for (const { body } of quoted) {
    const [first, ...rest] = body.split('\n');
    const path = first.slice(3);
    const file = read(path).split('\n').map((line) => line.trimEnd());
    let from = 0;
    for (const run of runs(rest)) {
      const at = indexOfRun(file, run, from);
      assert.ok(at >= 0, `${path} has no\n${run.join('\n')}\n(from line ${from + 1})`);
      from = at + run.length;
    }
  }
});

test('the example scene file loads in the platformer: its scene class, its classes, its pools', () => {
  const files = jsonBlocks.filter((b) => b.body.includes('"format"'));
  assert.equal(files.length, 1);
  const doc = parseSceneFile(files[0].body, 'SCENE_FILES.md');
  // As if it were next to the platformer's levels.
  const at = new URL('demos/platformerGameScene/levels/example.scene.json', root).href;
  assert.equal(sceneFileScriptUrl(doc, at), new URL('demos/platformerGameScene/platformerGameScene.js', root).href);
  assert.equal(doc.export, PlatformerGameScene.name);
  const pools = new Map(PlatformerGameScene.entities.map(([C, n]) => [C.name, n]));
  const placed = new Map();
  for (const e of doc.entities) placed.set(e.class, (placed.get(e.class) || 0) + 1);
  for (const [cls, n] of placed) assert.ok(n <= (pools.get(cls) ?? 0), `${cls}: ${n} in a pool of ${pools.get(cls)}`);
});

test('Guard: the door spawns first, and onSpawned keeps its index, the speed and the mode', () => {
  const free = blocks.filter((b) => b.lang === 'js' && b.body.includes('class Guard extends GameObject'));
  assert.equal(free.length, 1);
  const { Guard } = evaluate(free[0].body);
  assert.deepEqual(describeSpawnParams(Guard).kindNames, ['points', 'enum', 'number', 'entity']);

  const lines = jsonBlocks.filter((b) => !b.body.includes('"format"') && !SECTION.test(b.body));
  assert.equal(lines.length, 1);
  const doc = parseSceneFile(`{ "format": 1, "script": "x.js", "entities": [${lines[0].body}] }`, 'SCENE_FILES.md');
  const { order, backRefs } = sceneFileSpawnOrder(doc.entities, (name) => (name === 'Guard' ? Guard : undefined));
  assert.deepEqual(
    order.map((i) => doc.entities[i].name),
    ['Door1', 'Guard1'],
  );

  // Door1 spawned at index 7.
  const guardAt = doc.entities.findIndex((e) => e.name === 'Guard1');
  const cfg = sceneFileSpawnConfig(doc.entities[guardAt], guardAt, Guard, (name) => (name === 'Door1' ? 7 : -1), backRefs);
  const door = { index: 7 };
  const instances = [];
  instances[7] = door;
  const state = createSpawnParamsState(Guard);
  const params = fillSpawnParams(state, cfg, instances);
  try {
    assert.equal(params.door, door);
    assert.ok(params.route instanceof Float64Array);
    assert.deepEqual([...params.route], [300, 900, 700, 900]);
    const self = { guardState: {} };
    Guard.prototype.onSpawned.call(self, params);
    assert.deepEqual(self.guardState, { speed: 120, mode: 0, door: 7 });
  } finally {
    releaseSpawnParams(state);
  }
});

test('the kinds table: one row per kind, and each row’s declaration is that kind', () => {
  const rows = [...guide.matchAll(/^\| (\w+) \| `(\{[^`]*\})` \|/gm)].map(([, kind, literal]) => [kind, literal]);
  assert.deepEqual(
    rows.map(([kind]) => kind),
    [...SPAWN_PARAM_KINDS],
  );
  for (const [kind, literal] of rows) {
    const C = new Function('GameObject', `return class Example extends GameObject { static spawnParams = { key: ${literal} }; };`)(
      GameObject,
    );
    assert.equal(describeSpawnParams(C).kindNames[0], kind, literal);
  }
});

test('a subclass spreads its parent’s params, as the guide writes it', () => {
  const [, literal] = guide.match(/`static spawnParams = (\{ \.\.\.Platform\.spawnParams, [^`]*\});`/);
  const C = new Function('GameObject', 'Platform', `return class Moving extends Platform { static spawnParams = ${literal}; };`)(
    GameObject,
    Platform,
  );
  assert.deepEqual(describeSpawnParams(C).keys, ['width', 'height', 'tint', 'alpha', 'speed']);
});

test('the debug warning the guide quotes is the one a typo prints', () => {
  const [, quoted] = guide.match(/`(WeedJS: Platform\.spawn\(\): "widht"[^`]*)`/);
  const warnings = [];
  const warn = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    checkSpawnConfig(createSpawnParamsState(Platform), { x: 0, y: 0, widht: 400 }, { _hasComponents: { Collider: true } });
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warnings, [quoted]);
});

test('the full-load table quotes what the console says for each reason', () => {
  const quoted = [...guide.matchAll(/^\| [^|]+ \| `([^`]+)` \|$/gm)].map((m) => m[1]);
  const scene = (config) => Object.assign(Object.create(PlatformerGameScene.prototype), { config });
  const reasons = [
    scene({})._fastSwapBlocker(class BossScene {}),
    scene({ manualStep: true })._fastSwapBlocker(PlatformerGameScene),
    scene({ physics: { liquidFun: { enabled: true } } })._fastSwapBlocker(PlatformerGameScene),
  ];
  const slots = Layer._textureSlots;
  Layer._textureSlots = [{ heights: {} }];
  try {
    reasons.push(scene({})._fastSwapBlocker(PlatformerGameScene));
  } finally {
    Layer._textureSlots = slots;
  }
  Layer._sceneryChanged({ name: 'ground' }, 'setTilemap');
  try {
    reasons.push(scene({})._fastSwapBlocker(PlatformerGameScene));
  } finally {
    clearSceneDirty();
  }
  assert.deepEqual(quoted, reasons);
  assert.equal(scene({})._fastSwapBlocker(PlatformerGameScene), null, 'and none of them: a fast swap');
});

// ---- ED-21 and ED-25: joints and decorations ----

test('the joints example: each joint is made between the entities it names, with its anchors and settings', () => {
  const body = sectionBlock('joints');
  const names = [...new Set([...body.matchAll(/"[ab]": "(\w+)"/g)].map((m) => m[1]))];
  // The entities it names, 100 px apart in a row.
  const entities = names.map((name, i) => ({ name, class: 'Block', x: i * 100, y: 0 }));
  const doc = parseSceneFile(`{ "format": 1, "script": "x.js", "entities": ${JSON.stringify(entities)}, ${body} }`, 'SCENE_FILES.md');
  Joint.reset();
  Joint.initializeArrays(new SharedArrayBuffer(Joint.getBufferSize(8, 8)), 8, 8);
  const freeList = new SharedArrayBuffer(16);
  const freeListTop = new SharedArrayBuffer(8);
  resetFreeList(new Int32Array(freeListTop), new Uint16Array(freeList), 8, 1);
  Joint.initialize(8);
  Joint.initializeFreeList(freeList, freeListTop);
  try {
    const at = (name) => names.indexOf(name);
    const made = doc.joints.map((j) => addFileJoint(j, at(j.a), at(j.b), entities[at(j.a)], entities[at(j.b)]));
    const [hinge, rope] = made;
    assert.equal(Joint.type[hinge], Joint.TYPE.REVOLUTE);
    assert.deepEqual([Joint.localAnchorAX[hinge], Joint.localAnchorBX[hinge]], [-40, 20]);
    assert.deepEqual([Joint.enableLimit[hinge], Joint.lowerAngle[hinge], Joint.upperAngle[hinge]], [1, -1.5, 0]);
    assert.equal(Joint.type[rope], Joint.TYPE.DISTANCE);
    assert.deepEqual([Joint.enableSpring[rope], Joint.hertz[rope]], [1, 3]);
    // Without a length, its anchors as far apart as the file places them: (200, -16) to (300, 0).
    assert.ok(Math.abs(Joint.length[rope] - Math.sqrt(100 * 100 + 16 * 16)) < 1e-3);
  } finally {
    Joint.reset();
  }
});

test('the joint table lists each type’s settings as the engine reads them', () => {
  const rows = [...guide.matchAll(/^\| `(\w+)` \| [^|]+ \| ([^|]+) \|$/gm)].map(([, type, settings]) => [
    type,
    [...settings.matchAll(/`(\w+)`/g)].map((m) => m[1]),
  ]);
  assert.deepEqual(Object.fromEntries(rows), Object.fromEntries(JOINT_TYPES.map((t) => [t, [...JOINT_SETTINGS[t]]])));
});

test('the decorations example: a kind the scene declares and the file’s arrays make one spawnMany config', () => {
  const declared = blocks.filter((b) => b.lang === 'js' && b.body.startsWith('static decorations = {'));
  assert.equal(declared.length, 1);
  const Meadow = new Function(`return class Meadow { ${declared[0].body} };`)();
  const doc = parseSceneFile(`{ "format": 1, "script": "x.js", "entities": [], ${sectionBlock('decorations')} }`, 'SCENE_FILES.md');
  const record = doc.decorations[0];
  const kind = decorationClassOf(Meadow, record.class);
  assert.ok(kind, `${record.class} is declared`);
  const config = decorationSpawnConfig(kind, record, null);
  assert.equal(config.count, 3);
  assert.deepEqual(config.x, [120, 136, 152]);
  assert.deepEqual(config.texture, ['grass1', 'grass3', 'grass2'], 'frame picks among the textures');
  assert.deepEqual(config.scaleX, [0.25, 0.3, 0.22]);
  assert.equal(config.scaleY, config.scaleX, 'scale: both axes');
  assert.deepEqual([config.anchorY, config.sway], [1, true], 'the rest is the kind’s');
});
