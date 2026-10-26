// VISUAL_EDITOR_PLAN.md ED-3: the platformer's platforms moved from a coordinate array in
// PlatformerGameScene.create() to levels/1-1.scene.json, and Platform's `??` defaults to its
// static spawnParams. Parity with the old array, read the way the engine reads the file: the
// declared defaults fill what the file leaves out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import '../../tests/helpers/registerWebRoot.mjs';

import { parseSceneFile, sceneFileScriptUrl } from '../../src/core/sceneFile.js';
import { describeSpawnParams } from '../../src/core/spawnParams.js';

const { Platform } = await import('../platformerGameScene/gameObjects/platform.js');
const { PlatformerGameScene } = await import('../platformerGameScene/platformerGameScene.js');

const fileUrl = new URL('../platformerGameScene/levels/1-1.scene.json', import.meta.url);
const doc = parseSceneFile(readFileSync(fileURLToPath(fileUrl), 'utf8'), '1-1.scene.json');

// spawnLevelPlatforms() before the move.
const OLD_DEFS = [
  { x: 600, y: 2050, width: 1200, height: 60, tint: 0x5a708f },
  { x: 1820, y: 1760, width: 420, height: 50, tint: 0x4f6983 },
  { x: 2300, y: 1630, width: 280, height: 44, tint: 0x4f6983 },
  { x: 2670, y: 1700, width: 260, height: 44, tint: 0x4f6983 },
  { x: 3070, y: 1560, width: 300, height: 44, tint: 0x4f6983 },
  { x: 3520, y: 1720, width: 420, height: 44, tint: 0x4f6983 },
  { x: 4020, y: 1880, width: 500, height: 54, tint: 0x5a708f },
  { x: 4680, y: 2040, width: 920, height: 60, tint: 0x5a708f },
  { x: 1260, y: 1740, width: 220, height: 36, tint: 0x7289a5 },
  { x: 1500, y: 1620, width: 180, height: 32, tint: 0x7289a5 },
  { x: 3320, y: 1400, width: 170, height: 32, tint: 0x7289a5 },
  { x: 4560, y: 1650, width: 180, height: 32, tint: 0x7289a5 },
];

test('Platform declares the defaults its onSpawned used to write with ??', () => {
  const d = describeSpawnParams(Platform);
  const defaults = Object.fromEntries(d.keys.map((key, i) => [key, d.defaults[i]]));
  assert.deepEqual(defaults, { width: 220, height: 36, tint: 0x495870, alpha: 1 });
});

test('levels/1-1.scene.json places the platforms the old array did', () => {
  const d = describeSpawnParams(Platform);
  // The old array's platforms are Platform1 to Platform12; the level has grown since (ED-37: a goal, a step).
  const platforms = doc.entities.filter((e) => e.class === 'Platform');
  const old = OLD_DEFS.map((_, i) => platforms.find((e) => e.name === `Platform${i + 1}`));
  const placed = old.map((e) => {
    const filled = { x: e.x, y: e.y };
    for (let i = 0; i < d.keys.length; i++) filled[d.keys[i]] = e.config?.[d.keys[i]] ?? d.defaults[i];
    return { x: filled.x, y: filled.y, width: filled.width, height: filled.height, tint: filled.tint };
  });
  assert.deepEqual(placed, OLD_DEFS);
  const pool = PlatformerGameScene.entities.find(([C]) => C === Platform)[1];
  assert.ok(platforms.length <= pool, 'the pool holds what the file places');
});

test('the file names the scene module and class, and the scene names the file', () => {
  assert.equal(sceneFileScriptUrl(doc, fileUrl.href), new URL('../platformerGameScene/platformerGameScene.js', import.meta.url).href);
  assert.equal(doc.export, PlatformerGameScene.name);
  const moduleUrl = new URL('../platformerGameScene/platformerGameScene.js', import.meta.url);
  assert.equal(new URL(PlatformerGameScene.defaultSceneFile, moduleUrl).href, fileUrl.href);
});
