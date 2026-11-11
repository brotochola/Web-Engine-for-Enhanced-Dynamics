// DX-GUARDS: the production bundle holds none of the run-time guards (it takes stubs/devChecks.js); the debug bundle
// holds them all. Read in the built bundles (dist/, fresh per npm run check:dist), the page's and the workers' code
// both: the workers are strings in the bundle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

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

for (const name of ['weed.prod.bundle.min.js', 'weed.prod.bundle.esm.min.js']) {
  test(`${name} holds none of the run-time guards' texts`, { skip: !existsSync(dist(name)) && 'not built' }, () => {
    const text = readFileSync(dist(name), 'utf8');
    assert.deepEqual(RUN_TIME.filter((piece) => text.includes(piece)), []);
  });
}

for (const name of ['weed.bundle.min.js', 'weed.bundle.esm.min.js']) {
  test(`${name} (debug) holds every run-time guard's text`, { skip: !existsSync(dist(name)) && 'not built' }, () => {
    const text = readFileSync(dist(name), 'utf8');
    assert.deepEqual(RUN_TIME.filter((piece) => !text.includes(piece)), []);
  });
}
