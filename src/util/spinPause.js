/**
 * E-441: one pause in a spin wait. Atomics.pause (Chrome 133+) tells the core this thread is spinning: an SMT sibling
 * (the ASUS's i7-7500U runs two threads a core) gets the pipeline, and the spin draws less power. Where it is missing
 * (Node 22, older browsers) this does nothing. A spin that does not spin never calls it.
 */
const HAS_PAUSE = typeof Atomics.pause === 'function';

export function spinPause() {
  if (HAS_PAUSE) Atomics.pause();
}
