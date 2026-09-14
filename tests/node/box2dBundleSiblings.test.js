import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractImportScriptNames,
  extractAllImportScriptNames,
  listBox2dSiblingNames,
} from '../../scripts/buildBundle.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const box2dDir = join(root, 'src', 'box2d');
const weedPost = readFileSync(join(box2dDir, 'weedjsPost.js'), 'utf8');
const buildBundleSrc = readFileSync(join(root, 'scripts', 'buildBundle.js'), 'utf8');

function assertExactCaseFiles(dir, names, label) {
  const listed = new Set(readdirSync(dir));
  for (const name of names) {
    const similar = [...listed].filter((n) => n.toLowerCase() === name.toLowerCase());
    assert.ok(
      listed.has(name),
      `${label} importScripts("${name}") — no exact-case file in src/box2d (similar: ${similar.join(', ') || 'none'})`,
    );
  }
}

test('weedjsPost importScripts siblings exist with exact case and are auto-embedded', () => {
  const imported = extractImportScriptNames(weedPost);
  assert.ok(imported.length > 0, 'weedjsPost.js has no importScripts filenames');
  assert.ok(imported.includes('box2dRayCastImpl.js'), 'missing box2dRayCastImpl.js');
  assert.ok(imported.includes('liquidFunQueryImpl.js'), 'missing liquidFunQueryImpl.js');
  assertExactCaseFiles(box2dDir, imported, 'weedjsPost.js');

  const siblings = listBox2dSiblingNames(weedPost);
  assert.ok(siblings.includes('weedjsPost.js'));
  assert.ok(siblings.includes('physicsHostImpl.js'));
  for (const name of imported) {
    assert.ok(siblings.includes(name), `listBox2dSiblingNames omitted ${name}`);
  }

  assert.match(
    buildBundleSrc,
    /listBox2dSiblingNames\(weedPostSource\)/,
    'buildBundle.js must derive siblings from weedjsPost importScripts',
  );
  assert.doesNotMatch(
    buildBundleSrc,
    /const BOX2D_SIBLING_NAMES = \[/,
    'hand-maintained BOX2D_SIBLING_NAMES list must not return — drift is the blob importScripts bug',
  );
});

test('WEEDJS_READY liquidFunHeap includes userDataByteOffset', () => {
  const ready = weedPost.slice(weedPost.indexOf('const liquidFunHeap = buildLiquidFunHeap'));
  assert.match(weedPost, /function buildLiquidFunHeap\(/);
  assert.match(ready, /buildLiquidFunHeap\(ready\.sab\)/);
  assert.match(weedPost, /userDataByteOffset:/);
  assert.match(weedPost, /groupIndexByteOffset:/);
  assert.match(weedPost, /colorByteOffset:/);
});

test('box2dWasm.js importScripts resolve to exact-case siblings', () => {
  const listed = readdirSync(box2dDir);
  assert.ok(listed.includes('box2dWasm.js'), 'missing box2dWasm.js');
  assert.equal(
    listed.includes('box2d_wasm.js'),
    false,
    'leftover box2d_wasm.js — C Weed build must emit box2dWasm.js only',
  );
  const glue = 'box2dWasm.js';
  const src = readFileSync(join(box2dDir, glue), 'utf8');
  const imported = extractAllImportScriptNames(src);
  assert.ok(imported.includes('weedjsPost.js'), `${glue} must importScripts("weedjsPost.js")`);
  assert.ok(
    imported.includes('physicsHostImpl.js'),
    `${glue} must importScripts("physicsHostImpl.js")`,
  );
  assert.equal(
    imported.includes('weedjs_post.js'),
    false,
    `${glue} still importScripts("weedjs_post.js") — case-sensitive src/box2d 404s that file`,
  );
  assert.equal(
    imported.includes('physics_host.impl.js'),
    false,
    `${glue} still importScripts("physics_host.impl.js")`,
  );
  assertExactCaseFiles(box2dDir, imported, glue);
  assert.match(src, /locateFile\("box2dWasm\.wasm"\)/);
  assert.doesNotMatch(src, /locateFile\("box2d_wasm\.wasm"\)/);
});
