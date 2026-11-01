import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { mergeRegisters } from '../../scripts/mergeRegister.mjs';

// The register's merge driver: two branches that both append to hypotheses.json's arrays merge by key, not as text.

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/mergeRegister.mjs');
const h = (id, extra = {}) => ({ id, title: `title ${id}`, status: 'open', result: '', ...extra });
const r = (id, extra = {}) => ({ id, date: '2026-11-01', title: `record ${id}`, text: '', ...extra });
const reg = (hypotheses, records, extra = {}) => ({ updated: '2026-11-01', about: 'a', hypotheses, records, ...extra });

test('both sides append: ours in its order, then what only theirs added; an entry both added alike once', () => {
  const base = reg([h('E-1')], [r('R-0001')]);
  const ours = reg([h('E-1'), h('ED-82'), h('N-80')], [r('R-0001'), r('R-2001')]);
  const theirs = reg([h('E-1'), h('N-80'), h('N-106'), { title: 'no id yet', status: 'open' }], [r('R-0001'), r('R-0002')]);
  const { merged, clashes } = mergeRegisters(base, ours, theirs);
  assert.deepEqual(clashes, []);
  assert.deepEqual(merged.hypotheses.map((x) => x.id ?? x.title), ['E-1', 'ED-82', 'N-80', 'N-106', 'no id yet']);
  assert.deepEqual(merged.records.map((x) => x.id), ['R-0001', 'R-2001', 'R-0002']);
});

test('an entry both sides added: a field one side left out is the other side’s; lists of ids are united', () => {
  const base = reg([], []);
  const ours = reg([h('N-81', { records: ['R-2010'], aliases: ['hitstop'] })], []);
  const theirs = reg([h('N-81', { aliases: ['dt 0'], next: 'take it up' })], []);
  const { merged, clashes } = mergeRegisters(base, ours, theirs);
  assert.deepEqual(clashes, []);
  assert.deepEqual(merged.hypotheses[0], h('N-81', { records: ['R-2010'], aliases: ['hitstop', 'dt 0'], next: 'take it up' }));
});

test('field by field against the base: each side’s change kept; the same field changed two ways is a clash, ours kept', () => {
  const base = reg([h('E-5', { status: 'open', result: 'not measured', records: ['R-0001'] })], [r('R-0001')]);
  const ours = reg([h('E-5', { status: 'kept', result: 'not measured', records: ['R-0001', 'R-0002'] })], [r('R-0001'), r('R-0002')]);
  const theirs = reg([h('E-5', { status: 'open', result: 'measured: −4 %', records: ['R-0001'] })], [r('R-0001')]);
  let out = mergeRegisters(base, ours, theirs);
  assert.deepEqual(out.clashes, []);
  assert.deepEqual(out.merged.hypotheses[0], h('E-5', { status: 'kept', result: 'measured: −4 %', records: ['R-0001', 'R-0002'] }));

  const theirs2 = reg([h('E-5', { status: 'dropped', result: 'not measured', records: ['R-0001'] })], [r('R-0001')]);
  out = mergeRegisters(base, ours, theirs2);
  assert.deepEqual(out.clashes, ['hypothesis E-5: both sides changed status']);
  assert.equal(out.merged.hypotheses[0].status, 'kept');
});

test('a record id both sides added with different content is a clash; removals', () => {
  const base = reg([h('E-1'), h('E-2'), h('E-3')], [r('R-0001')]);
  const ours = reg([h('E-1'), h('E-2', { status: 'kept' })], [r('R-0001'), r('R-0002', { title: 'ours' })]);
  const theirs = reg([h('E-2'), h('E-3')], [r('R-0001'), r('R-0002', { title: 'theirs' })]);
  const { merged, clashes } = mergeRegisters(base, ours, theirs);
  assert.deepEqual(clashes, [
    "record R-0002: both sides added a record with this id (renumber one side's first)",
  ]);
  // E-1: theirs removed it, ours left it alone: removed. E-3: ours removed it, theirs left it alone: removed.
  assert.deepEqual(merged.hypotheses.map((x) => x.id), ['E-2']);
  assert.equal(merged.hypotheses[0].status, 'kept');

  const changedAndRemoved = mergeRegisters(base, reg([h('E-1', { status: 'kept' }), h('E-2'), h('E-3')], [r('R-0001')]), reg([h('E-2'), h('E-3')], [r('R-0001')]));
  assert.deepEqual(changedAndRemoved.clashes, ['hypothesis E-1: theirs removed it, ours changed it']);
});

test('the other keys: updated is the later one, a key one side changed is that side’s', () => {
  const base = reg([], [], { updated: '2026-10-30', leads: ['a'], statuses: { open: 'o' } });
  const ours = reg([], [], { updated: '2026-11-01', leads: ['a'], statuses: { open: 'o', kept: 'k' } });
  const theirs = reg([], [], { updated: '2026-10-31', leads: ['a', 'b'], statuses: { open: 'o' } });
  const { merged, clashes } = mergeRegisters(base, ours, theirs);
  assert.deepEqual(clashes, []);
  assert.equal(merged.updated, '2026-11-01');
  assert.deepEqual(merged.leads, ['a', 'b']);
  assert.deepEqual(merged.statuses, { open: 'o', kept: 'k' });
});

test('as a git merge driver: writes ours, exit 0; exit 1 on a clash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-register-'));
  try {
    const write = (name, data) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
      return p;
    };
    const base = write('base.json', reg([h('E-1')], []));
    const ours = write('ours.json', reg([h('E-1'), h('ED-82')], []));
    const theirs = write('theirs.json', reg([h('E-1'), h('N-106')], []));
    let run = spawnSync(process.execPath, [SCRIPT, base, ours, theirs], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const text = fs.readFileSync(ours, 'utf8');
    assert.ok(text.endsWith('}\n'), 'written as saveRegistry writes it');
    assert.deepEqual(JSON.parse(text).hypotheses.map((x) => x.id), ['E-1', 'ED-82', 'N-106']);

    const theirs2 = write('theirs2.json', reg([h('E-1', { status: 'kept' })], []));
    const ours2 = write('ours2.json', reg([h('E-1', { status: 'dropped' })], []));
    run = spawnSync(process.execPath, [SCRIPT, base, ours2, theirs2], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /hypothesis E-1: both sides changed status/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
