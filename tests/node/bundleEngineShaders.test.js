import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEngineShaders } from '../../scripts/buildBundle.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

// An npm install ships dist/ only: every shader the renderer fetches must be in the bundle.
test('bundles embed every engine shader the renderer fetches', () => {
  const embedded = readEngineShaders();
  const pixi = readFileSync(join(root, 'src/workers/pixiWorker.js'), 'utf8');
  const fetched = [...pixi.matchAll(/fetchEngineShader\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(fetched.length > 30, `found ${fetched.length} fetches`);
  for (const p of fetched) {
    assert.ok(p.startsWith('/src/shaders/'), p);
    assert.ok(embedded[p] && embedded[p].trim().length > 0, `${p} is not embedded`);
  }
});
