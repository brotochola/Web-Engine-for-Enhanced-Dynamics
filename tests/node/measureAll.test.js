// measure:all's page: what it calls faster or slower, and what it leaves out.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { moved, page, readKernels } from '../../scripts/measureAll.mjs';
import { readJobs, sceneTable } from '../bench/ci/collect.mjs';

function results(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-measure-'));
  for (const [id, machineKey, list] of rows) {
    fs.mkdirSync(path.join(dir, id));
    fs.writeFileSync(path.join(dir, id, 'job.json'), JSON.stringify({ id, machineKey, machine: { cpu: `cpu of ${machineKey}` } }));
    fs.writeFileSync(path.join(dir, id, 'result.json'), JSON.stringify({ kind: 'sweep', rows: list }));
  }
  return dir;
}
const row = (label, b, extra = {}) => ({
  type: 'revs', label, kernel: `${label}Microbench`, checksumsAgree: true, testsAt: 'b',
  metrics: { 'cases.x.opsPerSec': { higher: true, a: [100, 100, 100], b: [b, b, b] }, 'cases.y.nsPerOp': { higher: false, a: [50, 50, 50], b: [5000 / b, 5000 / b, 5000 / b] } },
  ...extra,
});

test('a kernel is faster or slower by 3 % past its machine\'s limit, and its cases count alike', () => {
  const dir = results([
    ['k-linux-1', 'linux', [row('ray', 120), row('still', 100.4), row('noisy', 130)]],
    ['k-linux-2', 'linux', [row('ray', 121), row('still', 99.8), row('noisy', 85)]],
    ['k-linuxArm-1', 'linuxArm', [row('ray', 90)]],
    ['k-linuxArm-2', 'linuxArm', [row('ray', 90), { type: 'revs', label: 'gone', kernel: 'goneMicrobench', metrics: {}, error: 'a: exit 1: no such export' }]],
  ]);
  try {
    const { rows, failed } = readKernels(dir);
    const of = (label) => rows.find((r) => r.label === label);
    assert.ok(Math.abs(100 * Math.expm1(of('ray').machines.linux.log) - 20.5) < 0.2);
    assert.equal(moved(of('ray').machines.linux), 1);
    assert.equal(moved(of('ray').machines.linuxArm), -1);
    assert.equal(moved(of('still').machines.linux), 0, 'under the bar');
    assert.equal(moved(of('noisy').machines.linux), 0, 'the VMs disagree: under the limit');
    assert.deepEqual([...failed.keys()], ['gone']);
    const facts = { version: '1', bytes: {}, lines: { code: 10, comment: 5 }, tests: { engine: 1, demos: 1 } };
    const text = page({ a: 'v1', b: 'v2', shaA: 'aaaaaaaaaa', shaB: 'bbbbbbbbbb', factsA: facts, factsB: facts, kernels: { rows, failed }, machines: ['linux', 'linuxArm'], health: '' });
    // Faster on one machine and slower on the other: neither list, and no line of its own.
    assert.ok(text.includes('### Faster on two machines or more (0)') && text.includes('### Slower on two machines or more (0)'));
    assert.ok(text.includes('| Linux x64 | 2 | cpu of linux | 3 | 1 | 0 |'), text);
    assert.ok(text.includes('| Linux ARM | 2 | cpu of linuxArm | 1 | 0 | 1 |'), text);
    assert.ok(text.includes('- gone: a: exit 1: no such export'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a kernel that ran on one VM only has no limit and is not called moved; one that failed elsewhere is not listed as failed', () => {
  const dir = results([
    ['k-linux-1', 'linux', [row('ray', 150)]],
    ['k-win-1', 'win', [{ type: 'revs', label: 'ray', kernel: 'rayMicrobench', metrics: {}, error: 'b: exit 1' }]],
  ]);
  try {
    const { rows, failed } = readKernels(dir);
    assert.equal(moved(rows[0].machines.linux), 0);
    assert.equal(failed.size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a scene\'s workers: the median of a VM\'s pairs, the VMs\' mean and limit; idle workers and failed scenes apart', () => {
  const runs = (logic, pixi) => logic.map((v, i) => ({ ms: { logic: v, renderer: pixi[i], particle: 0.02 } }));
  const scene = (b) => ({ scene: 'boids', query: '', a: runs([2, 2, 2], [1, 1, 1]), b: runs([b, b, 9], [1, 1.01, 0.99]) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-measure-'));
  try {
    for (const [id, rows] of [['s-linux-1', [scene(1.6), { scene: 'gone', a: [], b: [], error: 'a: exit 1' }]], ['s-linux-2', [scene(1.62)]]]) {
      fs.mkdirSync(path.join(dir, id));
      fs.writeFileSync(path.join(dir, id, 'job.json'), JSON.stringify({ id, machineKey: 'linux' }));
      fs.writeFileSync(path.join(dir, id, 'result.json'), JSON.stringify({ kind: 'sceneAb', rows }));
    }
    const { rows, failed } = sceneTable(readJobs(dir));
    const logic = rows.find((r) => r.worker === 'logic');
    assert.ok(Math.abs(logic.meanPct - -19.5) < 0.3, `${logic.meanPct}`);
    assert.equal(logic.n, 2);
    assert.ok(Math.abs(logic.log) > logic.limit);
    assert.ok(Math.abs(rows.find((r) => r.worker === 'renderer').meanPct) < 0.01);
    assert.equal(rows.some((r) => r.worker === 'particle'), false, 'idle on both sides');
    assert.deepEqual(failed, { 'linux|gone': 'a: exit 1' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
