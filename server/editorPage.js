// editorPage.js — the dev server's route to the editor page (VISUAL_EDITOR_PLAN.md D9, ED-29, ED-30): /__weed/editor/
// serves the page's files from its folder (src/core/debug/editor/shell in this repo, the @weed.js/editor package's
// shell/ for a game) with the headers SharedArrayBuffer needs, so the game page in its iframe is isolated too.
// Only the folder's own files: no subfolder, no way out of it.
//
// /editor is the short route to it (`/editor?scene=platformergame`), unless the served folder has an `editor` of its
// own. The page learns from its index.html which game page it opens (`gamePage`: /demos/ in this repo, / for a game)
// with its own query, so /editor?scene=x is /demos/?scene=x in the editor.

import fs from 'fs';
import path from 'path';

export const EDITOR_ROUTE = '/__weed/editor/';
export const EDITOR_SHORT_ROUTE = '/editor';
/** The line of the page's index.html that the server fills: the game page, and the base of the page's own files. */
const GAME_PAGE_META = '<meta name="weed-game-page" content="" />';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/**
 * Serve the editor page's files. Returns false when the request is not for them.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ shellDir: string, headers?: Record<string, string>, gamePage?: string, root?: string|null }} options
 *   gamePage: the game page /editor opens; root: the served folder (an `editor` of its own keeps /editor)
 * @returns {boolean}
 */
export function serveEditorPage(req, res, { shellDir, headers = {}, gamePage = '', root = null }) {
  const [rawPath, query = ''] = req.url.split('?');
  if (rawPath === EDITOR_ROUTE.slice(0, -1)) {
    res.writeHead(301, { Location: `${EDITOR_ROUTE}${query ? `?${query}` : ''}` });
    res.end();
    return true;
  }
  let base;
  if (rawPath.startsWith(EDITOR_ROUTE)) {
    base = EDITOR_ROUTE;
  } else if (rawPath === EDITOR_SHORT_ROUTE || rawPath.startsWith(`${EDITOR_SHORT_ROUTE}/`)) {
    if (!shortRouteServed(root)) return false;
    base = `${EDITOR_SHORT_ROUTE}/`;
  } else {
    return false;
  }
  let name;
  try {
    name = decodeURIComponent(rawPath.slice(base.length)) || 'index.html';
  } catch {
    name = '';
  }
  const type = TYPES[path.extname(name).toLowerCase()];
  if (!name || /[\\/:\0]/.test(name) || name.startsWith('.') || type === undefined) {
    res.writeHead(404, { 'Content-Type': 'text/plain', ...headers });
    res.end('Not an editor page file');
    return true;
  }
  fs.readFile(path.join(shellDir, name), (error, content) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain', ...headers });
      res.end('Not an editor page file');
      return;
    }
    const pageHeaders = { 'Content-Type': type, 'Cache-Control': 'no-cache', ...headers };
    if (name === 'index.html') {
      // The route a game page's Editor page button opens (src/core/debug/editorPage.js editorPageFor).
      pageHeaders['X-Weed-Editor'] = base === EDITOR_ROUTE && !shortRouteServed(root) ? EDITOR_ROUTE : EDITOR_SHORT_ROUTE;
      content = fillPage(content.toString('utf8'), base, gamePage);
    }
    res.writeHead(200, pageHeaders);
    res.end(content);
  });
  return true;
}

/** Whether /editor is the editor page's: the served folder has no `editor` of its own. */
function shortRouteServed(root) {
  return root === null || !fs.existsSync(path.join(root, 'editor'));
}

/** The page with its base (so /editor, without its slash, finds the page's files) and the game page it opens. */
function fillPage(html, base, gamePage) {
  const attr = (text) => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return html.replace(GAME_PAGE_META, () => `<base href="${attr(base)}" />\n  <meta name="weed-game-page" content="${attr(gamePage)}" />`);
}
