import test from 'node:test';
import assert from 'node:assert/strict';

import { confirmRegression } from '../bench/runScoreboard.mjs';

// N-35. The scoreboard ran stress rows 2 times per side, back to back, and four
// of the six rows it flagged against main were noise. A WORSE row is now
// re-measured over 4 alternating pairs and stays WORSE only if the median is
// still 3 % worse and at least 3 of the 4 pairs are worse.

test('a regression that holds over the pairs is confirmed', () => {
  const r = confirmRegression([4.1, 5.0, 3.2, -0.5], false);
  assert.equal(r.confirmed, true);
  assert.equal(r.worseCount, 3);
});

test('noise is not: textureUpload "+15 %" was -11 % over 4 pairs', () => {
  assert.equal(confirmRegression([-12, -9, -14, -8], false).confirmed, false);
  // Median 3 % worse, but only half the pairs: not confirmed.
  assert.equal(confirmRegression([9, 8, -1, -2], false).confirmed, false);
  // Every pair worse, but under 3 %: a tie, not a regression.
  assert.equal(confirmRegression([1, 2, 1.5, 2.5], false).confirmed, false);
});

test('for a kernel, fewer ops per second is worse', () => {
  assert.equal(confirmRegression([-5, -4, -6, -3.5], true).confirmed, true);
  assert.equal(confirmRegression([-5, -4, -6, -3.5], false).confirmed, false);
  assert.equal(confirmRegression([], true).confirmed, false);
});
