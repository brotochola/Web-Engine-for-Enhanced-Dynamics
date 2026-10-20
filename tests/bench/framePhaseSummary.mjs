// E-24 phase verdict over frame-clock samples, for runFramePhase.
//
// Bench logic: it lived in src/util/frameClock.js, which every worker imports,
// so it shipped in the engine bundle (review D4). The rules are unchanged.

function median(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length & 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Phase verdict from samples taken at the end of main-thread frames.
 *
 * Named before any Predator run (E-24):
 * - A worker whose start is more than 100 ms from that sample's mainT0, on a
 *   gen equal to the sample gen or one behind, is not on the shared clock.
 *   One such required worker and the instrument is broken. No phase claim.
 * - A slot-sample whose (end - start) is ≤ 0 or ≥ 40 ms is torn. More than 5%
 *   torn and the instrument is broken.
 * - Per sample, keep slots on the newest gen, plus the previous gen only when
 *   that start is within 12 ms of the newest start (a worker that ran just
 *   before main published, not a stamp left over from the frame before).
 * - Median of (max start − min start) over those samples:
 *     ≤ 2 ms  wake-together
 *     ≥ 8 ms  offset (the plan's falsifier: already pipelined)
 *     else    between
 * Fewer than 30 samples, or fewer than 2 slots in a sample, is not a verdict.
 *
 * @param {Array<{ mainGen: number, mainT0: number, slots: Array<{ name: string, gen: number, start: number, end: number }> }>} samples
 * @param {{ required?: string[] }} [opts]
 */
export function summarizePhase(samples, opts = {}) {
  const required = opts.required || [
    'main',
    'physics',
    'renderer',
    'particle',
    'preRender',
    'logic0',
    'spatial0',
  ];
  const list = Array.isArray(samples) ? samples : [];
  if (list.length < 30) {
    return { verdict: 'thin', samples: list.length, reason: 'fewer than 30 frame samples' };
  }

  let torn = 0;
  let stamped = 0;
  const clockDeltas = Object.create(null);
  for (const name of required) clockDeltas[name] = [];

  for (const sample of list) {
    const mainT0 = sample.mainT0;
    const mainGen = sample.mainGen;
    for (const slot of sample.slots || []) {
      stamped++;
      const duration = slot.end - slot.start;
      if (!(duration > 0) || duration >= 40) {
        torn++;
        continue;
      }
      if (!clockDeltas[slot.name]) continue;
      if (slot.gen === mainGen || slot.gen === mainGen - 1) {
        clockDeltas[slot.name].push(Math.abs(slot.start - mainT0));
      }
    }
  }

  const tornRate = stamped > 0 ? torn / stamped : 1;
  const clocks = {};
  const broken = [];
  for (const name of required) {
    const deltas = clockDeltas[name];
    const med = median(deltas);
    clocks[name] = { n: deltas.length, medianAbsDeltaMs: med };
    if (deltas.length < 10 || med == null || med > 100) broken.push(name);
  }
  if (tornRate > 0.05 || broken.length > 0) {
    return {
      verdict: 'clock-broken',
      samples: list.length,
      tornRate,
      clocks,
      broken,
      reason: tornRate > 0.05
        ? 'more than 5% of stamps were torn or longer than 40 ms'
        : `clock not comparable on ${broken.join(', ')}`,
    };
  }

  const spreads = [];
  let overlapSamples = 0;
  let overlapHits = 0;
  for (const sample of list) {
    const usable = [];
    for (const slot of sample.slots || []) {
      const duration = slot.end - slot.start;
      if (!(duration > 0) || duration >= 40) continue;
      if (slot.name === 'main') continue;
      usable.push(slot);
    }
    if (usable.length < 2) continue;
    let maxGen = 0;
    let newest = -Infinity;
    for (const slot of usable) {
      if (slot.gen > maxGen) maxGen = slot.gen;
      if (slot.start > newest) newest = slot.start;
    }
    const included = usable.filter((slot) => {
      if (slot.gen === maxGen) return true;
      return slot.gen === maxGen - 1 && newest - slot.start <= 12;
    });
    if (included.length < 2) continue;
    let lo = Infinity;
    let hi = -Infinity;
    for (const slot of included) {
      if (slot.start < lo) lo = slot.start;
      if (slot.start > hi) hi = slot.start;
    }
    spreads.push(hi - lo);

    let first = included[0];
    let second = included[1];
    if (second.end - second.start > first.end - first.start) {
      const swap = first;
      first = second;
      second = swap;
    }
    for (let i = 2; i < included.length; i++) {
      const dur = included[i].end - included[i].start;
      if (dur > first.end - first.start) {
        second = first;
        first = included[i];
      } else if (dur > second.end - second.start) {
        second = included[i];
      }
    }
    overlapSamples++;
    if (first.start < second.end && second.start < first.end) overlapHits++;
  }

  const spreadMs = median(spreads);
  if (spreadMs == null) {
    return {
      verdict: 'thin',
      samples: list.length,
      tornRate,
      clocks,
      reason: 'no sample had two fresh worker stamps',
    };
  }

  let verdict = 'between';
  if (spreadMs <= 2) verdict = 'wake-together';
  else if (spreadMs >= 8) verdict = 'offset';

  return {
    verdict,
    samples: list.length,
    spreadSamples: spreads.length,
    spreadMs,
    tornRate,
    clocks,
    overlap: overlapSamples > 0 ? overlapHits / overlapSamples : null,
  };
}
