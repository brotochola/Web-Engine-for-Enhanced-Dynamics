import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractImportScriptNames,
  listBox2dSiblingNames,
} from '../../scripts/buildBundle.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const box2dDir = join(root, 'src', 'box2d');
const weedPost = readFileSync(join(box2dDir, 'weedjsPost.js'), 'utf8');
const buildBundleSrc = readFileSync(join(root, 'scripts', 'buildBundle.js'), 'utf8');

test('weedjs_post importScripts siblings exist and are auto-embedded', () => {
  const imported = extractImportScriptNames(weedPost);
  assert.ok(imported.length > 0, 'weedjs_post.js has no importScripts filenames');
  assert.ok(imported.includes('box2dRayCastImpl.js'), 'missing box2dRayCast.impl.js');
  assert.ok(imported.includes('liquidFunQueryImpl.js'), 'missing liquidFunQuery.impl.js');

  for (const name of imported) {
    assert.ok(existsSync(join(box2dDir, name)), `missing src/box2d/${name}`);
  }

  const siblings = listBox2dSiblingNames(weedPost);
  assert.ok(siblings.includes('weedjsPost.js'));
  assert.ok(siblings.includes('physicsHostImpl.js'));
  for (const name of imported) {
    assert.ok(siblings.includes(name), `listBox2dSiblingNames omitted ${name}`);
  }

  assert.match(
    buildBundleSrc,
    /listBox2dSiblingNames\(weedPostSource\)/,
    'build-bundle.js must derive siblings from weedjs_post importScripts',
  );
  assert.doesNotMatch(
    buildBundleSrc,
    /const BOX2D_SIBLING_NAMES = \[/,
    'hand-maintained BOX2D_SIBLING_NAMES list must not return — drift is the blob importScripts bug',
  );
});
