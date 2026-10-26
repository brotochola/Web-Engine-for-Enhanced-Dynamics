// sceneFileStore.js — the editor's side of the dev server's editor routes (server/devRoutes.js; VISUAL_EDITOR_PLAN.md
// D7, ED-13, ED-38): save a scene document to its file, and list the scene files of a folder. A page served by
// `npm run dev`, or by a server with the same routes, can; another server answers 404, and the editor says how to get
// one that can.

import { serializeSceneFile } from '../../sceneFile.js';
import { HotReload } from '../hotReload.js';

/** How long hot reload skips the editor's own write: the page already shows what it wrote. */
export const OWN_WRITE_IGNORE_MS = 2000;

/**
 * Write a scene document (format 1) to its file through the dev server, in the file's layout (serializeSceneFile).
 * @param {string} fileUrl - the file's URL, on this page's server
 * @param {object} doc
 * @param {{ fetch?: typeof fetch, origin?: string }} [env] - for tests
 * @returns {Promise<number>} the file's new modification time
 */
export async function saveSceneFile(fileUrl, doc, env = {}) {
  const origin = env.origin ?? location.origin;
  const url = new URL(fileUrl, `${origin}/`);
  if (url.origin !== origin) throw new Error(`${fileUrl} is not on this page's server, so the editor cannot save it`);
  const sitePath = decodeURIComponent(url.pathname);
  const text = serializeSceneFile(doc);
  HotReload.ignore(url.pathname, OWN_WRITE_IGNORE_MS);
  const res = await (env.fetch ?? fetch)(`${origin}/__weed/file?path=${encodeURIComponent(sitePath)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: text,
  });
  let answer = null;
  try {
    answer = await res.json();
  } catch {
    // a server without the route answers a page, not JSON
  }
  if (!res.ok) {
    if (answer === null || typeof answer.error !== 'string') {
      throw new Error(`this server cannot save files (HTTP ${res.status}): serve the game with npm run dev`);
    }
    throw new Error(`could not save ${sitePath}: ${answer.error}`);
  }
  return answer.mtimeMs;
}

/**
 * The scene files of a folder (`.scene.json`), sorted, through the dev server.
 * @param {string} folderUrl - the folder's URL, on this page's server (`…/levels/`)
 * @param {{ fetch?: typeof fetch, origin?: string }} [env] - for tests
 * @returns {Promise<string[]>} the files' names
 */
export async function listSceneFiles(folderUrl, env = {}) {
  const origin = env.origin ?? location.origin;
  const url = new URL(folderUrl, `${origin}/`);
  if (url.origin !== origin) throw new Error(`${folderUrl} is not on this page's server, so the editor cannot list it`);
  const dir = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/';
  const res = await (env.fetch ?? fetch)(`${origin}/__weed/list?dir=${encodeURIComponent(dir)}&ext=.scene.json`);
  let answer = null;
  try {
    answer = await res.json();
  } catch {
    // a server without the route answers a page, not JSON
  }
  if (!res.ok || answer === null || !Array.isArray(answer.files)) {
    const why = answer !== null && typeof answer.error === 'string' ? answer.error : `HTTP ${res.status}`;
    throw new Error(`could not list ${dir} (${why}): the list needs npm run dev`);
  }
  return answer.files;
}
