/**
 * DX-GUARDS: a mistake a game makes, said once per subject (a class, a scene, a key path) and rule. The text says
 * what is wrong, where, and how to fix it, in one line; `WeedJS: ` goes in front.
 */
const said = new Set();

/**
 * @param {string} subject what the mistake is in: a class name, a scene name, a key path
 * @param {string} rule which guard says it
 * @param {string} text the line, without the `WeedJS: ` prefix
 * @returns {boolean} true when it was said now, false when it had been said already
 */
export function warnOnce(subject, rule, text) {
  const key = `${subject}\u0000${rule}`;
  if (said.has(key)) return false;
  said.add(key);
  console.warn(`WeedJS: ${text}`);
  return true;
}

/** Forget what was said (tests; a scene loaded again warns again). */
export function resetWarnOnce() {
  said.clear();
}
