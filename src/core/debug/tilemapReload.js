// tilemapReload.js — a Tiled tilemap loaded again in place (VISUAL_EDITOR_PLAN.md ED-26; debug builds only). Hot
// reload (hotReload.js) calls it when the dev server says a tilemap's file changed, and the editor's Assets dock
// (editor/tilemapList.js) from its button. Painting stays in Tiled.
//
// A tilemap's tiles live in one SharedArrayBuffer that every thread reads (tileMap.js). When the new file has the
// same shape (size in tiles, tile size, the same tile layers in the same order, the same tilesets, each layer's
// visibility and opacity as before: the workers keep their own copy of those), its tiles are written into that
// memory, so every worker's tile queries see them at once, and the layers configured to show the map are posted again
// (Layer.applyConfiguredContent(id)): the renderer packs its GID pages anew from the same memory, through the message
// it already takes. No page reload and no swap: the editor keeps its document, undo and selection, and no worker's
// frame loop changes.
//
// What cannot go in place says why: another shape, or a layer showing a tilemap the scene set at runtime (its
// configuration does not say what that layer shows); the caller then reloads the page (hot reload) or reports it (the
// Assets dock). A file that does not load (Tiled half done writing it) fails, and the scene runs on.
//
// What the scene built from the tiles at load (decorations on grass tiles, a nav grid) is not built again here: the
// next load of the level does it, since a fast swap keeps the new tiles and runs preload and create again.

import { TileMap } from '../tileMap.js';
import { Layer } from '../layer.js';
import { LAYER_KIND } from '../../util/configDefaults.js';

/** A scene asset's URL as the page fetches it, without query or hash. */
function absolute(url) {
  const base = typeof location !== 'undefined' ? location.href || `${location.origin}/` : 'http://localhost/';
  return new URL(url, base).href.split(/[?#]/)[0];
}

/** The layers TileMap keeps of a Tiled map: tile layers with data (TileMap.initializeFromLoaded's rule). */
function tileLayersOf(data) {
  return data.layers.filter((layer) => layer && layer.type === 'tilelayer' && layer.data && layer.data.length > 0);
}

/**
 * The names of the layers configured to show tilemap `id` (config.layers `{ kind: 'tilemap', tilemap: id }`).
 * @param {string} id
 * @returns {string[]}
 */
export function layersShowing(id) {
  const names = [];
  for (const layer of Layer.getAll()) if (layer.kind === LAYER_KIND.TILEMAP && layer._content?.tilemap === id) names.push(layer.name);
  return names;
}

/**
 * The tilemaps the running scene declares (assets.tilemaps), in order: id, the Tiled file's and the tileset's URLs,
 * the loaded TileMap (null when it did not load), and the layers that show it.
 * @param {object|null} scene
 * @returns {{ id: string, json: string|null, png: string|null, tilemap: TileMap|null, shownBy: string[] }[]}
 */
export function sceneTilemaps(scene) {
  const declared = scene?.imageUrls?.tilemaps;
  if (!declared || typeof declared !== 'object') return [];
  const maps = [];
  for (const id of Object.keys(declared)) {
    const entry = declared[id] || {};
    maps.push({
      id,
      json: typeof entry.json === 'string' ? absolute(entry.json) : null,
      png: typeof entry.png === 'string' ? absolute(entry.png) : null,
      tilemap: TileMap.get(id),
      shownBy: layersShowing(id),
    });
  }
  return maps;
}

/**
 * The running scene's tilemap whose Tiled file is `url`, or null.
 * @param {object|null} scene
 * @param {string} url - absolute; a query or hash is ignored
 * @returns {string|null} the tilemap's id
 */
export function tilemapOfFile(scene, url) {
  const file = url.split(/[?#]/)[0];
  for (const map of sceneTilemaps(scene)) if (map.json === file) return map.id;
  return null;
}

/**
 * Why the Tiled map `data` cannot go into `tilemap`'s memory in place, or null when it can.
 * @param {TileMap} tilemap
 * @param {object} data - the parsed file
 * @returns {string|null}
 */
export function tilemapShapeChange(tilemap, data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.layers)) return 'it is not a Tiled map';
  if (data.width !== tilemap.mapWidth || data.height !== tilemap.mapHeight) {
    return `its size changed (${tilemap.mapWidth}×${tilemap.mapHeight} tiles, now ${data.width}×${data.height})`;
  }
  if (data.tilewidth !== tilemap.tileWidth || data.tileheight !== tilemap.tileHeight) return 'its tile size changed';
  const layers = tileLayersOf(data);
  const names = tilemap.getLayerNames();
  if (layers.length !== names.length || layers.some((layer, k) => layer.name !== names[k])) {
    return 'its tile layers changed (added, removed, renamed or moved)';
  }
  const tiles = tilemap.mapWidth * tilemap.mapHeight;
  const current = tilemap.getLayers();
  for (let k = 0; k < layers.length; k++) {
    const layer = layers[k];
    if (!Array.isArray(layer.data) || layer.data.length !== tiles) {
      return `layer ${layer.name} does not hold ${tiles} tile ids (save tile layers as CSV)`;
    }
    if ((layer.visible !== false) !== current[k].visible) return `layer ${layer.name} was shown or hidden`;
    if ((layer.opacity !== undefined ? layer.opacity : 1) !== current[k].opacity) return `layer ${layer.name}'s opacity changed`;
  }
  const tilesets = data.tilesets || [];
  if (tilesets.length !== tilemap.tilesets.length) return 'its tilesets changed';
  for (let k = 0; k < tilesets.length; k++) {
    const was = tilemap.tilesets[k];
    const now = tilesets[k] || {};
    if (
      (now.firstgid || 1) !== was.firstgid ||
      (now.columns || 1) !== was.columns ||
      (now.tilewidth || tilemap.tileWidth) !== was.tileWidth ||
      (now.tileheight || tilemap.tileHeight) !== was.tileHeight
    ) {
      return 'its tilesets changed';
    }
  }
  return null;
}

/**
 * Load tilemap `id`'s Tiled file again and put its tiles in place: every thread's queries see them, and the layers
 * that show the map are drawn again (the promise waits for the renderer).
 * @param {object} scene - the running scene
 * @param {string} id
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ result: 'reloaded'|'reload'|'failed', reason: string }>} reloaded: in place; reload: it cannot
 *   go in place (reason), the page must load it; failed: the file did not load (reason), nothing changed
 */
export async function reloadTilemap(scene, id, fetchImpl = globalThis.fetch) {
  const entry = scene?.imageUrls?.tilemaps?.[id];
  if (!entry || typeof entry.json !== 'string') return { result: 'failed', reason: `the scene has no tilemap ${id}` };
  const tilemap = TileMap.get(id);
  if (tilemap === null) return { result: 'reload', reason: `tilemap ${id} did not load with the scene` };
  for (const layer of Layer.getAll()) {
    if (layer.kind === LAYER_KIND.TILEMAP && !layer._content?.tilemap) {
      return { result: 'reload', reason: `layer ${layer.name} shows a tilemap the scene set at runtime` };
    }
  }
  let data;
  try {
    const response = await fetchImpl(entry.json, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
  } catch (error) {
    return { result: 'failed', reason: `${entry.json} did not load (${error && error.message})` };
  }
  const change = tilemapShapeChange(tilemap, data);
  if (change !== null) return { result: 'reload', reason: change };
  const layers = tileLayersOf(data);
  const current = tilemap.getLayers();
  // Int32 stores wrap Tiled's flip flags (bit 31) as the load does.
  for (let k = 0; k < layers.length; k++) current[k].data.set(layers[k].data);
  const loaded = scene.loadedTilemaps?.[id];
  if (loaded) loaded.data = data;
  await Layer.applyConfiguredContent(id);
  return { result: 'reloaded', reason: '' };
}
