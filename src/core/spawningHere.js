// DX-PARENT, SST-20, E-528: the entities in their spawn on this worker (its config keys, then onSpawned), innermost
// last. GameObject.spawn enters and leaves; a link to one of them waits for its activation, a pose written to its body
// sends physics nothing (the body is made after the spawn, from the columns), and a despawn by index calls the spawn
// off. A module of its own, importing nothing, so the component statics that need it (Transform.setX) reach it
// without importing gameObject.js, and can alias it as a module const (E-474).

const spawning = new Int32Array(32);
/** Per entry: a despawn called that spawn off (E-534: by index, where the flag lived on the instance). */
const aborted = new Uint8Array(32);
let depth = 0;

/**
 * Entity i starts its spawn here. False when the stack is full (32 spawns nested): it is not listed, and the caller
 * does not call leaveSpawnHere for it.
 * @param {number} i
 */
export function enterSpawnHere(i) {
  if (depth >= spawning.length) return false;
  spawning[depth] = i;
  aborted[depth] = 0;
  depth++;
  return true;
}

/** The innermost spawn listed by enterSpawnHere ended (it returned true). */
export function leaveSpawnHere() {
  depth--;
}

/**
 * Whether entity p is in its spawn on this worker.
 * @param {number} p
 */
export function isSpawningHere(p) {
  for (let k = 0; k < depth; k++) if (spawning[k] === p) return true;
  return false;
}

/**
 * A despawn of entity p calls its spawn here off. False when p is not in its spawn here.
 * @param {number} p
 */
export function abortSpawnHere(p) {
  for (let k = depth - 1; k >= 0; k--) {
    if (spawning[k] === p) {
      aborted[k] = 1;
      return true;
    }
  }
  return false;
}

/** Whether the innermost spawn was called off (read by the spawn before it leaves). */
export function innermostSpawnAborted() {
  return depth > 0 && aborted[depth - 1] === 1;
}
