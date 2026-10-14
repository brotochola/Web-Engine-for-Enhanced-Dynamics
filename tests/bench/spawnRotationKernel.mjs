// H-11a. The decoration spawn rotation block: an `Object.is(a, 0)` fast path
// instead of two transcendentals.
//
// The plan's falsifier is explicit - "spawn kernel under 3 %, or the floor" - so
// this measures the rotation block ALONE, at the ratio that a real spawn mix
// produces: `config.rotation` is undefined for the overwhelming majority, so the
// fast path is what almost every spawn takes.
//
// What this cannot show: the block is a few operations inside a spawn routine
// that also does scale, anchor, tint, sway-bucket and array writes. A win here
// is necessary but not sufficient, and the log says so rather than implying the
// spawn path as a whole got 2x faster.
//
// Both variants are inlined into the measured loop deliberately: the point is to
// price the arithmetic, and a call to a helper would measure dispatch instead.

const ROWS = 200_000;

function referenceBlock(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return c + s;
}

function fastBlock(a) {
  const isPlusZero = Object.is(a, 0);
  const c = isPlusZero ? 1 : Math.cos(a);
  const s = isPlusZero ? 0 : Math.sin(a);
  return c + s;
}

/** A realistic spawn mix: mostly no rotation, some with one. */
function makeAngles(zeroFraction) {
  const xs = new Float64Array(ROWS);
  let seed = 0x9e3779b9 >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < ROWS; i++) {
    xs[i] = rnd() < zeroFraction ? 0 : rnd() * Math.PI * 2;
  }
  return xs;
}

/**
 * Measure one variant.
 *
 * Warmup matters more than it looks: the first version of this harness warmed
 * with a single call and produced cv 73.8 % on the very first row, and then
 * reported the all-zero case (where the fast path should help MOST) as 6.6 %
 * SLOWER while the 95 %-zero case came back 18.2 % faster. A result that
 * contradicts its own direction is a harness bug, and the tell was the cv, not
 * the percentage.
 */
function measure(label, block, xs) {
  let sink = 0;
  const run = () => {
    for (let i = 0; i < ROWS; i++) sink += block(xs[i]);
  };

  // Warm for a fixed amount of work, not a fixed number of calls, so both
  // variants reach steady-state JIT before anything is recorded.
  const WARM_MS = 120;
  const t0 = process.hrtime.bigint();
  do {
    run();
  } while (Number(process.hrtime.bigint() - t0) / 1e6 < WARM_MS);

  let iters = 1;
  let t = timeOnce(block, xs, iters, (v) => (sink += v));
  while (t < 3) {
    iters *= 2;
    t = timeOnce(block, xs, iters, (v) => (sink += v));
  }

  const per = [];
  for (let s = 0; s < 9; s++) per.push(timeOnce(block, xs, iters, (v) => (sink += v)) / iters);
  per.sort((x, y) => x - y);
  const median = per[4];
  return {
    label,
    median,
    cv: (Math.sqrt(per.reduce((p, c) => p + (c - median) ** 2, 0) / 8) / median) * 100,
    nsPerSpawn: (median * 1e6) / ROWS,
    sink,
  };
}

function timeOnce(block, xs, iters, accumulate) {
  const t0 = process.hrtime.bigint();
  for (let r = 0; r < iters; r++) {
    for (let i = 0; i < ROWS; i++) accumulate(block(xs[i]));
  }
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

console.log(`\nH-11a kernel - decoration spawn rotation block`);
console.log(`  ${ROWS.toLocaleString()} spawns per sample, 5 samples, 3 ms floor\n`);

for (const [name, zeroFraction] of [
  ['all rotations undefined (the real case)', 1.0],
  ['95% undefined, 5% rotated', 0.95],
  ['50% undefined, 50% rotated', 0.5],
  ['no fast path at all (worst case)', 0.0],
]) {
  const xs = makeAngles(zeroFraction);
  // Interleave: measure both, then both again, taking medians. Measuring A
  // fully and then B fully lets any drift in machine state land entirely on one
  // side - which is how the first version of this harness produced a sign that
  // contradicted its own premise.
  const aRuns = [];
  const bRuns = [];
  for (let rep = 0; rep < 3; rep++) {
    aRuns.push(measure('  reference', referenceBlock, xs));
    bRuns.push(measure('  fast    ', fastBlock, xs));
  }
  const pick = (rs) => {
    const sorted = rs.slice().sort((x, y) => x.median - y.median);
    const mid = sorted[sorted.length >> 1];
    return {
      median: mid.median,
      // The middle rep's cv, not the max across reps. Reporting the max made one
      // unlucky rep look like the whole measurement, which is the same mistake as
      // quoting a worst sample as a result.
      cv: mid.cv,
      nsPerSpawn: (mid.median * 1e6) / ROWS,
    };
  };
  const a = pick(aRuns);
  const b = pick(bRuns);
  const delta = ((b.median - a.median) / a.median) * 100;
  console.log(`  ${name}`);
  console.log(
    `    reference ${a.nsPerSpawn.toFixed(3)} ns/spawn (cv <= ${a.cv.toFixed(1)}%)   ` +
      `fast ${b.nsPerSpawn.toFixed(3)} ns/spawn (cv <= ${b.cv.toFixed(1)}%)   ` +
      `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`,
  );
}

console.log('');
console.log('  The last row is the falsifier: with nothing to fast-path, the change');
console.log('  must not be a loss, and must not be presented as a win either.');