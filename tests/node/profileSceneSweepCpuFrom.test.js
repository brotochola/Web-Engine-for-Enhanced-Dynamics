import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cpuPassPaths, writeInventory } from '../bench/profileSceneSweep.mjs';

// N-246: profileSceneSweep's code pass and inventory read the cpu pass's files from --out, so a pass run into its own
// folder ranked nothing and wrote an empty inventory unless the cpu files were copied in. They now read them from
// --cpu-from <dir> (by default --out).

const SUMMARY = {
  threads: {
    logic: {
      label: 'logic0', kind: 'worker', busyMsPerS: 400, windowMs: 8000, gcMs: 16,
      self: [{ key: 'LogicWorker.tick /src/workers/logicWorker.js:100', pct: 40 }],
    },
  },
};

test("the inventory of a pass's own folder reads the cpu pass's summaries from --cpu-from", () => {
  const cpuDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-sweep-cpu-'));
  const heapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-sweep-heap-'));
  try {
    const results = [{ name: 'ballsScene', file: 'ballsScene/ballsScene.js', ok: true, seconds: 20 }];
    fs.writeFileSync(cpuPassPaths(cpuDir).index, JSON.stringify(results));
    fs.mkdirSync(path.join(cpuDir, 'ballsScene'));
    fs.writeFileSync(cpuPassPaths(cpuDir, 'ballsScene').summary, JSON.stringify(SUMMARY));

    writeInventory(heapDir, results, cpuDir);
    const inventory = fs.readFileSync(path.join(heapDir, 'inventory.md'), 'utf8');
    assert.match(inventory, /\| logic0 \| 400 \|/, 'the scene has its worker row');
    assert.doesNotMatch(inventory, /Failed: no summary/);

    writeInventory(heapDir, results);
    assert.match(fs.readFileSync(path.join(heapDir, 'inventory.md'), 'utf8'), /Failed: no summary/, 'without it: --out, as before');
  } finally {
    fs.rmSync(cpuDir, { recursive: true, force: true });
    fs.rmSync(heapDir, { recursive: true, force: true });
  }
});

test("the cpu pass's paths: its index and each scene's summary under the folder given", () => {
  const p = cpuPassPaths(path.join('x', 'cpu'), 'predatorScene');
  assert.equal(p.index, path.join('x', 'cpu', 'results.json'));
  assert.equal(p.summary, path.join('x', 'cpu', 'predatorScene', 'cpu-summary.json'));
});
