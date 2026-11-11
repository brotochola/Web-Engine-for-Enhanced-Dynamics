/**
 * N-128: a fixed-rate loop's next deadline (a worker's `fixedFps`, the physics host's too).
 *
 * `setInterval(loop, 1000 / fps)`, like a plain `setTimeout(loop, period)`, takes whole milliseconds (WebIDL `long`):
 * 60 frames a second asked for 16 ms and ran at 62.5, with each step's dt fixed at 1/60, so the simulation ran about
 * 4 % fast. Each frame is due one period after the last frame's deadline instead, so the rounding does not add up and
 * the mean rate is the one asked for.
 *
 * @param {number} prevAt the last frame's deadline, in performance.now() ms (NaN for none)
 * @param {number} period the frame's length in ms
 * @param {number} now performance.now()
 * @returns {number} one period after prevAt; or one period from now on the first frame, after a pause, or when the
 *   loop is more than a frame behind (no burst of catch-up frames)
 */
export function nextFixedDeadline(prevAt, period, now) {
  const next = prevAt + period;
  return next > now - period ? next : now + period;
}

/** The setTimeout delay to a deadline: whole or not, never negative. */
export function delayTo(deadline, now) {
  const d = deadline - now;
  return d > 0 ? d : 0;
}
