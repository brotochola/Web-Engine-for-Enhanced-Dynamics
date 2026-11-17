import test from 'node:test';
import assert from 'node:assert/strict';

import { mulberry32 } from '../../tests/bench/benchMath.js';
import {
  CAPACITY_SCENES,
  REFERENCE_SET,
  judgeRun,
  sceneQuery,
  searchCapacity,
  snapLoad,
  summarizeSearch,
} from '../../tests/bench/runCapacity.mjs';

// runCapacity's search finds the largest load a scene holds at 60 fps with every worker's frame tail in budget. The
// oracle is a scene run, and a run is noisy: these tests drive the search with a scripted oracle (a true capacity C,
// optionally a noise band around it) and check where it lands, how many runs it spends, and that the edge's retest
// catches a run that passed by luck.

/** An oracle whose load passes when it is at most C, or within C·(1 ± noise) at random (seeded). */
function noisyOracle(C, noise = 0, seed = 1) {
  const rand = mulberry32(seed);
  const calls = [];
  const oracle = (load) => {
    const edge = C * (1 + noise * (2 * rand() - 1));
    calls.push(load);
    return { pass: load <= edge };
  };
  return { oracle, calls };
}

test('snapLoad rounds to the step and clamps to the range', () => {
  assert.equal(snapLoad(123456, { min: 1000, max: 500000, step: 1000 }), 123000);
  assert.equal(snapLoad(600000, { min: 1000, max: 499999, step: 5000 }), 499999);
  assert.equal(snapLoad(10, { min: 1000, max: 500000, step: 1000 }), 1000);
  assert.equal(snapLoad(1.2345, { min: 0.25, max: 2.5, step: 0.05 }), 1.25);
  assert.equal(snapLoad(1.8371, { min: 0.25, max: 2.5, step: 0.05 }), 1.85);
  assert.equal(snapLoad(7.3, { min: 1, max: 10 }), 7.3);
});

test('a noise-free oracle: the capacity is within the resolution below the true edge, confirmed by a second run', async () => {
  for (const C of [12345, 70000, 233000, 480000]) {
    const { oracle } = noisyOracle(C);
    const r = await searchCapacity({ min: 1000, max: 499999, start: 100000, step: 1000, resolution: 0.05, oracle });
    assert.ok(r.capacity <= C, `C=${C}: capacity ${r.capacity} must not pass the edge`);
    assert.ok(r.failAbove > C, `C=${C}: the load that failed (${r.failAbove}) is above the edge`);
    assert.ok(r.failAbove <= r.capacity * 1.05 + 1000, `C=${C}: bracket ${r.capacity}..${r.failAbove} within 5 %`);
    assert.equal(r.capped, null);
    assert.equal(r.confirmed, true);
    assert.equal(r.trials.filter((t) => t.load === r.capacity).length, 2, 'the edge ran twice');
    assert.equal(r.trials.at(-1).purpose, 'confirm');
    assert.ok(r.trials.length <= 13, `C=${C}: ${r.trials.length} runs`);
    assert.equal(r.capacity % 1000, 0);
  }
});

test('a scene that holds the knob max is capped there, after one confirm', async () => {
  const { oracle, calls } = noisyOracle(1e9);
  const r = await searchCapacity({ min: 1000, max: 400000, start: 150000, step: 5000, oracle });
  assert.equal(r.capacity, 400000);
  assert.equal(r.capped, 'max');
  assert.equal(r.failAbove, null);
  assert.equal(r.confirmed, true);
  assert.deepEqual(calls, [150000, 300000, 400000, 400000]);
});

test('a scene that fails even the knob min has no capacity', async () => {
  const { oracle } = noisyOracle(500);
  const r = await searchCapacity({ min: 1000, max: 400000, start: 150000, step: 1000, oracle });
  assert.equal(r.capacity, null);
  assert.equal(r.capped, 'min');
  assert.equal(r.failAbove, 1000);
});

test('a lucky pass above the edge is caught by the retest, and the search resumes below it', async () => {
  // True edge 100 000; the first run at 180 000 passes by luck, every later run is honest.
  const seen = new Map();
  const oracle = (load) => {
    const n = (seen.get(load) || 0) + 1;
    seen.set(load, n);
    if (load === 180000 && n === 1) return { pass: true };
    return { pass: load <= 100000 };
  };
  const r = await searchCapacity({ min: 1000, max: 499999, start: 90000, step: 1000, growth: 2, oracle });
  assert.ok(r.capacity <= 100000 && r.capacity >= 95000, `capacity ${r.capacity}`);
  assert.equal(r.confirmed, true);
  const at180 = r.trials.filter((t) => t.load === 180000).map((t) => t.pass);
  assert.deepEqual(at180, [true, false], '180 000 passed once, then failed its retest');
});

test('an edge that fails its retest is not the capacity: the largest load that held every run is', async () => {
  // The edge is 100 000, but 97 000 passes only its first run (noise right at the edge).
  const seen = new Map();
  const oracle = (load) => {
    const n = (seen.get(load) || 0) + 1;
    seen.set(load, n);
    if (load > 96000 && load <= 100000) return { pass: n === 1 };
    return { pass: load <= 100000 };
  };
  const r = await searchCapacity({ min: 1000, max: 499999, start: 50000, step: 1000, resolution: 0.05, oracle });
  assert.ok(r.capacity <= 96000, `capacity ${r.capacity} must be a load that held every run`);
  assert.ok(r.capacity >= 90000, `capacity ${r.capacity}`);
  assert.equal(r.confirmed, true);
  for (const t of r.trials.filter((x) => x.load === r.capacity)) assert.equal(t.pass, true);
});

test('with noise of ±5 % at the edge, the capacity stays inside the band over many seeds', async () => {
  const C = 200000;
  const noise = 0.05;
  const caps = [];
  for (let seed = 1; seed <= 200; seed++) {
    const { oracle } = noisyOracle(C, noise, seed);
    const r = await searchCapacity({ min: 1000, max: 499999, start: 150000, step: 1000, resolution: 0.05, oracle, maxTrials: 24 });
    assert.ok(r.capacity !== null && r.confirmed, `seed ${seed}: confirmed capacity`);
    assert.ok(r.capacity <= C * (1 + noise), `seed ${seed}: ${r.capacity} above the band`);
    assert.ok(r.capacity >= (C * (1 - noise)) / 1.05 ** 2, `seed ${seed}: ${r.capacity} far below the band`);
    assert.ok(r.trials.length <= 24);
    caps.push(r.capacity);
  }
  caps.sort((a, b) => a - b);
  const med = caps[caps.length >> 1];
  assert.ok(Math.abs(med - C) / C < 0.08, `median ${med}`);
});

test('a run that errors counts as a fail, and the trial budget ends the search unconfirmed', async () => {
  const r1 = await searchCapacity({
    min: 1000,
    max: 499999,
    start: 100000,
    step: 1000,
    oracle: (load) => (load > 150000 ? { pass: false, error: 'boot timed out' } : { pass: true }),
  });
  assert.ok(r1.capacity <= 150000 && r1.capacity >= 140000, `capacity ${r1.capacity}`);
  assert.ok(r1.trials.some((t) => t.error === 'boot timed out' && !t.pass));

  const r2 = await searchCapacity({
    min: 1000,
    max: 499999,
    start: 100000,
    step: 1000,
    maxTrials: 3,
    oracle: (load) => ({ pass: load <= 123456 }),
  });
  assert.equal(r2.budgetSpent, true);
  assert.equal(r2.trials.length, 3);
  assert.equal(r2.confirmed, false);
});

test('a float knob (Predator crowd) searches on its step', async () => {
  const { oracle } = noisyOracle(1.87);
  const def = CAPACITY_SCENES.predator;
  const r = await searchCapacity({ min: def.min, max: def.max, start: def.start, step: def.step, oracle });
  assert.equal(r.capacity, 1.85);
  assert.equal(r.failAbove, 1.9);
  for (const t of r.trials) assert.equal(Number((t.load / 0.05).toFixed(6)) % 1, 0, `${t.load} on the step`);
});

/** A report as runIntegratedWorkerBenchmark writes it: 10 s window, main at 60 fps, one row a worker. */
function report({ mainFrames = 600, workers = [], fatalError = null } = {}) {
  const ex = (frames, p50, p95, p99, mean = p50) => ({
    frames,
    stepMs: mean,
    waitMs: 0,
    extraMs: 0,
    workMs: mean,
    p50Ms: p50,
    p95Ms: p95,
    p99Ms: p99,
    maxMs: p99 + 1,
    longFrames: p99 >= 16 ? 7 : 0,
  });
  return {
    measurementDurationMs: 10000,
    mainThread: { averageFPS: mainFrames / 10, exactFPS: mainFrames / 10, exact: ex(mainFrames, 0.1, 0.2, 0.3) },
    workers: workers.map(([id, type, frames, p50, p95, p99]) => ({ id, type, exact: ex(frames, p50, p95, p99), statsSamplesAverage: { BODY_COUNT: 1000 } })),
    metadata: { fatalError },
  };
}

const HEALTHY = [
  ['physics', 'physics', 600, 12, 14, 15],
  ['spatial0', 'spatial', 600, 8, 10, 12],
  ['renderer', 'renderer', 600, 4, 6, 7],
];

test('judgeRun: a window inside the budget passes both tails; the critical path is the max over workers', () => {
  const j = judgeRun(report({ workers: HEALTHY }));
  assert.equal(j.pass, true);
  assert.equal(j.passP99, true);
  assert.equal(j.passP95, true);
  assert.equal(j.presentedFps, 60);
  assert.equal(j.drawnFps, 60);
  assert.deepEqual(j.critical.p99Ms, { ms: 15, worker: 'physics' });
  assert.deepEqual(j.critical.p95Ms, { ms: 14, worker: 'physics' });
  assert.equal(j.tightest.worker, 'physics');
  assert.equal(j.limiting, null);
  assert.deepEqual(j.loadKeys.physics, { BODY_COUNT: 1000 });
});

test('judgeRun: a p99 over 16.7 ms fails the p99 rule but not the p95 one, and names the worker', () => {
  const workers = [['physics', 'physics', 590, 13, 16, 21], ...HEALTHY.slice(1)];
  const j = judgeRun(report({ workers }));
  assert.equal(j.pass, false);
  assert.equal(j.passP99, false);
  assert.equal(j.passP95, true);
  assert.equal(j.limiting.what, 'physics');
  assert.equal(j.limiting.metric, 'p99');
  const j95 = judgeRun(report({ workers }), { tail: 'p95' });
  assert.equal(j95.pass, true);
});

test('judgeRun: the worst offender is the limiting one (furthest past its limit)', () => {
  const workers = [['physics', 'physics', 600, 13, 16, 18], ['spatial0', 'spatial', 600, 9, 20, 30], HEALTHY[2]];
  assert.equal(judgeRun(report({ workers })).limiting.what, 'spatial0');
});

test('judgeRun: presented or drawn frames under 59 a second fail, whatever the tails', () => {
  const slowMain = judgeRun(report({ mainFrames: 570, workers: HEALTHY }));
  assert.equal(slowMain.pass, false);
  assert.equal(slowMain.limiting.what, 'presented');
  // A GPU-bound frame: main presents 60, the renderer draws 50 frames a second.
  const workers = [HEALTHY[0], HEALTHY[1], ['renderer', 'renderer', 500, 4, 6, 7]];
  const gpu = judgeRun(report({ workers }));
  assert.equal(gpu.pass, false);
  assert.equal(gpu.drawnFps, 50);
  assert.equal(gpu.limiting.what, 'drawn');
});

test('judgeRun: a worker that died fails the run', () => {
  const j = judgeRun(report({ workers: HEALTHY, fatalError: 'physics worker: RuntimeError' }));
  assert.equal(j.pass, false);
  assert.equal(j.limiting.kind, 'fatal');
});

test('judgeRun: a worker with no frame in the window is stuck (a fail); a second pre-render has no totals slot', () => {
  const r = report({ workers: HEALTHY });
  r.workers.push({ id: 'logic0', type: 'logic', exact: null }, { id: 'preRender1', type: 'preRender', exact: null });
  const j = judgeRun(r);
  assert.equal(j.pass, false);
  assert.deepEqual(j.reasons.map((x) => x.kind), ['noFrames']);
  assert.match(j.reasons[0].what, /^logic0 /);
  const frozen = report({ workers: HEALTHY.slice(0, 2) });
  frozen.workers.push({ id: 'renderer', type: 'renderer', exact: null });
  const jf = judgeRun(frozen);
  assert.equal(jf.drawnFps, 0);
  assert.equal(jf.pass, false);
});

test('summarizeSearch: who breaks first is read at the first failing load above the capacity', async () => {
  const def = { ...CAPACITY_SCENES.boids };
  const j = (pass, p99) => judgeRun(report({ workers: [['spatial0', 'spatial', 600, 8, 12, p99], HEALTHY[2]] }));
  const oracle = (load) => {
    const judgement = load <= 50000 ? j(true, 14) : j(false, 19);
    return { pass: judgement.pass, judgement };
  };
  const s = await searchCapacity({ min: def.min, max: def.max, start: 40000, step: def.step, oracle });
  const sum = summarizeSearch(def, s);
  assert.ok(sum.capacity <= 50000 && sum.capacity >= 50000 / 1.05, `capacity ${sum.capacity}`);
  assert.equal(sum.entities, sum.capacity);
  assert.equal(sum.limiting.what, 'spatial0');
  assert.match(sum.limitingText, /spatial0 p99 19 ms > 16\.7/);
  assert.equal(sum.atCapacity.runs, 2);
  assert.equal(sum.atCapacity.critical.p99Ms.worker, 'spatial0');
  // Every run's p95 (12 ms) is inside the budget: the p95 rule held at every load tried.
  assert.equal(sum.p95HeldUpTo, Math.max(...s.trials.map((t) => t.load)));
});

test('the reference set names catalogued scenes, and a run query carries the fixed part and the knob', () => {
  for (const key of REFERENCE_SET) assert.ok(CAPACITY_SCENES[key], key);
  assert.equal(sceneQuery(CAPACITY_SCENES.predator, 1.85), 'zoom=0.216&crowd=1.85');
  assert.equal(sceneQuery(CAPACITY_SCENES.bunnyMark, 250000), 'bunnies=250000');
  assert.equal(sceneQuery(CAPACITY_SCENES.boids, 80000), 'ids=32&boids=80000');
  for (const def of Object.values(CAPACITY_SCENES)) {
    assert.ok(def.min > 0 && def.max >= def.min && def.start >= def.min && def.start <= def.max, def.key);
    assert.ok(def.entities(def.max) <= 500000, `${def.key}: the engine holds 500 000 entities at most`);
  }
});
