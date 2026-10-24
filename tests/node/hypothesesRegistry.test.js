import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { renderPage } from '../../scripts/buildHypothesesPage.mjs';
import {
  RECORD_DATE, RECORD_ID, RECORD_TIME, REGISTRY_PATH, docRows, findRows, parseJournal, parseLogRows, resolveRefs, verdictOf,
} from '../../scripts/hypothesesRegister.mjs';

// docs/internal/hypotheses.json is the register: every speed hypothesis, and every record of the work on
// them (a sitting, a kernel run, a gate, a decision) with its date and time. Its doc refs name rows by key
// (`EXECUTION_PLAN.md#E-82b`), never by line, so new rows above them do not move them. The page
// (hypotheses.html) is built from it on demand and is not committed.

const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const PENDING = new Set(['open', 'running', 'blocked']);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/hypotheses.mjs');

test('every hypothesis has a title and a known status, and ids are unique', () => {
  assert.ok(Array.isArray(registry.hypotheses) && registry.hypotheses.length > 0);
  const seen = new Set();
  for (const h of registry.hypotheses) {
    assert.ok(h.title, `an entry without a title: ${JSON.stringify(h).slice(0, 80)}`);
    assert.ok(registry.statuses[h.status], `${h.id || h.title}: unknown status ${h.status}`);
    if (h.id) {
      assert.ok(!seen.has(h.id), `duplicate id ${h.id}`);
      seen.add(h.id);
    }
    if (h.rank != null) {
      assert.ok(Number.isInteger(h.rank) && h.rank > 0, `${h.id}: rank ${h.rank}`);
      assert.ok(PENDING.has(h.status), `${h.id} is ranked but ${h.status}`);
    }
  }
});

test('every record is well formed, and every link from a hypothesis names a record', () => {
  const ids = new Set();
  for (const r of registry.records || []) {
    assert.match(r.id, RECORD_ID);
    assert.ok(!ids.has(r.id), `duplicate record id ${r.id}`);
    ids.add(r.id);
    assert.match(r.date, RECORD_DATE, `${r.id}: date ${r.date}`);
    if (r.time != null) {
      assert.match(r.time, RECORD_TIME, `${r.id}: time ${r.time}`);
      assert.ok(['recorded', 'commit'].includes(r.timeFrom), `${r.id}: timeFrom ${r.timeFrom}`);
    }
    assert.ok(r.title && r.text, `${r.id}: a record needs a title and its text`);
    if (r.verdict != null) assert.ok(registry.statuses[r.verdict], `${r.id}: unknown verdict ${r.verdict}`);
  }
  for (const h of registry.hypotheses) {
    for (const id of h.records || []) assert.ok(ids.has(id), `${h.id || h.title}: no record ${id}`);
  }
});

test('every ref names a file that exists and, after #, exactly one of its rows', () => {
  const { errors } = resolveRefs(registry);
  assert.deepEqual(errors, [], errors.join('\n'));
});

test('a key finds a row by its whole title or by a whole token of it, wherever the row is', () => {
  const doc = [
    '| Hypothesis | Status |',
    '|---|---|',
    '| Compact bullet list | dropped |',
    '| Compact bullet list (new protocol) | dropped |',
    '| **W9** | Pixi |',
    '',
    '**Pixi\'s sprite pack through gpuPack.wasm, W9d (2026-10-23):** **rejected.** Text.',
    '### E-82b The split upload — **open**',
    '### E-82 The upload diet — **KEPT**',
    '- [x] **M13** — found 2026-10-23. **The gate flagged drifts.** Text.',
  ].join('\n');
  const rows = docRows(doc);
  const lineOf = (key) => findRows(rows, key).map((r) => r.line);
  assert.deepEqual(lineOf('Compact bullet list'), [3], 'the exact title wins over a longer one');
  assert.deepEqual(lineOf('W9'), [5], 'W9 is not a token of W9d');
  assert.deepEqual(lineOf('W9d'), [7]);
  assert.deepEqual(lineOf('E-82'), [9], 'E-82 is not a token of E-82b');
  assert.deepEqual(lineOf('E-82b'), [8]);
  assert.deepEqual(lineOf('Hypothesis'), [1]);
  assert.deepEqual(lineOf('M13'), [10], 'a review item is named by its bold id');
  // Rows above a row do not change its key.
  const moved = docRows('**New row, E-123 (2026-10-24):** text.\n' + doc);
  assert.deepEqual(findRows(moved, 'W9d').map((r) => r.line), [8]);
});

test('a line-number ref is refused with the way to fix it', () => {
  const reg = { hypotheses: [{ id: 'X-1', title: 'x', refs: ['HYPOTHESIS_LOG.md#L12'] }] };
  const { errors } = resolveRefs(reg);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /line number/);
});

test('log rows become records: bold leads with what follows them, and table rows by their header', () => {
  const md = [
    '# Hypothesis log',
    '',
    'Preamble text, not a record.',
    '',
    '**The pack in C, W9d (2026-10-23):** **rejected (regression); code kept outside the tree.** Renderer −9.1 %.',
    '1. a list line that belongs to it',
    '',
    'A paragraph that belongs to it too.',
    '',
    '**A gate, E-86 + E-87 (2026-10-23, night):** **passed (NEUTRAL).** Four pairs.',
    '',
    '## Older',
    '',
    '| Name | Claim | Status | When | How | Numbers | Why keep or drop | Link |',
    '|---|---|---|---|---|---|---|---|',
    '| Grid movers only | Rebuild only movers. | dropped | 2026-09-22 | Kernel | −24 % | Floor. | report |',
  ].join('\n');
  const rows = parseLogRows(md);
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].title, rows[0].date, rows[0].verdict], ['The pack in C, W9d', '2026-10-23', 'rejected']);
  assert.match(rows[0].text, /Renderer −9\.1 %\.\n1\. a list line that belongs to it\n\nA paragraph that belongs to it too\./);
  assert.deepEqual([rows[1].title, rows[1].date, rows[1].verdict], ['A gate, E-86 + E-87 (night)', '2026-10-23', 'passed']);
  assert.deepEqual([rows[2].title, rows[2].date, rows[2].verdict], ['Grid movers only', '2026-09-22', 'dropped']);
  assert.match(rows[2].text, /^\*\*Claim:\*\* Rebuild only movers\./);
  assert.equal(verdictOf('kept (`fd15ae95`). The sweep took…'), 'kept');
  assert.equal(verdictOf('**kept (hygiene)** (`8ad26b2a`).'), 'kept-hygiene');
  assert.equal(verdictOf('numbers first, then **Dropped** and reverted.'), 'dropped');
});

test('journal headings give a day, a span of days, a part of the day or a time', () => {
  const md = [
    '# WeedJS Dev Log',
    '## Saturday 24 October 2026 (morning) — Persist Frames',
    'Text one.',
    '### A sub-heading inside it',
    'More text.',
    '## Monday 31 August – Thursday 3 September 2026 — SIMD',
    '## Tuesday 28 July 2026, 2:32 PM — Stop 0',
  ].join('\n');
  const j = parseJournal(md);
  assert.deepEqual(j.map((e) => [e.date, e.until || '', e.part, e.time || '', e.title]), [
    ['2026-10-24', '', 'morning', '', 'Persist Frames'],
    ['2026-08-31', '2026-09-03', '', '', 'SIMD'],
    ['2026-07-28', '', '', '14:32', 'Stop 0'],
  ]);
  assert.match(j[0].text, /Text one\.\n### A sub-heading inside it\nMore text\./);
});

function tempRegister(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-register-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hypotheses.json');
  fs.copyFileSync(REGISTRY_PATH, file);
  return { dir, file };
}
const runCli = (env, ...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('the command line adds a record, links it, and sets the status it is given', (t) => {
  const { file } = tempRegister(t);
  const target = registry.hypotheses.find((h) => h.id && h.status === 'open' && h.rank != null);
  const out = runCli({ HYPOTHESES_REGISTRY: file }, 'record', '--hyp', target.id, '--title', 'A test sitting', '--verdict', 'kept',
    '--date', '2026-10-25', '--time', '09:30', '--commits', 'abc1234', '--status', 'kept', '--text', 'Owner −5 %, 4/4.');
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const r = reg.records[reg.records.length - 1];
  assert.match(out, new RegExp(`^${r.id} added`));
  assert.deepEqual([r.date, r.time, r.timeFrom, r.title, r.verdict, r.text, r.commits], ['2026-10-25', '09:30', 'recorded', 'A test sitting', 'kept', 'Owner −5 %, 4/4.', ['abc1234']]);
  const h = reg.hypotheses.find((x) => x.id === target.id);
  assert.ok(h.records.includes(r.id));
  assert.equal(h.status, 'kept');
  assert.equal(h.rank, undefined, 'a hypothesis that is no longer pending leaves the ranked queue');
  assert.throws(() => runCli({ HYPOTHESES_REGISTRY: file }, 'record', '--hyp', 'NO-SUCH-ID', '--title', 'x', '--text', 'y'), /no hypothesis is NO-SUCH-ID/);
});

test('import-log moves rows written into HYPOTHESIS_LOG.md into the register and keeps the preamble', (t) => {
  const { dir, file } = tempRegister(t);
  const log = path.join(dir, 'HYPOTHESIS_LOG.md');
  const id = registry.hypotheses.find((h) => h.id && h.id.length >= 3).id;
  fs.writeFileSync(log, `# Hypothesis log (moved)\n\nThe records live in the register.\n\n**A late row, ${id} (2026-10-25):** **tie.** Text.\n`);
  runCli({ HYPOTHESES_REGISTRY: file, HYPOTHESES_LOG: log }, 'import-log');
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const r = reg.records[reg.records.length - 1];
  assert.deepEqual([r.title, r.date, r.verdict], [`A late row, ${id}`, '2026-10-25', 'tie']);
  assert.ok(reg.hypotheses.find((h) => h.id === id).records.includes(r.id));
  assert.equal(fs.readFileSync(log, 'utf8'), '# Hypothesis log (moved)\n\nThe records live in the register.\n');
});

test('the page builds from the register, its resolved rows and the journal', () => {
  const { resolved } = resolveRefs(registry);
  const journal = [{ date: '2026-10-24', part: 'morning', title: 'A day', text: 'Text with a </script> inside.' }];
  const page = renderPage(registry, resolved, journal, '2026-10-24 12:00');
  assert.match(page, /<title>WeedJS hypotheses<\/title>/);
  // The embedded data reads back whole (a `<` inside it cannot end its script tag).
  const open = '<script id="data" type="application/json">';
  const start = page.indexOf(open) + open.length;
  const data = JSON.parse(page.slice(start, page.indexOf('</script>', start)));
  assert.equal(data.registry.hypotheses.length, registry.hypotheses.length);
  assert.equal((data.registry.records || []).length, (registry.records || []).length);
  assert.equal(Object.keys(data.resolved).length, Object.keys(resolved).length);
  assert.equal(data.journal[0].text, journal[0].text);
});
