import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

function readSrc(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
}

function reportBlock(src, marker) {
  const i = src.indexOf(marker);
  assert.ok(i >= 0, `missing ${marker}`);
  return src.slice(i, i + 900);
}

test('lean physics step still calls writePhysicsStats so load counts publish', () => {
  const src = readSrc('src/box2d/weedjsPost.js');
  const needle = 'if (!collectDetailedStats) {\n      syncBodies(entityCount);';
  const lean = src.slice(src.indexOf(needle));
  const write = lean.indexOf('writePhysicsStats(0, 0, 0, 0, 0, 0, 0, 0, 0);');
  const ret = lean.indexOf('return;');
  assert.ok(write >= 0 && ret >= 0 && write < ret);
});

test('physics writes BODY_COUNT / AWAKE / MOVED before the detailed-stats gate', () => {
  const src = readSrc('src/box2d/weedjsPost.js');
  const fn = src.slice(src.indexOf('function writePhysicsStats'));
  const body = fn.indexOf('statsF32[PS.BODY_COUNT]');
  const awake = fn.indexOf('statsF32[PS.AWAKE_COUNT]');
  const moved = fn.indexOf('statsF32[PS.BODY_MOVED_COUNT]');
  const gate = fn.indexOf('if (!collectDetailedStats) return;');
  assert.ok(body >= 0 && awake >= 0 && moved >= 0 && gate >= 0);
  assert.ok(body < gate && awake < gate && moved < gate);
  assert.match(fn.slice(0, gate), /if \(!statsF32\) return;/);
});

test('particle writes ACTIVE_PARTICLES, PARTICLES_STAMPED, ACTIVE_BULLETS, and ACTIVE_DECORATIONS before the detailed-stats gate', () => {
  const block = reportBlock(readSrc('src/workers/particleWorker.js'), 'reportFPS() {');
  const active = block.indexOf('PARTICLE_STATS.ACTIVE_PARTICLES');
  const stamped = block.indexOf('PARTICLE_STATS.PARTICLES_STAMPED');
  const bullets = block.indexOf('PARTICLE_STATS.ACTIVE_BULLETS');
  const decos = block.indexOf('PARTICLE_STATS.ACTIVE_DECORATIONS');
  const gate = block.indexOf('if (!this.collectDetailedStats) return;');
  assert.ok(active >= 0 && stamped >= 0 && bullets >= 0 && decos >= 0 && gate >= 0);
  assert.ok(active < gate && stamped < gate && bullets < gate && decos < gate);
});

test('physics writes HEAP_USED_KB before the detailed-stats gate', () => {
  const src = readSrc('src/box2d/weedjsPost.js');
  const fn = src.slice(src.indexOf('function writePhysicsStats'));
  const heap = fn.indexOf('statsF32[PS.HEAP_USED_KB]');
  const gate = fn.indexOf('if (!collectDetailedStats) return;');
  assert.ok(heap >= 0 && gate >= 0 && heap < gate);
});

test('logic writes ENTITIES_PROCESSED before the detailed-stats gate', () => {
  const block = reportBlock(readSrc('src/workers/logicWorker.js'), 'reportFPS() {');
  const ents = block.indexOf('LOGIC_STATS.ENTITIES_PROCESSED');
  const gate = block.indexOf('if (!this.collectDetailedStats) return;');
  assert.ok(ents >= 0 && gate >= 0 && ents < gate);
});

test('spatial writes NEIGHBORS_REUSED before the detailed-stats gate', () => {
  const block = reportBlock(readSrc('src/workers/spatialWorker.js'), 'reportFPS() {');
  const reused = block.indexOf('SPATIAL_STATS.NEIGHBORS_REUSED');
  const gate = block.indexOf('if (!this.collectDetailedStats) return;');
  assert.ok(reused >= 0 && gate >= 0 && reused < gate);
});

test('scoreboard load gate fails when ACTIVE_DECORATIONS median is 0', async () => {
  const { workloadOk } = await import('../bench/measureLib.mjs');
  const zero = { ACTIVE_DECORATIONS: { median: 0, cv: 0 } };
  const other = { ACTIVE_DECORATIONS: { median: 12000, cv: 0 } };
  const miss = workloadOk(zero, other, ['ACTIVE_DECORATIONS']);
  assert.equal(miss.ok, false);
  assert.ok(miss.drifts.some((d) => d.key === 'ACTIVE_DECORATIONS'));
});

test('scoreboard load gate fails when ACTIVE_BULLETS median is 0', async () => {
  const { workloadOk } = await import('../bench/measureLib.mjs');
  const zero = { ACTIVE_BULLETS: { median: 0, cv: 0 } };
  const other = { ACTIVE_BULLETS: { median: 2048, cv: 0 } };
  const miss = workloadOk(zero, other, ['ACTIVE_BULLETS']);
  assert.equal(miss.ok, false);
  assert.ok(miss.drifts.some((d) => d.key === 'ACTIVE_BULLETS'));
});

test('scoreboard load gate fails when Balls-equivalent BODY_COUNT median is 0', async () => {
  const { workloadOk } = await import('../bench/measureLib.mjs');
  const zero = { BODY_COUNT: { median: 0, cv: 0 } };
  const other = { BODY_COUNT: { median: 9004, cv: 0 } };
  const miss = workloadOk(zero, other, ['BODY_COUNT']);
  assert.equal(miss.ok, false);
  assert.ok(miss.drifts.some((d) => d.key === 'BODY_COUNT'));
});

test('scoreboard load gate fails when a load key cv is 50% or higher', async () => {
  const { workloadOk } = await import('../bench/measureLib.mjs');
  const noisy = {
    ACTIVE_PARTICLES: { median: 80, cv: 0.75 },
    BODY_COUNT: { median: 200, cv: 0.01 },
  };
  const stable = {
    ACTIVE_PARTICLES: { median: 80, cv: 0.02 },
    BODY_COUNT: { median: 200, cv: 0.01 },
  };
  const miss = workloadOk(noisy, stable, ['BODY_COUNT', 'ACTIVE_PARTICLES']);
  assert.equal(miss.ok, false);
  assert.ok(miss.drifts.some((d) => d.key === 'ACTIVE_PARTICLES' && /cv too high/.test(d.reason || '')));
});

test('--headed-only forces headed only for named feature ids', async () => {
  const { parseMeasureArgs, sceneWantsHeaded } = await import('../bench/measureLib.mjs');
  const args = parseMeasureArgs(['--headed-only', 'box2d,steadyCombat']);
  assert.deepEqual(args.headedOnly, ['box2d', 'steadyCombat']);
  const headedScene = { headed: true };
  const stressScene = { headed: false };
  assert.equal(sceneWantsHeaded(headedScene, args, 'box2d'), true);
  assert.equal(sceneWantsHeaded(headedScene, args, 'compute'), false);
  assert.equal(sceneWantsHeaded(headedScene, args, 'decorations'), false);
  assert.equal(sceneWantsHeaded(stressScene, args, 'emit'), false);
  const allHeaded = parseMeasureArgs([]);
  assert.equal(allHeaded.headedOnly, null);
  assert.equal(sceneWantsHeaded(headedScene, allHeaded, 'compute'), true);
  const headless = parseMeasureArgs(['--headless', '--headed-only', 'box2d']);
  assert.equal(sceneWantsHeaded(headedScene, headless, 'box2d'), false);
});

test('explainHit names both sides and the 3% rule for a slower physics step', async () => {
  const { explainHit } = await import('../bench/measureLib.mjs');
  const text = explainHit({
    metric: 'physics_STEP_MS',
    base: 8.168,
    hyp: 8.705,
    deltaPct: 6.58,
    higherBetter: false,
  });
  assert.match(text, /8\.168/);
  assert.match(text, /8\.705/);
  assert.match(text, /\+6\.6%/);
  assert.match(text, /WORSE/);
});
