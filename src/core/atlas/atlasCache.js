// SST-6: a packed atlas kept in the browser's Cache Storage, keyed by everything that decides it, so the next load of the
// same scene (the developer reloading, the returning player) loads it as a baked one instead of packing it again. The key
// hashes (SHA-256) the format's version, the engine's version, the code that draws and packs it (in a source build its
// modules' text, in a bundle the hash of the sources it was built from), the scene's atlas assets as declared, the packer's options as they resolve, and each source file's bytes:
// a changed byte, option, built-in or engine misses. An entry is the json, the atlas as a PNG (its 2D canvas's own
// encoding: the pixels getImageData reads, which premultiply back to the canvas's own) and the twin page's texels as they
// are (data: no PNG, no colour space). A load writes its entry after it handed the atlas over, and drops the entries of
// the same atlas under other keys. Works on any thread with `caches` and `crypto.subtle` (the atlas worker, the page).

import { VERSION } from '../../version.js';
import { ASSETS_DEFAULTS } from '../../util/configDefaults.js';
import { loadMark } from '../../util/loadMarks.js';
import { resolvedAssetUrl } from '../../util/fetchAsset.js';

/** The entries' format: bump it when what an entry holds, or how it is read, changes. */
export const ATLAS_CACHE_FORMAT = 1;
/** The Cache Storage cache the entries live in. */
export const ATLAS_CACHE_NAME = 'weedjs-atlas';
/** Where an entry's files are keyed, under the page's origin (Cache Storage keys are URLs; nothing fetches them). */
const ENTRY_PATH = '/__weedjs/atlas-cache';
/* global __WEED_BUILD_INPUTS__ */
/**
 * A bundle's build: the hash of the sources it was built from (scripts/distVersion.js bundleInputsHash), which
 * buildBundle.js hands webpack's DefinePlugin; null in a source build (its key hashes the modules' text instead). A
 * bundle built from changed atlas code under the same engine version gets another key.
 */
const BUNDLE_BUILD = typeof __WEED_BUILD_INPUTS__ === 'string' && __WEED_BUILD_INPUTS__ !== '' ? __WEED_BUILD_INPUTS__ : null;
/**
 * This module's URL in a source build; '' in a webpack build (it defines __WEED_BUILD_INPUTS__), whose modules are not
 * files. N-251: webpack wrote a bare import.meta.url as the builder's own file:// path, so every bundle carried the
 * folder it was built in (a worktree's bundle never matched the main folder's) and published it. The test folds at
 * build time, so the bundle holds no import.meta.url.
 */
const MODULE_URL = typeof __WEED_BUILD_INPUTS__ === 'string' ? '' : import.meta.url;

/**
 * The modules whose code decides a packed atlas's pixels and json, relative to this one: in a source build the key holds
 * their text's hash. A bundle's key holds its build's hash (BUNDLE_BUILD).
 */
export const ATLAS_CODE_MODULES = Object.freeze([
  './atlasBuild.js',
  './atlasBuiltins.js',
  './maxRectsPacker.js',
  './canvas2d.js',
  './atlasFrames.js',
  './atlasCache.js',
  '../../render/spriteMaps.js',
  '../../render/frameBase.js',
  '../../render/mapsTable.js',
  '../../util/utils.js',
]);

/** Fields of a spritesheet config that name files the atlas reads. */
const SHEET_FILES = ['json', 'png', 'normalMap'];
/** Fields that are a file or an object with a `png` file (DX-MAPS heightMap, DX-RELIEF reliefMap). */
const SHEET_PNG_FILES = ['heightMap', 'reliefMap'];

/**
 * An atlas's assets with every file URL resolved (against the page, or the worker's script for a URL that already is
 * absolute: no change), the rest as it is: what the atlas worker gets, and what a key names, wherever it is made.
 * @param {object} assets images by name, plus { spritesheets }
 * @param {(url: string) => string} [resolve]
 */
export function resolveAssetUrls(assets, resolve = resolvedAssetUrl) {
  const out = {};
  for (const [name, value] of Object.entries(assets || {})) {
    if (name === 'spritesheets') continue;
    out[name] = typeof value === 'string' ? resolve(value) : value;
  }
  if (assets && 'spritesheets' in assets) {
    out.spritesheets = {};
    for (const [name, config] of Object.entries(assets.spritesheets || {})) {
      const c = { ...config };
      for (const k of SHEET_FILES) if (typeof c[k] === 'string') c[k] = resolve(c[k]);
      for (const k of SHEET_PNG_FILES) {
        if (typeof c[k] === 'string') c[k] = resolve(c[k]);
        else if (c[k] && typeof c[k] === 'object' && typeof c[k].png === 'string') c[k] = { ...c[k], png: resolve(c[k].png) };
      }
      out.spritesheets[name] = c;
    }
  }
  return out;
}

/**
 * Lowercase hex SHA-256 of bytes or a string.
 * @param {ArrayBuffer | ArrayBufferView | string} data
 */
export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (let i = 0; i < digest.length; i++) hex += digest[i].toString(16).padStart(2, '0');
  return hex;
}

/**
 * The files an atlas's assets read, sorted and each once; null when one of its sheets comes decoded (an Adobe Animate
 * sheet's image and json: no file to hash), which the cache then leaves alone.
 * @param {object} assets images by name, plus { spritesheets }
 * @returns {string[] | null}
 */
export function atlasCacheSources(assets) {
  const urls = new Set();
  for (const [name, value] of Object.entries(assets || {})) {
    if (name === 'spritesheets') continue;
    if (typeof value === 'string') urls.add(value);
  }
  for (const config of Object.values(assets?.spritesheets || {})) {
    if (!config || config.img || config.jsonData) return null;
    for (const k of SHEET_FILES) if (typeof config[k] === 'string') urls.add(config[k]);
    for (const k of SHEET_PNG_FILES) {
      const v = config[k];
      if (typeof v === 'string') urls.add(v);
      else if (v && typeof v.png === 'string') urls.add(v.png);
    }
  }
  return [...urls].sort();
}

/**
 * The packer's options as they decide the atlas, every default resolved (atlasBuild.js buildBigAtlas's), the built-ins'
 * unshaded marks, the scene camera's heightScaleY.
 * @param {object} options buildBigAtlas's options
 * @param {Array<{ name: string, unshaded?: boolean }>} builtins
 */
export function atlasCacheOptions(options = {}, builtins = []) {
  const pick = (k) => (options[k] !== undefined ? options[k] : ASSETS_DEFAULTS[k]);
  const h = Number(options.sceneHeightScaleY);
  return {
    maxAtlasWidth: pick('maxAtlasWidth'),
    maxAtlasHeight: pick('maxAtlasHeight'),
    atlasPadding: pick('atlasPadding'),
    trimImages: pick('trimImages'),
    trimAlphaThreshold: pick('trimAlphaThreshold'),
    heuristic: pick('heuristic'),
    twinFormat: pick('twinFormat'),
    sceneHeightScaleY: Number.isFinite(h) ? h : null,
    builtins: builtins.map((b) => [b.name, b.unshaded === true]),
  };
}

/**
 * The text a key hashes: canonical JSON of what decides the atlas.
 * @param {{ assets: object, options: object, builtins: Array<{ name: string, unshaded?: boolean }>,
 *   sources: Array<[string, string]>, version: string, code: string | null }} parts sources: [url, bytes' hash] sorted by url
 */
export function atlasCacheKeyText({ assets, options, builtins, sources, version, code }) {
  return JSON.stringify({
    format: ATLAS_CACHE_FORMAT,
    version,
    code,
    assets,
    options: atlasCacheOptions(options, builtins),
    sources,
  });
}

/**
 * The hash of a source build's atlas code (ATLAS_CODE_MODULES' text), or null where the modules are not files (a bundle).
 * @param {string} base this module's URL (import.meta.url; '' in a bundle)
 * @param {(url: string) => Promise<Response>} [fetchFn]
 */
export async function atlasCodeHash(base = MODULE_URL, fetchFn = (u) => fetch(u)) {
  if (!/^(https?|file):/.test(String(base))) return null;
  const texts = await Promise.all(ATLAS_CODE_MODULES.map(async (rel) => {
    const response = await fetchFn(new URL(rel, base).href);
    if (!response.ok) throw new Error(`atlas cache: ${rel} answered HTTP ${response.status}`);
    return response.text();
  }));
  return sha256Hex(texts.join('\u0000'));
}

/**
 * Fetch every source of an atlas and hash its bytes.
 * @param {string[]} urls atlasCacheSources's
 * @param {(url: string) => Promise<Response>} [fetchFn]
 * @returns {Promise<Array<[string, string]>>} [url, hash] in urls's order
 */
export async function hashAtlasSources(urls, fetchFn = (u) => fetch(u)) {
  return Promise.all(urls.map(async (url) => {
    const response = await fetchFn(url);
    if (!response.ok) throw new Error(`atlas cache: ${url} answered HTTP ${response.status}`);
    return [url, await sha256Hex(await response.arrayBuffer())];
  }));
}

/** The URLs an entry's files are keyed by: its atlas's slot (its sources' identity) and its key. */
function entryUrls(origin, slot, key) {
  const dir = `${origin}${ENTRY_PATH}/${slot}/${key}`;
  return { json: `${dir}/atlas.json`, png: `${dir}/atlas.png`, maps: `${dir}/maps.rgba` };
}

/**
 * The slot of an atlas: which scene's atlas an entry is (its sources' URLs and its assets' names), whatever their bytes,
 * so a new entry replaces the old ones of the same atlas.
 * @param {object} assets
 */
export async function atlasCacheSlot(assets) {
  return (await sha256Hex(JSON.stringify([Object.keys(assets || {}), Object.keys(assets?.spritesheets || {}), atlasCacheSources(assets)]))).slice(0, 24);
}

/**
 * An entry, or null.
 * @param {CacheStorage} storage
 * @param {string} origin
 * @param {string} slot
 * @param {string} key
 * @returns {Promise<{ json: object, png: Blob, maps: Uint8ClampedArray | null } | null>}
 */
export async function readAtlasCache(storage, origin, slot, key) {
  const cache = await storage.open(ATLAS_CACHE_NAME);
  const urls = entryUrls(origin, slot, key);
  const [jsonResponse, pngResponse, mapsResponse] = await Promise.all([
    cache.match(urls.json), cache.match(urls.png), cache.match(urls.maps),
  ]);
  if (!jsonResponse || !pngResponse) return null;
  const json = await jsonResponse.json();
  if (json?.meta?.mapsSize && !mapsResponse) return null;
  const [png, maps] = await Promise.all([pngResponse.blob(), mapsResponse ? mapsResponse.arrayBuffer() : null]);
  return { json, png, maps: maps ? new Uint8ClampedArray(maps) : null };
}

/**
 * SST-16: the entry an atlas's slot holds, whatever its key, or null. An atlas has one entry (writeAtlasCache drops the
 * slot's others once it has written its own), so the page can decode it while the key is computed and keep it only when
 * the keys match. Two entries (a write cut short before its clean-up): no guess.
 * @param {CacheStorage} storage
 * @param {string} origin
 * @param {string} slot
 * @returns {Promise<{ key: string, hit: { json: object, png: Blob, maps: Uint8ClampedArray | null } } | null>}
 */
export async function readAtlasCacheSlot(storage, origin, slot) {
  const cache = await storage.open(ATLAS_CACHE_NAME);
  const prefix = `${origin}${ENTRY_PATH}/${slot}/`;
  const suffix = '/atlas.json';
  let key = null;
  for (const request of await cache.keys()) {
    const url = typeof request === 'string' ? request : request.url;
    if (!url.startsWith(prefix) || !url.endsWith(suffix)) continue;
    if (key !== null) return null;
    key = url.slice(prefix.length, url.length - suffix.length);
  }
  if (key === null) return null;
  const hit = await readAtlasCache(storage, origin, slot, key);
  return hit ? { key, hit } : null;
}

/**
 * SST-16: the slot of a scene's atlas as atlasCacheKey computes it (its resolved assets), or null when the cache leaves
 * the atlas alone (no source files, a decoded sheet).
 * @param {object} given the scene's assets
 * @returns {Promise<string | null>}
 */
export async function atlasCacheSlotOf(given) {
  const assets = resolveAssetUrls(given);
  const urls = atlasCacheSources(assets);
  if (urls === null || urls.length === 0) return null;
  return atlasCacheSlot(assets);
}

/**
 * Write an entry, then drop the entries of the same slot under other keys.
 * @param {CacheStorage} storage
 * @param {string} origin
 * @param {string} slot
 * @param {string} key
 * @param {{ json: object, png: Blob, maps: Uint8ClampedArray | null }} entry
 */
export async function writeAtlasCache(storage, origin, slot, key, entry) {
  const cache = await storage.open(ATLAS_CACHE_NAME);
  const urls = entryUrls(origin, slot, key);
  // The json last: an entry is read only when its json is there, so a write cut short is a miss, not half an atlas.
  if (entry.maps) await cache.put(urls.maps, new Response(entry.maps, { headers: { 'content-type': 'application/octet-stream' } }));
  await cache.put(urls.png, new Response(entry.png, { headers: { 'content-type': 'image/png' } }));
  await cache.put(urls.json, new Response(JSON.stringify(entry.json), { headers: { 'content-type': 'application/json' } }));
  const prefix = `${origin}${ENTRY_PATH}/${slot}/`;
  const mine = `${prefix}${key}/`;
  for (const request of await cache.keys()) {
    const url = typeof request === 'string' ? request : request.url;
    if (url.startsWith(prefix) && !url.startsWith(mine)) await cache.delete(request);
  }
}

/**
 * The cache this thread can use, or null: Cache Storage and crypto.subtle (a secure context: https, or localhost).
 * @returns {{ storage: CacheStorage, origin: string } | null}
 */
export function atlasCacheHere() {
  try {
    const storage = globalThis.caches;
    const origin = globalThis.location?.origin;
    if (!storage || typeof storage.open !== 'function' || !globalThis.crypto?.subtle || !origin || origin === 'null') return null;
    return { storage, origin };
  } catch {
    return null;
  }
}

/**
 * The key and slot of an atlas, or null when the cache leaves it alone (a decoded sheet, no source files, no cache here).
 * @param {{ assets: object, options: object, builtins: Array<{ name: string, unshaded?: boolean }>, bundle: boolean,
 *   version?: string, fetchFn?: (url: string) => Promise<Response>, codeBase?: string }} p
 * @returns {Promise<{ key: string, slot: string } | null>}
 */
export async function atlasCacheKey({ assets: given, options, builtins, bundle, version = VERSION, fetchFn, codeBase }) {
  const assets = resolveAssetUrls(given);
  const urls = atlasCacheSources(assets);
  if (urls === null || urls.length === 0) return null;
  const [sources, code, slot] = await Promise.all([
    hashAtlasSources(urls, fetchFn),
    bundle ? BUNDLE_BUILD : atlasCodeHash(codeBase, fetchFn),
    atlasCacheSlot(assets),
  ]);
  const key = await sha256Hex(atlasCacheKeyText({ assets, options, builtins, sources, version, code }));
  loadMark('atlas cache key');
  return { key, slot };
}
