// editorPage.js — the dev server's route to the editor page (VISUAL_EDITOR_PLAN.md D9, ED-29, ED-30): /__weed/editor/
// serves the page's files from its folder (src/core/debug/editor/shell in this repo, the @weed.js/editor package's
// shell/ for a game) with the headers SharedArrayBuffer needs, so the game page in its iframe is isolated too.
// Only the folder's own files: no subfolder, no way out of it.

import fs from 'fs';
import path from 'path';

export const EDITOR_ROUTE = '/__weed/editor/';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/**
 * Serve the editor page's files. Returns false when the request is not for them.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ shellDir: string, headers?: Record<string, string> }} options
 * @returns {boolean}
 */
export function serveEditorPage(req, res, { shellDir, headers = {} }) {
  const [rawPath, query = ''] = req.url.split('?');
  if (rawPath === EDITOR_ROUTE.slice(0, -1)) {
    res.writeHead(301, { Location: `${EDITOR_ROUTE}${query ? `?${query}` : ''}` });
    res.end();
    return true;
  }
  if (!rawPath.startsWith(EDITOR_ROUTE)) return false;
  let name;
  try {
    name = decodeURIComponent(rawPath.slice(EDITOR_ROUTE.length)) || 'index.html';
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
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...headers });
    res.end(content);
  });
  return true;
}
