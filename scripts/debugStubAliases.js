/**
 * The production bundles' debug stubs, one list for both webpack configs (CR-8: one listed hotReload and the other
 * hotSwap). Each module the debug build ships and the no-op it is swapped for when WEED_PROD is set. debugFlags has no
 * stub: the real module imports nothing, so a stub saved nothing (and its selected entity started where the debug
 * build's does not).
 */
import path from 'path';

const DEBUG_MODULE_STUBS = [
  'debugDraw.js',
  'debugUi.js',
  'hotReload.js',
  'hotSwap.js',
  'devChecks.js',
];

/**
 * {module: stub}, absolute paths under root, for a production build; {} for a debug one.
 * @param {string} root the repository's folder
 * @param {boolean} isProd
 */
export function debugStubAliases(root, isProd) {
  if (!isProd) return {};
  const out = {};
  for (const name of DEBUG_MODULE_STUBS) {
    out[path.resolve(root, 'src/core/debug', name)] = path.resolve(root, 'src/core/debug/stubs', name);
  }
  // DBG-5: the Pixi worker's render views (their decode shaders).
  out[path.resolve(root, 'src/render/renderViews.js')] = path.resolve(root, 'src/core/debug/stubs/renderViews.js');
  return out;
}
