import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { resolveParticleLights } from '../../src/render/particleLightSplat.js';

// B25. Whether particle lights run is the config's alone (lighting.particleLights): the one light pass draws them,
// with walls or without. The pass that could not draw them, and the warning that switched them off under it, went
// with OL-15.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('the config is honoured', () => {
  assert.deepEqual(resolveParticleLights({ enabled: true, max: 64 }), { enabled: true, max: 64, warning: null });
  assert.deepEqual(resolveParticleLights({ enabled: true }), { enabled: true, max: 256, warning: null });
  assert.deepEqual(resolveParticleLights(undefined), { enabled: false, max: 0, warning: null });
  assert.deepEqual(resolveParticleLights({ enabled: false, max: 64 }), { enabled: false, max: 0, warning: null });
  // Nothing to draw: no splat and no lighting RT forced for it.
  assert.deepEqual(resolveParticleLights({ enabled: true, max: 0 }), { enabled: false, max: 0, warning: null });
});

test('Pixi decides before it builds the lighting system and the splat', () => {
  const pixi = readFileSync(join(root, 'src/workers/pixiWorker.js'), 'utf8');
  const resolve = pixi.indexOf('resolveParticleLights(');
  // The init's call, the last (DX-BARRIOS: _rebuildLightPass calls it again when faces turn on later).
  // N-256 PW-6: the light pass is the worker's lighting (src/render/pixi/lighting.js), which _initLighting calls.
  const build = pixi.lastIndexOf('this.lighting.createLightingSystem();');
  const splat = pixi.indexOf('this.lighting.createParticleLightSplat(this._particleLightMax);');
  assert.ok(resolve > 0 && resolve < build && build < splat);
  // From the scene's particleLights alone: walls (visibilityPolygons) do not switch them off.
  const call = pixi.slice(resolve, pixi.indexOf(');', resolve));
  assert.match(call, /^resolveParticleLights\(\s*lightingConfig\.particleLights,?\s*$/);
});

// B29 (particleLights.max unvalidated). The splat allocates max instances up
// front; a stray 1e8 tried to allocate 1.6 GB.
test('particleLights.max is capped with a warning', async () => {
  const { PARTICLE_LIGHT_MAX } = await import('../../src/render/particleLightSplat.js');
  const r = resolveParticleLights({ enabled: true, max: 1e8 });
  assert.equal(r.enabled, true);
  assert.equal(r.max, PARTICLE_LIGHT_MAX);
  assert.equal(PARTICLE_LIGHT_MAX, 1048575, 'the particle pool ceiling (E-129, DX-DECO1M)');
  assert.match(r.warning, /above 1048575; capped/);
  assert.deepEqual(resolveParticleLights({ enabled: true, max: PARTICLE_LIGHT_MAX }).warning, null);
});
