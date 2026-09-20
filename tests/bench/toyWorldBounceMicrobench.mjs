import { timeIt, mulberry32 } from './microbenchHelpers.mjs';
import {
  toyWorldBounce,
  toyWorldBounceChecksum,
  TOY_LEFT,
  TOY_RIGHT,
  TOY_TOP,
  TOY_BOTTOM,
} from '../../src/util/toyWorldBounce.js';

const N = 20000;
const STEPS = 120;
const SEED = 0x71c7a11;

function makeState(seed) {
  const rng = mulberry32(seed);
  const xs = new Float32Array(N);
  const ys = new Float32Array(N);
  const vxs = new Float32Array(N);
  const vys = new Float32Array(N);
  const ids = new Uint16Array(N);
  for (let i = 0; i < N; i++) {
    ids[i] = i;
    xs[i] = TOY_LEFT + rng() * (TOY_RIGHT - TOY_LEFT);
    ys[i] = TOY_TOP + rng() * (TOY_BOTTOM - TOY_TOP);
    vxs[i] = rng() * 10 - 5;
    vys[i] = rng() * 10 - 5;
  }
  return { xs, ys, vxs, vys, ids };
}

function runSteps(state, steps, dtRatio = 1) {
  for (let s = 0; s < steps; s++) {
    toyWorldBounce(
      state.xs,
      state.ys,
      state.vxs,
      state.vys,
      state.ids,
      N,
      dtRatio,
      TOY_LEFT,
      TOY_RIGHT,
      TOY_TOP,
      TOY_BOTTOM,
    );
  }
}

const a = makeState(SEED);
const b = makeState(SEED);
runSteps(a, STEPS);
runSteps(b, STEPS);
const checksumA = toyWorldBounceChecksum(a.xs, a.ys, a.vxs, a.vys, N);
const checksumB = toyWorldBounceChecksum(b.xs, b.ys, b.vxs, b.vys, N);
if (checksumA !== checksumB) {
  throw new Error(`toyWorldBounce checksum mismatch ${checksumA} vs ${checksumB}`);
}

for (let i = 0; i < N; i++) {
  if (a.xs[i] < TOY_LEFT - 1e-3 || a.xs[i] > TOY_RIGHT + 1e-3) {
    throw new Error(`x out of box at ${i}: ${a.xs[i]}`);
  }
  if (a.ys[i] < TOY_TOP - 1e-3 || a.ys[i] > TOY_BOTTOM + 1e-3) {
    throw new Error(`y out of box at ${i}: ${a.ys[i]}`);
  }
}

const state = makeState(SEED);
const timed = timeIt(
  `toyWorldBounce N=${N} steps=${STEPS}`,
  () => {
    runSteps(state, STEPS);
  },
);

console.log(
  JSON.stringify(
    {
      checksum: checksumA,
      n: N,
      steps: STEPS,
      ...timed,
    },
    null,
    2,
  ),
);
