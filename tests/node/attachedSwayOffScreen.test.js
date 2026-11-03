// E-196: resolveAttachedDecorations places every attached decoration (the screen test after it reads where) but sways
// only the ones on screen last frame, as the world-owned sway does: one off screen gets its facing without the sway
// (no sine), and an impulse holds its phase. On screen, the pass writes what it writes with every decoration on
// screen; one that comes on screen sways from the next pass on.
import test from 'node:test';
import assert from 'node:assert/strict';

import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { Transform } from '../../src/components/transform.js';
import { SWAY_IMPULSE, SWAY_LOOP_SKEW } from '../../src/util/decorationSway.js';
import { setupAttachedSway } from '../bench/attachedSwayMicrobench.mjs';

const D = DecorationComponent;

test('E-196: attached decorations off screen are placed, not swayed; on screen they sway as before', async () => {
  const s = await setupAttachedSway({ n: 2000, parents: 40 });
  const { n } = s;
  // Impulses and skews among the loops.
  for (let i = 0; i < n; i += 7) {
    D.sway[i] = SWAY_IMPULSE;
    D.swayPhase[i] = 0.5 + (i % 5) * 0.3;
  }
  for (let i = 3; i < n; i += 11) D.sway[i] = SWAY_LOOP_SKEW;
  const flags = D.isItOnScreen.slice(0, n);
  const mode = D.sway.slice(0, n);
  const phase = D.swayPhase.slice(0, n);

  // The reference: the same pass with every decoration on screen.
  D.isItOnScreen.fill(1, 0, n);
  s.frame();
  const ref = { c: D.rotC.slice(0, n), s: D.rotS.slice(0, n), phase: D.swayPhase.slice(0, n), x: D.x.slice(0, n), y: D.y.slice(0, n) };

  D.sway.set(mode);
  D.swayPhase.set(phase);
  D.isItOnScreen.set(flags);
  s.frame();
  let on = 0;
  let off = 0;
  for (let i = 0; i < n; i++) {
    assert.ok(Object.is(D.x[i], ref.x[i]) && Object.is(D.y[i], ref.y[i]), `decoration ${i} is placed either way`);
    if (flags[i]) {
      on++;
      assert.ok(Object.is(D.rotC[i], ref.c[i]) && Object.is(D.rotS[i], ref.s[i]), `on screen ${i}: the same sway`);
      assert.ok(Object.is(D.swayPhase[i], ref.phase[i]), `on screen ${i}: the same phase`);
    } else {
      off++;
      // The facing its base rotation and its parent give it (the parents do not turn here).
      assert.ok(Object.is(D.rotC[i], D.baseRotC[i]) && Object.is(D.rotS[i], D.baseRotS[i]), `off screen ${i}: unswayed`);
      assert.ok(Object.is(D.swayPhase[i], phase[i]), `off screen ${i}: an impulse holds its phase`);
      assert.equal(D.sway[i], mode[i]);
    }
  }
  assert.ok(on > n / 10 && off > n / 10, `${on} on screen, ${off} off`);

  // Off screen it still follows its parent.
  const k = flags.findIndex((f, i) => f === 0 && mode[i] !== SWAY_IMPULSE);
  const p = D.parentEntityIndex[k];
  Transform.x[p] += 50;
  s.frame();
  assert.equal(D.x[k], Math.fround(Transform.x[p] + D.localX[k]));
  assert.ok(Object.is(D.rotC[k], D.baseRotC[k]));

  // And sways from the pass after the one that saw it on screen.
  D.isItOnScreen[k] = 1;
  s.frame();
  assert.ok(!Object.is(D.rotC[k], D.baseRotC[k]) || !Object.is(D.rotS[k], D.baseRotS[k]), 'swayed once on screen');
});
