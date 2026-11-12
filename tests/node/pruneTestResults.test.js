import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pruneTestResults } from '../bench/pruneTestResults.mjs';

// Raw results are not kept, but nothing removed them. pruneTestResults removes what was not touched for a week, two
// levels down: a folder of folders (predator-abab) child by child, anything else whole; a link is never followed.

const DAY = 86400000;

function tree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-results-'));
  const put = (rel, ageDays) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!rel.endsWith('/')) fs.writeFileSync(p, 'x');
    const t = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(p, t, t);
    return p;
  };
  return { dir, put, age: (rel, ageDays) => {
    const t = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(path.join(dir, rel), t, t);
  } };
}

test('old entries go, recent ones stay, a folder of folders child by child', () => {
  const { dir, put, age } = tree();
  put('predator-abab/old-sitting/summary.json', 30);
  put('predator-abab/new-sitting/summary.json', 1);
  age('predator-abab/old-sitting', 30);
  age('predator-abab/new-sitting', 1);
  put('old-trace.json', 20);
  put('fresh.json', 0);
  put('galaxy-prof/a.json', 15);
  put('galaxy-prof/b.json', 15);
  age('galaxy-prof', 15);
  const removed = pruneTestResults({ dir, days: 7 }).map((p) => path.relative(dir, p).replace(/\\/g, '/')).sort();
  assert.deepEqual(removed, ['galaxy-prof', 'old-trace.json', 'predator-abab/old-sitting']);
  assert.ok(fs.existsSync(path.join(dir, 'predator-abab/new-sitting/summary.json')));
  assert.ok(fs.existsSync(path.join(dir, 'fresh.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a dry run removes nothing', () => {
  const { dir, put } = tree();
  put('old.json', 30);
  assert.equal(pruneTestResults({ dir, days: 7, dryRun: true }).length, 1);
  assert.ok(fs.existsSync(path.join(dir, 'old.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a link to a folder outside is unlinked, its target kept', () => {
  const { dir } = tree();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-outside-'));
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
  const link = path.join(dir, 'linked');
  fs.symlinkSync(outside, link, 'junction');
  const t = new Date(Date.now() - 30 * DAY);
  fs.lutimesSync(link, t, t);
  pruneTestResults({ dir, days: 7 });
  assert.ok(!fs.existsSync(link), 'the link went');
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')), 'what it pointed at did not');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
