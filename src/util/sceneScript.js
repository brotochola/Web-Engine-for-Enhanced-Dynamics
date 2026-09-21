// Scene module URL + worker class bind.
// Workers import() one scene file; ESM loads the entity graph.
// Optional per-class scriptUrl is leftover / blob escape hatch.

export function toAbsoluteScriptUrl(path, origin = '') {
  if (!path) return path;
  if (path.startsWith('blob:')) return path;
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  if (path.startsWith('/')) return origin ? `${origin}${path}` : path;
  try {
    return new URL(path, origin || 'http://localhost').href;
  } catch {
    return path;
  }
}

export function isSceneClass(value, SceneBase) {
  return (
    typeof value === 'function' &&
    value.prototype &&
    (value === SceneBase || value.prototype instanceof SceneBase)
  );
}

/**
 * Pick the Scene export from a module namespace.
 * @param {string} [exportName]
 */
export function pickSceneClass(ns, exportName, SceneBase) {
  if (!ns || typeof ns !== 'object') {
    throw new TypeError('pickSceneClass: module namespace required');
  }
  if (exportName) {
    const named = ns[exportName];
    if (typeof named !== 'function') {
      throw new Error(`Scene export "${exportName}" not found`);
    }
    return named;
  }
  if (SceneBase && ns.default && isSceneClass(ns.default, SceneBase)) {
    return ns.default;
  }
  const scenes = Object.values(ns).filter((value) =>
    SceneBase ? isSceneClass(value, SceneBase) : typeof value === 'function',
  );
  const unique = SceneBase
    ? scenes
    : scenes.filter((value) => typeof value === 'function' && /Scene$/.test(value.name || ''));
  const list = SceneBase ? scenes : unique.length ? unique : scenes;
  if (list.length === 1) return list[0];
  if (list.length === 0) {
    throw new Error('Scene module has no Scene export');
  }
  const names = list.map((value) => value.name || '(anonymous)').join(', ');
  throw new Error(`Scene module exports multiple Scene classes (${names}); pass { export: 'Name' }`);
}

/**
 * Hang entity / parent / SharedResource classes on globalRef.
 * Scene module export is the Scene class only — Bunny lives on static.entities.
 */
export function bindSceneGraph(SceneClass, globalRef, GameObject, SharedResource) {
  const seen = new Set();
  function expose(C) {
    if (!C || typeof C !== 'function' || seen.has(C)) return;
    if (C === GameObject || C === SharedResource) return;
    seen.add(C);
    if (C.name) globalRef[C.name] = C;
    const parent = Object.getPrototypeOf(C);
    if (
      parent &&
      parent !== GameObject &&
      parent !== SharedResource &&
      parent !== Function.prototype
    ) {
      expose(parent);
    }
  }
  const entities = SceneClass.entities || [];
  for (let i = 0; i < entities.length; i++) {
    expose(entities[i][0]);
  }
  const resources = SceneClass.sharedResources || [];
  for (let i = 0; i < resources.length; i++) {
    expose(resources[i][0]);
  }
  return seen;
}

export function missingWorkerEntityClasses(registeredClasses, globalRef) {
  const missing = [];
  for (let i = 0; i < (registeredClasses || []).length; i++) {
    const rec = registeredClasses[i];
    if (rec.engineProvided) continue;
    if (!globalRef[rec.name]) missing.push(rec.name);
  }
  return missing;
}

export function collectSceneWorkerScriptUrls(registeredClasses, origin = '') {
  // Module workers import() this list as entries. Auto-registered parents
  // (count 0) first poisons cyclic ESM (Lootable → Drop → MySoldier → Person).
  // Pooled types first; parent scripts load later as cache hits onto self.
  // Blob workers ignore this order (expandBlobEntityScripts DFS).
  const ordered = (registeredClasses || []).slice().sort((a, b) => {
    const ac = a.count > 0 ? 1 : 0;
    const bc = b.count > 0 ? 1 : 0;
    return bc - ac;
  });
  return [
    ...new Set(
      ordered
        .map((r) => r.scriptPath)
        .filter((path) => path !== null && path !== undefined)
        .map((path) => toAbsoluteScriptUrl(path, origin)),
    ),
  ];
}

export function collectSharedResourceScriptUrls(regs, origin = '') {
  return [
    ...new Set(
      (regs || [])
        .map((r) => r.scriptUrl)
        .filter((url) => url)
        .map((url) => toAbsoluteScriptUrl(url, origin)),
    ),
  ];
}

/**
 * Scene URL first. Leftover per-class scriptUrl only when set (blob / not in graph).
 */
export function collectWorkerScriptsToLoad(scene, origin = '') {
  const sceneUrl = scene.sceneScriptUrl
    ? toAbsoluteScriptUrl(scene.sceneScriptUrl, origin)
    : null;
  if (sceneUrl) {
    const extras = [];
    const classes = scene.registeredClasses || [];
    for (let i = 0; i < classes.length; i++) {
      const path = classes[i].scriptPath;
      if (!path) continue;
      const abs = toAbsoluteScriptUrl(path, origin);
      if (abs !== sceneUrl) extras.push(abs);
    }
    const regs = scene.sharedResourceRegs || [];
    for (let i = 0; i < regs.length; i++) {
      if (!regs[i].scriptUrl) continue;
      const abs = toAbsoluteScriptUrl(regs[i].scriptUrl, origin);
      if (abs !== sceneUrl) extras.push(abs);
    }
    return [...new Set([sceneUrl, ...extras])];
  }
  return [
    ...collectSceneWorkerScriptUrls(scene.registeredClasses, origin),
    ...collectSharedResourceScriptUrls(scene.sharedResourceRegs, origin),
  ];
}

function classDeclarationRe(className) {
  return new RegExp(`(?:export\\s+(?:default\\s+)?class|class)\\s+${className}\\b`);
}

function isCandidateModuleUrl(url, origin) {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith('blob:')) return true;
  if (!/\.m?js(\?|#|$)/i.test(url)) return false;
  if (origin && (url.startsWith('http://') || url.startsWith('https://')) && !url.startsWith(origin)) {
    return false;
  }
  return true;
}

/**
 * Find the file that declared SceneClass by scanning already-loaded JS.
 * @param {Function} SceneClass
 * @param {{ fetch?: typeof fetch, getEntries?: () => { name: string }[], origin?: string }} [opts]
 */
export async function inferSceneScriptUrl(SceneClass, opts = {}) {
  const name = SceneClass && SceneClass.name;
  if (!name) return null;
  const origin =
    opts.origin ?? (typeof location !== 'undefined' ? location.origin : '');
  const getEntries =
    opts.getEntries ||
    (() =>
      typeof performance !== 'undefined' && performance.getEntriesByType
        ? performance.getEntriesByType('resource')
        : []);
  const fetchFn = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!fetchFn) return null;

  const urls = [];
  const seen = new Set();
  const entries = getEntries() || [];
  for (let i = 0; i < entries.length; i++) {
    const url = entries[i] && entries[i].name;
    if (!isCandidateModuleUrl(url, origin) || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }

  const re = classDeclarationRe(name);
  const matches = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const response = await fetchFn(url);
      if (!response || !response.ok) continue;
      const text = await response.text();
      if (re.test(text)) matches.push(url);
    } catch {
      /* skip */
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const lower = name.toLowerCase();
    const preferred = matches.filter((url) => url.toLowerCase().includes(lower));
    if (preferred.length === 1) return preferred[0];
  }
  return null;
}

export function ensureResourceTimingBuffer() {
  if (typeof performance !== 'undefined' && typeof performance.setResourceTimingBufferSize === 'function') {
    performance.setResourceTimingBufferSize(10000);
  }
}
