// E-369: pre-render's fast arctangent picks a lamp's frame of a directional caster; it must stay within 2e-5 rad of
// Math.atan2 all the way round (a sheet's step is 11.25° at 32 directions), and agree on the axes and the signs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';

test('fastAtan2 is within 2e-5 rad of Math.atan2 everywhere, exact on the axes', async () => {
  await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const { fastAtan2 } = await import('../../src/workers/preRenderWorker.js');
  let worst = 0;
  for (let k = 0; k < 20000; k++) {
    const a = (k / 20000) * 2 * Math.PI - Math.PI;
    for (const r of [1e-3, 1, 37.5, 4000]) {
      const y = Math.sin(a) * r;
      const x = Math.cos(a) * r;
      const d = Math.abs(fastAtan2(y, x) - Math.atan2(y, x));
      // ±π are the same direction.
      const e = Math.min(d, Math.abs(d - 2 * Math.PI));
      if (e > worst) worst = e;
    }
  }
  assert.ok(worst < 2e-5, `worst ${worst}`);
  for (const [y, x] of [[0, 1], [1, 0], [0, -1], [-1, 0], [0, 0]]) {
    assert.ok(Math.abs(fastAtan2(y, x) - Math.atan2(y, x)) < 1e-12, `(${y}, ${x})`);
  }
});
