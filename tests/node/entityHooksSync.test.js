import test from 'node:test';
import assert from 'node:assert/strict';

// The table from source, imported here so the bundle test runner (bundleTestScan.mjs, which does not walk scripts/) sees
// that this test reads a module the bundles do not export, and runs it against the sources only.
import { ENTITY_HOOKS } from '../../src/core/entityHooks.js';
import { expectedFiles } from '../../scripts/syncEntityHooks.mjs';

// E-528: GameObject's hook declarations in types/weed.d.ts and the guide's hook table are written from the one hook
// table, src/core/entityHooks.js. A hook added there (or changed) and not written out fails here: run
// node scripts/syncEntityHooks.mjs.

test('types/weed.d.ts and the guide list the hooks the hook table holds', async () => {
  for (const { file, current, wanted } of await expectedFiles(ENTITY_HOOKS)) {
    assert.ok(current === wanted, `${file} is stale: run node scripts/syncEntityHooks.mjs`);
  }
});
