import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../../tests/helpers/registerWebRoot.mjs';

// docs/guide/FIRST_GAME.md walks through this file; the guide's examples must run.
// (Played end to end in Chromium when it was written: pickup, hits, game over, restart.)

const url = new URL('../../docs/guide/first-game/coinRushScene.js', import.meta.url);
globalThis.WEED = (await import('../../src/index.js')).default; // the scene uses the page's global WEED
const { CoinRushScene } = await import(url.href);
const { GameObject } = await import('../../src/core/gameObject.js');
const { warnMissingListenerTags } = await import('../../src/util/listenerTags.js');

test('Coin Rush registers without a missing-tag warning', () => {
  const warnings = [];
  const registered = CoinRushScene.entities.map(([C]) => ({ class: C, components: GameObject._collectComponents(C) }));
  warnMissingListenerTags(registered, GameObject, (m) => warnings.push(m));
  assert.deepEqual(warnings, []);
});

test('every message name the code sends is in static messages', () => {
  const src = readFileSync(url, 'utf8');
  const used = new Set();
  for (const m of src.matchAll(/sendTo\([^,]+,\s*'([^']+)'/g)) used.add(m[1]);
  for (const m of src.matchAll(/onComplete:\s*'([^']+)'/g)) used.add(m[1]);
  assert.ok(used.size >= 3, `found ${[...used]}`);
  for (const name of used) assert.ok(CoinRushScene.messages.includes(name), `'${name}' is not declared`);
});
