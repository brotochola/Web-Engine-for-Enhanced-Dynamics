// DX-GUARDS: the production bundle holds none of the run-time guards (it takes stubs/devChecks.js); the debug bundle
// holds them all. Read in the built bundles (dist/, fresh per npm run check:dist), the page's and the workers' code
// both: the workers are strings in the bundle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

/** A piece of each run-time guard's text, E1 to E7. */
const RUN_TIME = [
  'which hides its',
  'is first written after onSpawned',
  'after its Box2D body exists',
  'set by hand to',
  'a heighted particle at z >= 0 is on the floor',
  'without spritesheet, so it',
  'is not a key the engine reads',
];

const dist = (name) => new URL(`../../dist/${name}`, import.meta.url);

/** A bundle's text with its gzipped payloads (workers, shaders: base64 that starts "H4sI") inflated beside it (N-172). */
function bundleText(name) {
  const text = readFileSync(dist(name), 'utf8');
  const inflated = [];
  for (const m of text.matchAll(/"(H4sI[A-Za-z0-9+/]+={0,2})"/g)) {
    try {
      inflated.push(gunzipSync(Buffer.from(m[1], 'base64')).toString('utf8'));
    } catch {
      // not a gzip payload
    }
  }
  return [text, ...inflated].join('\n');
}

for (const name of ['weed.prod.bundle.min.js', 'weed.prod.bundle.esm.min.js']) {
  test(`${name} holds none of the run-time guards' texts`, { skip: !existsSync(dist(name)) && 'not built' }, () => {
    const text = bundleText(name);
    assert.deepEqual(RUN_TIME.filter((piece) => text.includes(piece)), []);
  });
}

for (const name of ['weed.bundle.esm.min.js']) {
  test(`${name} (debug) holds every run-time guard's text`, { skip: !existsSync(dist(name)) && 'not built' }, () => {
    const text = bundleText(name);
    assert.deepEqual(RUN_TIME.filter((piece) => !text.includes(piece)), []);
  });
}
