// Engine chatter gate for workers and bootstrap. Default off — opt in with
// debug.verboseWorkers. A game's own console.log is never touched; console.warn
// / console.error stay for the engine too (capacity contracts, real failures).

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
