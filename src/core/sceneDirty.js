// sceneDirty.js — whether the running scene changed something a fast swap cannot put back (VISUAL_EDITOR_PLAN.md
// ED-35, D3). The fast swap clears the world and resets the scene-wide state it has a path for; a change with no
// such path marks the scene dirty, and the next loadScene of the same scene class is then a full load, which
// starts from fresh workers and buffers. Page only: the APIs that mark it run on the main thread. A new scene
// (a full load) starts clean.

let reason = null;

/** @param {string} why - what changed, for the full load's console line */
export function markSceneDirty(why) {
  if (reason === null) reason = why;
}

/** @returns {string|null} what made the scene dirty first, or null */
export function sceneDirtyReason() {
  return reason;
}

export function clearSceneDirty() {
  reason = null;
}
