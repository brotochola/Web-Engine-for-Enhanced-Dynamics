import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { REGISTRY_PATH, docRows, findRows, renderPage, resolveRefs } from '../../scripts/buildHypothesesPage.mjs';

// docs/internal/hypotheses.json is the index of every speed hypothesis. Its refs name rows of the docs
// by key (`HYPOTHESIS_LOG.md#W9d`), never by line, so new rows above them do not move them; each key must
// find exactly one row. The page (hypotheses.html) is built from it on demand and is not committed.

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
  ].join('\n');
  const rows = docRows(doc);
  const lineOf = (key) => findRows(rows, key).map((r) => r.line);
  assert.deepEqual(lineOf('Compact bullet list'), [3], 'the exact title wins over a longer one');
  assert.deepEqual(lineOf('W9'), [5], 'W9 is not a token of W9d');
  assert.deepEqual(lineOf('W9d'), [7]);
  assert.deepEqual(lineOf('E-82'), [9], 'E-82 is not a token of E-82b');
  assert.deepEqual(lineOf('E-82b'), [8]);
  assert.deepEqual(lineOf('Hypothesis'), [1]);
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

test('the page builds from the registry and its resolved rows', () => {
  const { resolved } = resolveRefs(registry);
  const page = renderPage(registry, resolved);
  assert.match(page, /<title>WeedJS hypotheses<\/title>/);
  // The embedded data reads back whole (a `<` inside it cannot end its script tag).
  const open = '<script id="data" type="application/json">';
  const start = page.indexOf(open) + open.length;
  const data = JSON.parse(page.slice(start, page.indexOf('</script>', start)));
  assert.equal(data.registry.hypotheses.length, registry.hypotheses.length);
  assert.equal(Object.keys(data.resolved).length, Object.keys(resolved).length);
});
