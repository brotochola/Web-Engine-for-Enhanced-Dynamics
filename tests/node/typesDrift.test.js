import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// DX 6. types/weed.d.ts is hand-written and had fallen behind (most GameObject
// methods and hooks were missing). scripts/checkTypesDrift.mjs compares the
// runtime's public members (and WASM_DEFAULTS' switches) with it; this keeps the node suite failing on drift.

test('GameObject, Scene, GameEngine, the WEED namespace and config.wasm\'s switches are declared in weed.d.ts', () => {
  const script = fileURLToPath(new URL('../../scripts/checkTypesDrift.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});
