/**
 * DX-GUARDS C8, C9: a scene config that works as written and still shows what the game did not mean. Checked once at
 * load (main thread, both builds), from the scene's own config (before the defaults).
 */
import { LIGHTING_DEFAULTS, SCENE_DEFAULTS } from './configDefaults.js';

/**
 * C8: lighting on with the default ambient and no sun. What no light reaches is drawn at 5 % of its colour.
 * @param {string} sceneName
 * @param {object} userConfig the scene's static config
 * @returns {string|null} the warning's line, or null
 */
export function darkLightingText(sceneName, userConfig) {
  const lighting = userConfig?.lighting;
  if (!lighting || lighting.enabled !== true || lighting.baseAmbient != null) return null;
  if (lighting.sun?.enabled === true) return null;
  return `${sceneName} turns lighting on with the default baseAmbient (${LIGHTING_DEFAULTS.baseAmbient}) and no sun, so ` +
    'what no light reaches is drawn almost black. Set lighting.baseAmbient (0 to 1), or lighting.sun: { enabled: true }.';
}

/**
 * C9: no world size, and the default world (1000 × 1000) is smaller than the canvas: the camera cannot zoom out past
 * canvas / world, so the view starts zoomed in.
 * @param {string} sceneName
 * @param {object} userConfig the scene's static config
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @returns {string|null}
 */
export function smallWorldText(sceneName, userConfig, canvasWidth, canvasHeight) {
  const w = SCENE_DEFAULTS.worldWidth;
  const h = SCENE_DEFAULTS.worldHeight;
  const unsetW = userConfig?.worldWidth == null && canvasWidth > w;
  const unsetH = userConfig?.worldHeight == null && canvasHeight > h;
  if (!unsetW && !unsetH) return null;
  const minZoom = Math.max(unsetW ? canvasWidth / w : 0, unsetH ? canvasHeight / h : 0);
  const keys = unsetW && unsetH ? 'worldWidth and worldHeight' : unsetW ? 'worldWidth' : 'worldHeight';
  return `${sceneName} sets no ${keys}, so the world is the default ${w} × ${h}, smaller than the ` +
    `${canvasWidth} × ${canvasHeight} canvas: the camera cannot zoom out past ${+minZoom.toFixed(2)}. Set config.${keys} ` +
    'to the size of the world.';
}
