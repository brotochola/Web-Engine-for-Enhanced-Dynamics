import test from 'node:test';
import assert from 'node:assert/strict';

import { sharedArrayBufferMissing } from '../../src/util/crossOriginIsolation.js';

// The old error said "Check CORS headers"; the fix is two other headers.

test('a page without SharedArrayBuffer gets the two isolation headers and the deploy guide', () => {
  const message = sharedArrayBufferMissing({});
  assert.match(message, /Cross-Origin-Opener-Policy: same-origin/);
  assert.match(message, /Cross-Origin-Embedder-Policy: require-corp/);
  assert.match(message, /docs\/guide\/DEPLOY\.md/);
  assert.doesNotMatch(message, /CORS/);
});

test('an isolated page passes', () => {
  assert.equal(sharedArrayBufferMissing({ SharedArrayBuffer }), null);
  assert.equal(sharedArrayBufferMissing(), null);
});
