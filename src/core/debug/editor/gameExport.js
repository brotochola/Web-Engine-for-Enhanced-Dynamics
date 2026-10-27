// gameExport.js — the editor's side of Export (VISUAL_EDITOR_PLAN.md ED-32): what the running game is made of, read
// from the running scene, sent to the dev server's export route (POST /__weed/export, server/exportGame.js), which
// builds it as a static site in a folder of its own choosing and says where.
//
// What it sends: the scene's module and class; the scene file it runs (where the exported page starts) and the other
// scene files of that folder; every file the scene class declares (static assets, audios, file paths in its config,
// such as layer shaders), as the code has them and as paths of this site; and the atlas the scene packed at load,
// baked (atlasBake.js), which the exported scene loads instead of packing. With the atlas, the images it replaces
// (assets.textures, assets.spritesheets, an earlier bigAtlas) are not sent: a scene with a baked atlas never fetches
// them. The files go as they are saved: unsaved edits are not exported.

import { atlasOf } from './atlasBake.js';
import { listSceneFiles } from './sceneFileStore.js';

/** The last part of a path, with an extension: a string that names a file. */
const FILE_NAME = /\/[^/?#]*\.[A-Za-z0-9]{1,5}(?:[?#].*)?$/;

/**
 * Every string in a value that names a file by a path (`/demos/img/a.png`, `./b.json`), through arrays and plain
 * objects (not classes or functions).
 * @param {unknown} value
 * @param {Set<string>} [out]
 * @returns {Set<string>}
 */
export function filePathsIn(value, out = new Set()) {
  if (typeof value === 'string') {
    if (FILE_NAME.test(value)) out.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) filePathsIn(item, out);
  } else if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) for (const key of Object.keys(value)) filePathsIn(value[key], out);
  }
  return out;
}

/** What a baked atlas replaces in static assets: the images it was packed from, and an earlier bake. */
const PACKED = new Set(['textures', 'spritesheets', 'bigAtlas']);

/**
 * The files a scene class declares, as its code has them: static assets (without what a baked atlas replaces, when
 * there is one), audios, and file paths in its config (layer shaders).
 * @param {Function} SceneClass
 * @param {{ baked: boolean }} options
 * @returns {string[]}
 */
export function declaredFiles(SceneClass, { baked }) {
  const out = new Set();
  for (const [key, value] of Object.entries(SceneClass.assets || {})) {
    if (!(baked && PACKED.has(key))) filePathsIn(value, out);
  }
  filePathsIn(SceneClass.audios, out);
  filePathsIn(SceneClass.config, out);
  return [...out];
}

/** Bytes as base64, in chunks (a big atlas would overflow one String.fromCharCode call). */
function base64Of(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * The export route's request for the running scene.
 * @param {object} scene - the running scene
 * @param {{ pageUrl: string, sceneFiles: string[], atlas: { json: string, png: Uint8Array } | null }} what
 *   pageUrl: the page's URL, which the scene's relative URLs are relative to; sceneFiles: the scene files' URLs
 * @returns {object}
 */
export function exportRequestOf(scene, { pageUrl, sceneFiles, atlas }) {
  if (!scene || !scene.sceneScriptUrl) throw new Error('Nothing to export: the scene was not loaded from a module URL');
  const page = new URL(pageUrl);
  const sitePath = (url) => decodeURIComponent(new URL(url, page).pathname);
  const SceneClass = scene.constructor;
  const assets = [];
  for (const url of declaredFiles(SceneClass, { baked: atlas !== null })) {
    const at = new URL(url, page);
    if (at.origin === page.origin) assets.push({ url, path: decodeURIComponent(at.pathname) });
  }
  return {
    scene: sitePath(scene.sceneScriptUrl),
    export: SceneClass.name,
    start: scene.sceneFileUrl ? sitePath(scene.sceneFileUrl) : null,
    sceneFiles: sceneFiles.map(sitePath),
    assets,
    atlas: atlas === null ? null : { json: atlas.json, png: base64Of(atlas.png) },
    title: SceneClass.name,
  };
}

/**
 * Export the running game through the dev server.
 * @param {object} scene
 * @param {{ fetch?: typeof fetch, origin?: string, pageUrl?: string }} [env] - for tests
 * @returns {Promise<{ outDir: string, url: string|null, files: string[], bytes: number, gameBytes: number,
 *   warnings: string[] }>} where it went: the folder, and its URL on this server when it is inside the served folder
 */
export async function exportRunningGame(scene, env = {}) {
  const origin = env.origin ?? location.origin;
  const pageUrl = env.pageUrl ?? location.href;
  let sceneFiles = [];
  if (scene?.sceneFileUrl) {
    const folder = new URL('.', scene.sceneFileUrl).href;
    sceneFiles = (await listSceneFiles(folder, env)).map((name) => new URL(name, folder).href);
  }
  const atlas = await atlasOf(scene);
  const request = exportRequestOf(scene, { pageUrl, sceneFiles, atlas });
  const res = await (env.fetch ?? fetch)(`${origin}/__weed/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  let answer = null;
  try {
    answer = await res.json();
  } catch {
    // a server without the route answers a page, not JSON
  }
  if (!res.ok) {
    if (answer === null || typeof answer.error !== 'string') {
      throw new Error(`this server cannot export (HTTP ${res.status}): serve the game with npm run dev`);
    }
    throw new Error(`Export failed: ${answer.error}`);
  }
  return answer;
}
