// exportRuntime.js — bundled into an exported game's game.min.js by server/exportGame.js (VISUAL_EDITOR_PLAN.md
// ED-32). Browser code: it runs where game.min.js runs, on the page and in each engine worker (which evaluates the
// file to find the scene's entity classes). It imports nothing: the engine is the global WEED, as for the rest of
// game.min.js.
//
// On the page, before the game's first loadScene, it puts the export's layout in place:
// - the scene files the export carries are registered at their URLs beside game.min.js (WEED.registerSceneFile), so
//   loadScene, defaultSceneFile and saves find them with no file to fetch;
// - the asset URLs the bundled scene classes declare (static assets, audios, config: layer shaders) point at their
//   copies under assets/;
// - the exported scene class loads the atlas the editor baked (assets.bigAtlas) instead of packing its images.
// In a worker it does nothing: workers read a scene class's entities, never its assets.

/**
 * @param {{ sceneFiles: Record<string, object>, assets: Record<string, string>,
 *   atlas: { scene: string, json: string, png: string } | null }} manifest
 *   sceneFiles: path beside game.min.js → document; assets: URL as the code declares it → path beside game.min.js;
 *   atlas: the scene class it is for, and its files' paths
 * @param {string} gameUrl - game.min.js's URL (import.meta.url)
 * @param {object[]} namespaces - the bundled scene modules' namespaces
 */
export function installExport(manifest, gameUrl, namespaces) {
  if (typeof window === 'undefined') return;
  const engine = globalThis.WEED;
  if (!engine || typeof engine.registerSceneFile !== 'function') {
    throw new Error('game.min.js: load the engine first (vendor/weed.js), one that has WEED.registerSceneFile');
  }
  for (const [file, doc] of Object.entries(manifest.sceneFiles)) engine.registerSceneFile(new URL(file, gameUrl).href, doc);

  const urls = new Map();
  for (const [declared, file] of Object.entries(manifest.assets)) urls.set(declared, new URL(file, gameUrl).href);
  const patched = new Set();
  for (const ns of namespaces) {
    for (const value of Object.values(ns)) {
      for (let C = value; isSceneSubclass(C, engine.Scene) && !patched.has(C); C = Object.getPrototypeOf(C)) {
        patched.add(C);
        for (const key of ['assets', 'audios', 'config']) {
          if (!Object.hasOwn(C, key)) continue;
          const next = withUrls(C[key], urls);
          if (next !== C[key]) C[key] = next;
        }
      }
    }
  }

  const atlas = manifest.atlas;
  if (atlas === null) return;
  for (const C of patched) {
    if (C.name !== atlas.scene) continue;
    C.assets = { ...C.assets, bigAtlas: { json: new URL(atlas.json, gameUrl).href, png: new URL(atlas.png, gameUrl).href } };
  }
}

function isSceneSubclass(C, Scene) {
  return typeof C === 'function' && C !== Scene && C.prototype instanceof Scene;
}

/**
 * The value with every string `urls` maps replaced: through arrays and plain objects, a copy only where something
 * changed (the same object otherwise). Anything else (classes, functions, typed arrays) is kept as it is.
 */
function withUrls(value, urls) {
  if (typeof value === 'string') return urls.has(value) ? urls.get(value) : value;
  if (Array.isArray(value)) {
    let out = value;
    for (let i = 0; i < value.length; i++) {
      const next = withUrls(value[i], urls);
      if (next === value[i]) continue;
      if (out === value) out = value.slice();
      out[i] = next;
    }
    return out;
  }
  if (value === null || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  let out = value;
  for (const key of Object.keys(value)) {
    const next = withUrls(value[key], urls);
    if (next === value[key]) continue;
    if (out === value) out = { ...value };
    out[key] = next;
  }
  return out;
}
