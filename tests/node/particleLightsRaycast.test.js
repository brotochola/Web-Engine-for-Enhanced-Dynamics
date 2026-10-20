import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { resolveParticleLights } from '../../src/render/particleLightSplat.js';

// B25. Raycasted visibility lighting never draws particle lights (it skips
// them like the liquid light field), but with both on Pixi still allocated the
// particle light splat and forced a lighting render texture. They are now
// switched off at init with a warning.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('raycasted lighting switches particle lights off, with a warning', () => {
  const r = resolveParticleLights({ enabled: true, max: 64 }, true);
  assert.equal(r.enabled, false);
  assert.equal(r.max, 0);
  assert.match(r.warning, /ignored with raycasted lighting/);
});

test('without raycasting the config is honoured as before', () => {
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
  const build = pixi.indexOf('this.createLightingSystem();');
  const splat = pixi.indexOf('this._createParticleLightSplat(this._particleLightMax);');
  assert.ok(resolve > 0 && resolve < build && build < splat);
  assert.match(pixi.slice(resolve, build), /data\.visibilityPolygons && data\.visibilityPolygons\.enabled/);
});

// B29 (particleLights.max unvalidated). The splat allocates max instances up
// front; a stray 1e8 tried to allocate 1.6 GB.
test('particleLights.max is capped with a warning', async () => {
  const { PARTICLE_LIGHT_MAX } = await import('../../src/render/particleLightSplat.js');
  const r = resolveParticleLights({ enabled: true, max: 1e8 }, false);
  assert.equal(r.enabled, true);
  assert.equal(r.max, PARTICLE_LIGHT_MAX);
  assert.match(r.warning, /above 65535; capped/);
  assert.deepEqual(resolveParticleLights({ enabled: true, max: PARTICLE_LIGHT_MAX }, false).warning, null);
});
