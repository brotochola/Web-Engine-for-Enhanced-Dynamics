/**
 * DX-GUARDS C1: the keys a scene's config may hold. A key the engine never reads does nothing, and a misspelt one
 * (`ligthing`, `renderer.backed`) used to be ignored in silence. The scene now names each one at load, once, with the
 * nearest key it may have meant (Scene._applyConfigDefaults).
 *
 * The schema is built from the defaults (configDefaults.js), so a key with a default is known without being listed
 * here; the lists below are the keys the engine reads that have no default. tests/node/configKeys.test.js checks both
 * ways: every default is known, and every `config.<section>.<key>` the engine's source reads is known.
 *
 * A node is an object of key → true (a value), another node (a section), or ANY (anything below is the game's: a
 * shader's uniforms, the sun's colour table). NAMED in a node means its keys are names the game chooses (layers, audio
 * channels), each checked against the node NAMED points to.
 *
 * Top-level keys the schema does not know are the game's own data (a scene may carry its own settings in config), so
 * only one that looks like a misspelt engine key is named.
 */
import {
  ASSETS_DEFAULTS,
  AUDIO_DEFAULTS,
  BULLET_DEFAULTS,
  DEBUG_DEFAULTS,
  DECORATION_DEFAULTS,
  LAYER_DEFAULTS,
  LIGHTING_DEFAULTS,
  LOGIC_DEFAULTS,
  NAVIGATION_DEFAULTS,
  PARTICLE_DEFAULTS,
  PHYSICS_DEFAULTS,
  PRE_RENDER_DEFAULTS,
  RENDERER_DEFAULTS,
  SCENE_DEFAULTS,
  SPATIAL_DEFAULTS,
  SUN_DEFAULTS,
  TWEEN_DEFAULTS,
} from './configDefaults.js';

export const ANY = 'any';
export const NAMED = '*';

function keys(...sources) {
  const node = {};
  for (const src of sources) {
    for (const k of Array.isArray(src) ? src : Object.keys(src)) node[k] = true;
  }
  return node;
}

const XY = keys(['x', 'y']);
const COMPRESSOR = keys(['threshold', 'ratio', 'attack', 'release']);

/** A layer's own keys (config.layers.<name>); its shader block is the shader's. Keys from `_` on are the engine's. */
const LAYER = {
  ...keys(LAYER_DEFAULTS, [
    'zIndex', 'kind', 'maxItems', 'alphaBySun', 'dynamicResolution', 'margin', 'parallax', 'zoomParallax', 'pixelSnap',
    'resource', 'scale', 'sortWithEntities', 'sunProjected', 'volumeFloor', 'texture', 'textureId', 'tileScale',
    'tilemap', 'maxParticles', 'gpuRings',
  ]),
  shader: ANY,
};

export const SCENE_CONFIG_SCHEMA = Object.freeze({
  ...keys(SCENE_DEFAULTS, ['canvasWidth', 'canvasHeight']),
  gravity: XY,
  physics: {
    ...keys(PHYSICS_DEFAULTS, ['publishContactRing', 'box2dWorkerCount']),
    gravity: XY,
    liquidFun: keys(PHYSICS_DEFAULTS.liquidFun),
  },
  spatial: keys(SPATIAL_DEFAULTS),
  // The kernel switches have their own warning (Scene._applyConfigDefaults).
  wasm: ANY,
  particle: keys(PARTICLE_DEFAULTS, ['deriveSpeed', 'decalsTilePixelSize']),
  decoration: keys(DECORATION_DEFAULTS),
  bullet: keys(BULLET_DEFAULTS),
  tween: keys(TWEEN_DEFAULTS),
  audio: {
    ...keys(AUDIO_DEFAULTS),
    compressor: COMPRESSOR,
    channels: { [NAMED]: { ...keys(['volume', 'pan', 'maxVoices']), compressor: COMPRESSOR } },
  },
  assets: keys(ASSETS_DEFAULTS),
  logic: keys(LOGIC_DEFAULTS, ['tickBuckets']),
  renderer: keys(RENDERER_DEFAULTS),
  preRender: keys(PRE_RENDER_DEFAULTS),
  lighting: {
    ...keys(LIGHTING_DEFAULTS),
    faces: keys(LIGHTING_DEFAULTS.faces, ['gain', 'heightScaleY', 'sunDirect', 'wrap']),
    particleLights: keys(LIGHTING_DEFAULTS.particleLights),
    sun: {
      ...keys(SUN_DEFAULTS),
      dayCycle: keys(SUN_DEFAULTS.dayCycle),
      night: keys(SUN_DEFAULTS.night),
      colors: ANY,
    },
  },
  navigation: keys(NAVIGATION_DEFAULTS),
  debug: keys(DEBUG_DEFAULTS),
  layers: { [NAMED]: LAYER },
});

/** Keys the engine read once and no longer does: path → why. */
export const RETIRED_CONFIG_KEYS = Object.freeze({
  'renderer.tilemapCull': 'tilemaps upload once, there is no chunk stream',
  'preRender.numberOfPreRenderWorkers': 'there is one pre-render worker',
});

/** Optimal string alignment distance, letters compared without case. */
export function keyDistance(a, b) {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const m = s.length;
  const n = t.length;
  const d = [];
  for (let i = 0; i <= m; i++) d.push(new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
      d[i][j] = v;
    }
  }
  return d[m][n];
}

/** The closest of `candidates` to `key`, if it is close enough to be a misspelling of it; else null. */
export function nearestKey(key, candidates) {
  const limit = key.length <= 4 ? 1 : key.length <= 8 ? 2 : 3;
  let best = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const dist = keyDistance(key, c);
    if (dist < bestD) {
      bestD = dist;
      best = c;
    }
  }
  return bestD <= limit ? best : null;
}

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v);

/** Where else `key` is a key: `decoration.maxDecorations` for a `maxDecorations` put under `particle`. */
function elsewhere(key, here) {
  for (const [section, node] of Object.entries(SCENE_CONFIG_SCHEMA)) {
    if (section === here || !plain(node)) continue;
    if (node[key] === true) return `${section}.${key}`;
  }
  return null;
}

function walk(value, node, path, section, out) {
  for (const key of Object.keys(value)) {
    if (key.startsWith('_')) continue;
    const at = path ? `${path}.${key}` : key;
    if (Object.hasOwn(RETIRED_CONFIG_KEYS, at)) {
      out.push({ path: at, retired: RETIRED_CONFIG_KEYS[at] });
      continue;
    }
    const child = Object.hasOwn(node, key) ? node[key] : node[NAMED];
    if (child === undefined) {
      const known = Object.keys(node);
      out.push({ path: at, nearest: nearestKey(key, known), elsewhere: elsewhere(key, section), known });
      continue;
    }
    if (child === ANY || child === true || !plain(value[key])) continue;
    walk(value[key], child, at, section, out);
  }
}

/**
 * The keys of a scene's own config (before the defaults) that the engine does not read.
 * @param {object} config
 * @returns {{ path: string, nearest?: string|null, elsewhere?: string|null, retired?: string, known?: string[] }[]}
 */
export function unknownConfigKeys(config) {
  const out = [];
  if (!plain(config)) return out;
  const top = Object.keys(SCENE_CONFIG_SCHEMA);
  for (const key of Object.keys(config)) {
    const node = SCENE_CONFIG_SCHEMA[key];
    if (node === undefined) {
      // The game's own data, unless it looks like a misspelt engine key.
      const nearest = nearestKey(key, top);
      if (nearest) out.push({ path: key, nearest, elsewhere: null, known: top });
      continue;
    }
    if (node === ANY || node === true || !plain(config[key])) continue;
    walk(config[key], node, key, key, out);
  }
  return out;
}

/** The warning's line for one unknown key, without `WeedJS: `. */
export function unknownConfigKeyText(sceneName, item) {
  const where = `${sceneName}.config.${item.path}`;
  if (item.retired) return `${where} does nothing any more (${item.retired}). Remove it.`;
  const parent = item.path.includes('.') ? item.path.slice(0, item.path.lastIndexOf('.')) : '';
  if (item.nearest) {
    return `${where} is not a config key, so it does nothing. Did you mean ${parent ? `${parent}.` : ''}${item.nearest}?`;
  }
  if (item.elsewhere) return `${where} is not a config key there, so it does nothing; ${item.elsewhere} is.`;
  const list = item.known.length > 12 ? `${item.known.slice(0, 12).join(', ')}, …` : item.known.join(', ');
  return `${where} is not a config key, so it does nothing. The keys of ${parent || 'config'}: ${list}.`;
}
