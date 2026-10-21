import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { loadWorker } from '../bench/workerHarness.mjs';

// N-32. A field a worker first writes after its frame loop starts changes the
// worker's hidden class, and V8 throws away every optimized method that
// checked the old one. The first "render queue full" warning did that in the
// particle-emit stress scene: one pre-render method then deoptimized every
// frame for ~8 s until V8 re-optimized it. The constructors now declare every
// field; only initialize(), which runs before the loop, may add one.

/**
 * Fields `this.X =` writes in a class's methods other than the constructor and
 * initialize, from the source.
 */
function fieldsWrittenAfterBoot(file, className) {
  const lines = fs.readFileSync(new URL(`../../src/workers/${file}`, import.meta.url), 'utf8').split('\n');
  const start = lines.findIndex((l) => new RegExp(`^class ${className}\\b`).test(l));
  assert.ok(start >= 0, `class ${className} in ${file}`);
  const indent = lines.slice(start + 1).find((l) => l.trim()).match(/^ */)[0].length;
  const header = new RegExp(`^ {${indent}}(?:static\\s+|async\\s+)*([A-Za-z_$][\\w$]*)\\s*\\([^)]*\\)\\s*\\{\\s*$`);
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

for (const [file, selfKey, className] of [
  ['preRenderWorker.js', 'preRenderWorker', 'PreRenderWorker'],
  ['pixiWorker.js', 'pixiRenderer', 'PixiRenderer'],
]) {
  test(`${className}: every field a later path writes exists from the constructor`, async () => {
    const worker = await loadWorker(file, selfKey);
    const written = fieldsWrittenAfterBoot(file, className);
    assert.ok(written.size > 40, `the scan found the frame paths (${written.size} fields)`);
    const missing = [...written].filter(([name]) => !Object.hasOwn(worker, name));
    assert.deepEqual(
      missing.map(([name, at]) => `${name} (${at})`),
      [],
      'declare these in the constructor',
    );
  });
}

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

test('pre-render: the emit ref declares every column emitSpriteQueue puts on it', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const src = fs.readFileSync(new URL('../../src/workers/preRenderWorker.js', import.meta.url), 'utf8');
  const written = new Set([...src.matchAll(/\bref\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)].map((m) => m[1]));
  const missing = [...written].filter((name) => !Object.hasOwn(pre._emitRef, name));
  assert.deepEqual(missing, [], 'add these to the _emitRef literal');
});
