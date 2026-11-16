// N-212: lighting.maxShadowCastingLights keeps the lights nearest the view's centre; the kept ones near the cut fade their
// shadows out (fade and shade down to 0 at the first light left out), so a light crossing the cut does not pop.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';

async function load() {
  await loadWorker('preRenderWorker.js', 'preRenderWorker');
  return import('../../src/workers/preRenderWorker.js');
}

/** Stamp light slots at these distances from the view's centre (sorted, as stampLightOrder leaves them). */
function lightsAt(distances, shade = 1) {
  return distances.map((d, id) => ({ id, distSq: d * d, shade, fade: 1 }));
}

test('N-212: no light left out, no fade', async () => {
  const { fadeStampLightsAtCut } = await load();
  const lights = lightsAt([100, 200, 300]);
  fadeStampLightsAtCut(lights, 3, 3);
  fadeStampLightsAtCut(lights, 3, 8);
  for (const L of lights) {
    assert.equal(L.fade, 1);
    assert.equal(L.shade, 1);
  }
});

test('N-212: the kept lights fade out over the band before the first light left out', async () => {
  const { fadeStampLightsAtCut, STAMP_CUT_FADE } = await load();
  // Cap 4: the light at 1000 is the first left out; the band is the last 20 % of its distance (800 to 1000).
  const lights = lightsAt([100, 700, 900, 1000, 1000, 1200], 0.5);
  fadeStampLightsAtCut(lights, 6, 4);
  assert.equal(STAMP_CUT_FADE, 0.2);
  assert.equal(lights[0].fade, 1, 'far inside the band');
  assert.equal(lights[1].fade, 1, 'just inside it');
  assert.ok(Math.abs(lights[2].fade - 0.5) < 1e-12, `900: halfway, got ${lights[2].fade}`);
  assert.ok(Math.abs(lights[2].shade - 0.25) < 1e-12, 'the shade takes the fade (0.5 x 0.5)');
  assert.equal(lights[3].fade, 0, 'a kept light as far as the first one out casts nothing: crossing the cut does not pop');
  assert.equal(lights[3].shade, 0);
  // The lights left out are not touched (they cast nothing anyway).
  assert.equal(lights[4].fade, 1);
  assert.equal(lights[5].shade, 0.5);
});

test('N-212: a light moving across the cut fades continuously', async () => {
  const { fadeStampLightsAtCut } = await load();
  // A light moving outwards past its neighbour at 1000 (cap 2): its fade falls to 0 as it reaches 1000, and the
  // neighbour that takes its place starts at 0.
  let last = 1;
  for (let d = 760; d <= 1000; d += 20) {
    const lights = lightsAt([100, d, 1000]);
    fadeStampLightsAtCut(lights, 3, 2);
    assert.ok(lights[1].fade <= last + 1e-12, `fade grows at ${d}`);
    last = lights[1].fade;
  }
  assert.equal(last, 0);
  const swapped = lightsAt([100, 1000, 1010]);
  fadeStampLightsAtCut(swapped, 3, 2);
  assert.ok(swapped[1].fade < 0.06, `the light coming in starts near 0, got ${swapped[1].fade}`);
});

test('N-212: pre-render publishes each stamp light\'s fade beside its id', async () => {
  const pr = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const { computeGpuQueueBufferSize, createGpuQueueViews, gpuQueueCaps } = await import('../../src/render/gpuQueueLayout.js');
  const caps = gpuQueueCaps(64, { enabled: true, shadowsEnabled: true, maxLights: 16, maxShadowCastingLights: 3 });
  const dst = createGpuQueueViews(new SharedArrayBuffer(computeGpuQueueBufferSize(caps)), caps);
  pr._stampLights = [{ id: 7, fade: 1 }, { id: 3, fade: 0.5 }, { id: 9, fade: 0 }, { id: 2, fade: 1 }];
  pr._stampLightCount = 4;
  const n = pr._writeStampLightIds(dst, 10);
  assert.equal(n, 3, 'as many as the cap holds');
  assert.deepEqual(Array.from(dst.stampLightIds), [7, 3, 9]);
  assert.deepEqual(Array.from(dst.stampLightFade), [1, 0.5, 0]);
});

test('N-212: the adaptive budget is the stamps\' only, not the lamps\' map\'s', async () => {
  const { adaptiveStampBudget } = await load();
  assert.equal(adaptiveStampBudget({}), true, 'on by default');
  assert.equal(adaptiveStampBudget(undefined), true);
  assert.equal(adaptiveStampBudget({ lampShadows: 'sprite' }), true);
  assert.equal(adaptiveStampBudget({ adaptiveShadowBudget: false }), false);
  assert.equal(adaptiveStampBudget({ lampShadows: 'map' }), false, 'the map\'s tiles keep their size whatever the zoom');
});
