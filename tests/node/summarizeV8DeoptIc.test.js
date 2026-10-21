import test from 'node:test';
import assert from 'node:assert/strict';

import { codeAt, parseCodeCreation, parseIcLine } from '../bench/summarizeV8Deopt.mjs';

// N-33. Chrome logs IC states as one letter. The summarizer matched the words
// ("megamorphic") and so reported no megamorphic IC in any run. Lines below
// have the shape of the 2026-10-21 Predator logs.

test('IC lines: one-letter states are read from the new-state column', () => {
  const mega = parseIcLine('LoadIC,0x5fdd010bc630,143490,71,37,1,N,0x024c0108cfd9,_schemaEntry,,');
  assert.equal(mega.kind, 'LoadIC');
  assert.equal(mega.state, 'megamorphic');
  assert.equal(mega.key, '_schemaEntry');
  assert.equal(mega.tsUs, 143490);
  assert.equal(mega.pc, 0x5fdd010bc630);
  const states = { X: 'no-feedback', 0: 'uninitialized', 1: 'monomorphic', '^': 'recompute', P: 'polymorphic', D: 'megadom', G: 'generic' };
  for (const [code, name] of Object.entries(states)) {
    assert.equal(parseIcLine(`KeyedStoreIC,0x10,5,1,2,0,${code},0x20,3,,`).state, name, code);
  }
  assert.equal(parseIcLine('code-deopt,1,2,0x3,-1,4,deopt-eager,<x.js:1:1>,wrong map'), null);
});

test('IC lines: older word states still parse, new state first', () => {
  assert.equal(parseIcLine('LoadIC,0x10,5,1,2,monomorphic,megamorphic,0x20,foo').state, 'megamorphic');
});

test('an IC pc resolves to the function whose code holds it', () => {
  const lines = [
    'code-creation,JS,13,920956,0x7ffa99dd36c0,3044,_rememberType0Set http://127.0.0.1:62846/src/workers/preRenderWorker.js?v=1:1597:22,0x1e601aca4f0,o*',
    'code-creation,JS,10,875192,0x6b0a014c47d0,235,tick http://127.0.0.1:62846/src/core/tween.js:412:14,0x1e601aca4f1,~',
  ];
  const ranges = lines.map(parseCodeCreation).sort((a, b) => a.start - b.start);
  assert.match(codeAt(ranges, 0x7ffa99dd36c0 + 100).name, /_rememberType0Set .*\/src\/workers\/preRenderWorker\.js:1597:22$/);
  assert.match(codeAt(ranges, 0x6b0a014c47d0).name, /^tick \/src\/core\/tween\.js:412:14$/);
  assert.equal(codeAt(ranges, 0x6b0a014c47d0 + 235), null, 'one past the end is outside');
  assert.equal(codeAt(ranges, 0x10), null);
});
