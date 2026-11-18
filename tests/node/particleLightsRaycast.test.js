import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { resolveParticleLights } from '../../src/render/particleLightSplat.js';

// B25. The old fan pass (debug.lightFans with lighting.walls: lighting.wallFans,
// OL-4) never draws particle lights (it skips them like the liquid light
// field), but with both on Pixi still allocated the particle light splat and
// forced a lighting render texture. They are switched off at init with a
// warning. Walls the light pass reads (walls without debug.lightFans) draw them.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('the old fan pass (debug.lightFans) switches particle lights off, with a warning', () => {
  const r = resolveParticleLights({ enabled: true, max: 64 }, true);
  assert.equal(r.enabled, false);
  assert.equal(r.max, 0);
  assert.match(r.warning, /^lighting\.particleLights is ignored with debug\.lightFans \(the old fan pass\)/);
});

// `false` is every scene but the old fan pass's, walls the light pass reads among them.
test('without the old fan pass the config is honoured, walls or not', () => {
  assert.deepEqual(resolveParticleLights({ enabled: true, max: 64 }, false), { enabled: true, max: 64, warning: null });
  assert.deepEqual(resolveParticleLights({ enabled: true }, false), { enabled: true, max: 256, warning: null });
  assert.deepEqual(resolveParticleLights(undefined, false), { enabled: false, max: 0, warning: null });
  assert.deepEqual(resolveParticleLights({ enabled: false, max: 64 }, true), { enabled: false, max: 0, warning: null });
  // Nothing to draw: no splat and no lighting RT forced for it.
  assert.deepEqual(resolveParticleLights({ enabled: true, max: 0 }, false), { enabled: false, max: 0, warning: null });
});

test('Pixi decides before it builds the lighting system and the splat', () => {
  const pixi = readFileSync(join(root, 'src/workers/pixiWorker.js'), 'utf8');
  const resolve = pixi.indexOf('resolveParticleLights(');
  // The init's call, the last (DX-BARRIOS: _rebuildLightPass calls it again when faces turn on later).
  const build = pixi.lastIndexOf('this.createLightingSystem();');
  const splat = pixi.indexOf('this._createParticleLightSplat(this._particleLightMax);');
  assert.ok(resolve > 0 && resolve < build && build < splat);
  // OL-4: from the old fan pass alone (lighting.wallFans), not from whether the walls' sweep runs (visibilityPolygons).
  const call = pixi.slice(resolve, pixi.indexOf(');', resolve));
  assert.match(call, /^resolveParticleLights\(\s*lightingConfig\.particleLights,\s*lightingConfig\.wallFans === true,?\s*$/);
});

// B29 (particleLights.max unvalidated). The splat allocates max instances up
// front; a stray 1e8 tried to allocate 1.6 GB.
test('particleLights.max is capped with a warning', async () => {
  const { PARTICLE_LIGHT_MAX } = await import('../../src/render/particleLightSplat.js');
  const r = resolveParticleLights({ enabled: true, max: 1e8 }, false);
  assert.equal(r.enabled, true);
  assert.equal(r.max, PARTICLE_LIGHT_MAX);
  assert.equal(PARTICLE_LIGHT_MAX, 1048575, 'the particle pool ceiling (E-129, DX-DECO1M)');
  assert.match(r.warning, /above 1048575; capped/);
  assert.deepEqual(resolveParticleLights({ enabled: true, max: PARTICLE_LIGHT_MAX }, false).warning, null);
});
