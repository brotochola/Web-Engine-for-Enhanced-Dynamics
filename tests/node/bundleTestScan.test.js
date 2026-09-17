import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyTestFile } from '../../scripts/bundleTestScan.mjs';

const fromFile = fileURLToPath(new URL('./fake.test.js', import.meta.url));
const repoRoot = path.resolve(path.dirname(fromFile), '../..');

function classify(source, exportNames) {
  return classifyTestFile(source, { fromFile, repoRoot, exportNames });
}

test('named import present on the bundle is eligible', () => {
  const spec = ['..', '..', 'src', 'core', 'decal.js'].join('/');
  const result = classify(`import { Decal } from '${spec}';\n`, new Set(['Decal']));
  assert.equal(result.ok, true);
});

test('named import missing from the bundle is skipped', () => {
  const spec = ['..', '..', 'src', 'core', 'querySystem.js'].join('/');
  const result = classify(
    `import { QuerySystem } from '${spec}';\n`,
    new Set(['Query', 'Decal']),
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing QuerySystem/);
});

test('readFile of a src/ path is skipped', () => {
  const diskPath = ['src', 'box2d', 'weedjsPost.js'].join('/');
  const result = classify(
    `import { readFileSync } from 'node:fs';\nreadFileSync(join(root, '${diskPath}'));\n`,
    new Set(['Decal']),
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /reads src\/ on disk/);
});
