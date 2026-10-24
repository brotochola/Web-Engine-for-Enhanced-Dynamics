import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { PAGE_PATH, REGISTRY_PATH, renderPage } from '../../scripts/buildHypothesesPage.mjs';

// docs/internal/hypotheses.json is the index of every speed hypothesis; hypotheses.html is built
// from it. The index must stay well formed, its evidence links must point at real lines, and the
// page must be the one the builder makes from it (edit the JSON, then run the builder).

const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const PENDING = new Set(['open', 'running', 'blocked']);

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

test('every evidence link points at a line that exists', () => {
  const docs = path.dirname(REGISTRY_PATH);
  const lineCount = new Map();
  for (const h of registry.hypotheses) {
    for (const ref of h.refs || []) {
      const [file, line] = ref.split('#L');
      const full = path.join(docs, file);
      assert.ok(fs.existsSync(full), `${h.id || h.title}: ${file} does not exist`);
      if (!lineCount.has(full)) lineCount.set(full, fs.readFileSync(full, 'utf8').split('\n').length);
      if (line) assert.ok(Number(line) <= lineCount.get(full), `${h.id || h.title}: ${ref} is past the end of ${file}`);
    }
  }
});

test('hypotheses.html is the page the builder makes from the registry', () => {
  const page = fs.readFileSync(PAGE_PATH, 'utf8');
  assert.equal(page, renderPage(registry), 'the page is out of date: run node scripts/buildHypothesesPage.mjs');
});
