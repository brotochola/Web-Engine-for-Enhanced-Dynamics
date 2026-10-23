/**
 * Display lerp between two pre-render queue publishes.
 * Alpha 0 shows the previous pose, alpha 1 the current one.
 * A count change snaps to the new pose (no slot pairing).
 */

export function poseLerp(prev, cur, alpha) {
  return prev + (cur - prev) * alpha;
}

/** 1 when the two queues cannot be paired by slot. */
export function poseDisplayAlpha(prevCount, curCount, rampAlpha) {
  if ((prevCount | 0) !== (curCount | 0)) return 1;
  return rampAlpha;
}

