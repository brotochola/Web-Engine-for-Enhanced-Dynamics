// N-326: reading a cross-thread wait in a node test against wall-clock times given ahead, not against durations.
// A test that runs a second thread (a publisher, a logic frame end) cannot assume either thread runs on time: under the
// suite's parallel files a thread here waited tens of ms for a core. So the publisher is told the wall-clock time of
// its event ahead, and a try is read against that time.

/** The wall clock in ms, the same on every thread (performance.timeOrigin + performance.now()). */
export const wallMs = () => performance.timeOrigin + performance.now();

/**
 * Whether a try tested what it meant to: the wait began before the event it is meant to wait for (`at`, wall-clock ms;
 * `begun`, taken just before the call that waits) and lasted until it. A wait only gets longer when the machine keeps a
 * thread off a core, never shorter, so `waited` reaching from `begun` to `at` (less 0.5 ms for the work the call does
 * before it waits) holds however late the threads ran. A try where this thread began after the event never waited for
 * it, and is tried again.
 * @param {number} at the event's wall-clock time
 * @param {number} begun the wall-clock time just before the waiting call
 * @param {number} waited the wait the stage counted (WAIT_MS), ms
 */
export function waitedUntil(at, begun, waited) {
  return begun < at && waited >= at - begun - 0.5;
}
