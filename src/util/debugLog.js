// Worker / bootstrap console.log gate. Default off — opt in with debug.verboseWorkers.
// console.warn / console.error stay (capacity contracts, real failures).

let verboseWorkers = false;

export function setVerboseWorkers(on) {
  verboseWorkers = !!on;
}

export function isVerboseWorkers() {
  return verboseWorkers;
}

export function debugWorkerLog(...args) {
  if (verboseWorkers) console.log(...args);
}

/** Mute console.log in this realm when verboseWorkers is off. */
export function installQuietConsoleLog() {
  if (verboseWorkers) return;
  if (typeof console === 'undefined') return;
  console.log = quietLog;
}

function quietLog() {}
