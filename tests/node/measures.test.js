// The measures kept (scripts/measures.mjs, DX-MEASURES): what a fetched measure:all leaves, and two sides compared.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MEASURES_DIR, compareKernels, compareScenes, listMeasures, measureOf } from '../../scripts/measures.mjs';
import { runRuler } from '../bench/ci/ruler.mjs';

function ciOut(jobs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-measures-'));
  for (const [id, machineKey, cpu, ruler, result] of jobs) {
    fs.mkdirSync(path.join(dir, id));
    fs.writeFileSync(path.join(dir, id, 'job.json'), JSON.stringify({ id, machineKey, machine: { cpu, threads: 4 }, ruler, started: '2026-11-25T01:00:00Z' }));
    fs.writeFileSync(path.join(dir, id, 'result.json'), JSON.stringify(result));
  }
  return dir;
}
const ruler = (x) => ({ start: { float: 10 * x, memory: 20 * x, branch: 30 * x }, end: { float: 10 * x, memory: 20 * x, branch: 30 * x } });
const sweep = (a, b) => ({
  kind: 'sweep',
  rows: [{
    type: 'revs', label: 'ray', kernel: 'rayMicrobench',
    metrics: { 'cases.x.opsPerSec': { higher: true, a: [a, a, a], b: [b, b, b] }, 'cases.y.nsPerOp': { higher: false, a: [100, 100, 100], b: [50, 50, 50] } },
  }, { type: 'revs', label: 'dead', error: 'exit 1' }],
});

test('a measure keeps every round and pair of both sides, by VM, and nothing of the jobs that timed nothing', () => {
  const scene = { scene: 'boids', query: '', changed: [], a: [{ ms: { logic: 1.23456 }, frames: { logic: 480 } }], b: [{ ms: { logic: 1.1 }, frames: { logic: 479 } }] };
  const dir = ciOut([
    ['k-linux-1-s1', 'linux', 'Xeon', ruler(1), sweep(100.12345, 120)],
    ['s-linux-1', 'linux', 'Xeon', ruler(1), { kind: 'sceneAb', mode: 'window', rows: [scene, { scene: 'gone', error: 'x' }] }],
    ['t-linux-1', 'linux', 'Xeon', ruler(1), { kind: 'tests', suites: {} }],
  ]);
  try {
    const m = measureOf('x', '2026-11-25', dir, { a: 'aaaa', b: 'bbbb', factsA: { bytes: 1 }, factsB: { bytes: 2 } });
    assert.deepEqual(Object.keys(m.vms), ['k-linux-1-s1', 's-linux-1']);
    assert.deepEqual(Object.keys(m.kernels), ['ray']);
    assert.deepEqual(m.kernels.ray.cases['cases.x.opsPerSec'], { higher: true, vms: { 'k-linux-1-s1': { a: [100.1, 100.1, 100.1], b: [120, 120, 120] } } });
    assert.deepEqual(m.scenes, { boids: { query: '', changed: [], workers: { logic: { 's-linux-1': { a: [1.235], b: [1.1], framesA: [480], framesB: [479] } } } } });
    assert.equal(m.mode, 'window');
    assert.deepEqual(m.exact, { a: { bytes: 1 }, b: { bytes: 2 } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two measures are compared on the CPU models both saw, each rate over the ruler\'s there', () => {
  // The second day's Xeon is the same model at twice the pace: the ruler says so, and the kernel is level.
  const one = ciOut([['k-linux-1-s1', 'linux', 'Xeon', ruler(1), sweep(100, 100)]]);
  const two = ciOut([['k-linux-1-s1', 'linux', 'Xeon', ruler(2), sweep(1, 200)], ['k-linux-2-s1', 'linux', 'EPYC', ruler(1), sweep(1, 999)]]);
  try {
    const a = { file: 'a', ...measureOf('a', 'd', one, null) };
    const b = { file: 'b', ...measureOf('b', 'd', two, null) };
    const rows = compareKernels(a, 'b', b, 'b');
    const x = rows.find((r) => r.case === 'cases.x.opsPerSec');
    assert.deepEqual([x.cpu, x.ruled, x.vms], ['Xeon', true, [1, 1]]);
    assert.ok(Math.abs(x.log) < 1e-6, `${x.log}`);
    // The same measure's two sides: in the same VM, with no ruler, and a lower time is a higher rate.
    const own = compareKernels(a, 'a', a, 'b').find((r) => r.case === 'cases.y.nsPerOp');
    assert.ok(Math.abs(own.log - Math.log(2)) < 1e-6 && own.ruled === false);
  } finally {
    fs.rmSync(one, { recursive: true, force: true });
    fs.rmSync(two, { recursive: true, force: true });
  }
});

test('the kept measures read, each with both sides\' revisions and its VMs\' CPUs', () => {
  for (const m of listMeasures()) {
    assert.match(m.file, /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.json$/);
    assert.match(`${m.a} ${m.b}`, /^[0-9a-f]{40} [0-9a-f]{40}$/, m.file);
    assert.ok(Object.values(m.vms).every((v) => v.cpu), m.file);
  }
  assert.ok(fs.existsSync(MEASURES_DIR));
});

test('the ruler gives three rates', () => {
  const r = runRuler();
  assert.deepEqual(Object.keys(r), ['float', 'memory', 'branch']);
  for (const v of Object.values(r)) assert.ok(v > 0);
});

test('a scene worker of a measure: its VMs\' own differences, whether they agree, and why it is not to be read', () => {
  const run = (ms, frames) => ({ ms: { logic: ms }, frames: { logic: frames } });
  const scene = (a, b, frames) => ({ kind: 'sceneAb', mode: 'shell', rows: [{ scene: 'boids', query: '', changed: ['demos/x.js'], a: [run(a, 480)], b: [run(b, frames)] }] });
  const one = ciOut([['s-linux-1', 'linux', 'Xeon', null, scene(1, 2, 470)], ['s-linux-2', 'linux', 'EPYC', null, scene(2, 3.8, 470)]]);
  const two = ciOut([['s-linux-1', 'linux', 'Xeon', null, scene(1, 2, 12)], ['s-linux-2', 'linux', 'EPYC', null, scene(2, 1.5, 12)]]);
  try {
    const a = { file: 'a', ...measureOf('a', 'd', one, null) };
    const [row] = compareScenes(a, 'a', a, 'b');
    assert.deepEqual([row.x, row.y, row.agree, row.doubt, row.changed, row.vms], [1.5, 2.9, true, null, ['demos/x.js'], [2, 2]]);
    assert.ok(Math.abs(row.log - (Math.log(2) + Math.log(1.9)) / 2) < 1e-6);
    const b = { file: 'b', ...measureOf('b', 'd', two, null) };
    const [cold] = compareScenes(b, 'a', b, 'b');
    assert.deepEqual([cold.agree, cold.doubt], [false, 'few frames']);
  } finally {
    fs.rmSync(one, { recursive: true, force: true });
    fs.rmSync(two, { recursive: true, force: true });
  }
});
