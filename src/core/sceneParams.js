/**
 * WEED.params: the page's URL parameters, the same on the main thread and in every worker.
 *
 * Inside a worker `location` is the worker script's URL, not the page's, so a scene that reads location.search works on
 * the main thread and silently reads nothing in the workers. loadScene fixes the value before it imports the scene, and
 * the workers' init message carries it before their scripts load, so module-level code can read it too.
 */
let current = new URLSearchParams(typeof document !== 'undefined' ? location.search : '');

/** @returns {URLSearchParams} */
export function sceneParams() {
  return current;
}

/** @param {string|URLSearchParams|Record<string, string>} [query] */
export function setSceneParams(query) {
  current = new URLSearchParams(query ?? '');
}

/** The page's query, on the main thread; '' elsewhere. */
export function pageQuery() {
  return typeof location !== 'undefined' && typeof location.search === 'string' ? location.search : '';
}
