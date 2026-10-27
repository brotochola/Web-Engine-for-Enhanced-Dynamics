// atlasBake.js — bake the running scene's atlas from the editor (VISUAL_EDITOR_PLAN.md ED-31), with no headless
// browser (scripts/bakeBigAtlas.mjs drives one through Playwright). A load packs the scene's images into one big atlas
// on the page and keeps it, in every build, debug or not: scene.bigAtlasCanvas and scene.bigAtlasJson
// (Scene._installBigAtlas; a scene that loaded a baked atlas keeps the canvas it drew it into). The bake writes them
// next to the scene's module through the dev server's file route: <SceneClass>.atlas.png and <SceneClass>.atlas.json.
// A scene whose static assets name them (bigAtlas: { json, png }) loads them instead of packing at load. The editor's
// Export (ED-32) bakes the same way, in memory, into the exported game.

import { putDevFile } from './sceneFileStore.js';

/**
 * A canvas as PNG bytes: an HTMLCanvasElement (toBlob) or an OffscreenCanvas (convertToBlob).
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @returns {Promise<Uint8Array>}
 */
export async function canvasPngBytes(canvas) {
  const blob =
    typeof canvas.convertToBlob === 'function'
      ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the atlas canvas gave no PNG'))), 'image/png');
      });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * The running scene's atlas, as files: its JSON (text) and its PNG (bytes), with its size and frame count.
 * @param {object} scene - the running scene
 * @returns {Promise<{ json: string, png: Uint8Array, width: number, height: number, frames: number }>}
 */
export async function atlasOf(scene) {
  assertHasAtlas(scene);
  const canvas = scene.bigAtlasCanvas;
  const json = scene.bigAtlasJson;
  return {
    json: JSON.stringify(json),
    png: await canvasPngBytes(canvas),
    width: canvas.width,
    height: canvas.height,
    frames: Object.keys(json.frames || {}).length,
  };
}

function assertHasAtlas(scene) {
  if (!scene?.bigAtlasCanvas || !scene?.bigAtlasJson) throw new Error('This scene has no atlas to bake: it has not finished loading');
}

/**
 * Where a scene's atlas is baked: next to its module, named after its class.
 * @param {object} scene
 * @returns {{ png: string, json: string }} absolute URLs
 */
export function atlasFileUrls(scene) {
  const moduleUrl = scene?.sceneScriptUrl;
  if (!moduleUrl) throw new Error('This scene was not loaded from a module URL: the bake has no folder to go to');
  const name = scene.constructor.name;
  return { png: new URL(`${name}.atlas.png`, moduleUrl).href, json: new URL(`${name}.atlas.json`, moduleUrl).href };
}

/**
 * Bake the running scene's atlas next to its module (atlasFileUrls), through the dev server.
 * @param {object} scene
 * @param {{ fetch?: typeof fetch, origin?: string }} [env] - for tests
 * @returns {Promise<{ png: string, json: string, width: number, height: number, frames: number, assets: string }>}
 *   the files' paths on the site, the atlas's size, and the `bigAtlas` entry that makes the scene load them
 */
export async function bakeAtlas(scene, env = {}) {
  assertHasAtlas(scene);
  const urls = atlasFileUrls(scene);
  const atlas = await atlasOf(scene);
  await putDevFile(urls.png, atlas.png, 'image/png', env);
  await putDevFile(urls.json, atlas.json, 'application/json', env);
  const png = new URL(urls.png).pathname;
  const json = new URL(urls.json).pathname;
  return {
    png,
    json,
    width: atlas.width,
    height: atlas.height,
    frames: atlas.frames,
    assets: `bigAtlas: { json: '${json}', png: '${png}' }`,
  };
}
