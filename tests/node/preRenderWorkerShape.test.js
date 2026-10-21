import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { loadWorker } from '../bench/workerHarness.mjs';

// N-32. A field the worker first writes after its frame loop starts changes
// the worker's hidden class, and V8 throws away every optimized method that
// checked the old one. The first "render queue full" warning did that in the
// particle-emit stress scene: one method then deoptimized every frame for
// ~8 s until V8 re-optimized it. The constructor now declares every field;
// only initialize(), which runs before the loop, may add one.

const SRC = new URL('../../src/workers/preRenderWorker.js', import.meta.url);

/** Fields `this.X =` writes in PreRenderWorker methods other than the constructor and initialize. */
function fieldsWrittenAfterBoot() {
  const lines = fs.readFileSync(SRC, 'utf8').split('\n');
  const start = lines.findIndex((l) => /^class PreRenderWorker\b/.test(l));
  const header = /^ {4}(?:static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/;
  const write = /this\.([A-Za-z_$][\w$]*)\s*(?:=(?!=)|\|\|=|\?\?=)/g;
  const out = new Map();
  let method = null;
  for (let i = start + 1; i < lines.length && !/^}/.test(lines[i]); i++) {
    const m = lines[i].match(header);
    if (m && !/^(if|for|while|switch|catch)$/.test(m[1])) method = m[1];
    if (method === 'constructor' || method === 'initialize') continue;
    for (const w of lines[i].matchAll(write)) {
      if (!out.has(w[1])) out.set(w[1], `${method}, line ${i + 1}`);
    }
  }
  return out;
}

function quietly(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    fn();
  } finally {
    console.warn = warn;
  }
}

test('pre-render: every field a frame path writes exists from the constructor', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const written = fieldsWrittenAfterBoot();
  assert.ok(written.size > 40, `the scan found the frame paths (${written.size} fields)`);
  const missing = [...written].filter(([name]) => !Object.hasOwn(pre, name));
  assert.deepEqual(
    missing.map(([name, at]) => `${name} (${at})`),
    [],
    'declare these in the constructor',
  );
});

test('pre-render: the first full-queue and missing-texture warnings keep the worker\'s shape', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const keys = Object.keys(pre);
  quietly(() => {
    // A fresh worker has renderQueueMaxItems 0, so the first row is an overflow.
    pre._writeRenderable(0, 1, 0, 0);
    pre._warnMissingTexture('n32', 'missing');
  });
  assert.equal(pre._renderQueueOverflowWarned, true, 'the overflow path ran');
  assert.ok(pre._missingTextureWarns.has('n32'), 'the missing-texture path ran');
  assert.deepEqual(Object.keys(pre), keys);
});
