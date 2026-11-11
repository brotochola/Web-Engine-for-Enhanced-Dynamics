/**
 * DX-GUARDS C8: a scene config that works as written and still shows what the game did not mean. Checked once at
 * load (main thread, both builds), from the scene's own config (before the defaults).
 */
import { LIGHTING_DEFAULTS } from './configDefaults.js';

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
