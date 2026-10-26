// devRoutes.js — the dev server's routes for the editor (VISUAL_EDITOR_PLAN.md D7, ED-13): save a scene file, and
// list the scene files of a folder. One module, for server/node_server.js now and the create-weed-game template's
// dev script later (ED-30); it needs nothing but Node.
//
//   PUT /__weed/file?path=/demos/x/levels/1-1.scene.json    body: the file's new text
//       200 { "mtimeMs": … }: written atomically (a temporary file in the same folder, then a rename over it)
//   GET /__weed/list?dir=/demos/x/levels&ext=.scene.json
//       200 { "files": ["1-1.scene.json", …] }: the folder's files with that ending, sorted
//
// Who may: a request from this machine (the socket's address), addressed to it by a loopback name (Host), and, when
// it says where it comes from (Origin), from a page of this server. A page of another site open in the same browser
// is also "from this machine", and DNS rebinding can give it a loopback address under its own name.
// What: a path inside the served folder, after normalization and through links; a name ending in .scene.json; a
// body of at most 8 MB that parses as JSON. Anything else is refused (400, 403, 404, 405, 413) and writes nothing.

import fs from 'node:fs';
import path from 'node:path';

export const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** The file endings the routes write and list (Stage 5 adds the atlas files). */
export const DEV_FILE_EXTENSIONS = Object.freeze(['.scene.json']);

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether a request came from this machine, to one of its loopback names and, if it names its origin, from a page
 * of this server.
 * @param {import('node:http').IncomingMessage} req
 */
export function isLocalRequest(req) {
  if (!LOOPBACK_ADDRESSES.has(req.socket?.remoteAddress)) return false;
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return false;
  const origin = req.headers.origin;
  return origin === undefined || origin === `http://${host}`;
}

const isInside = (root, p) => {
  const rel = path.relative(root, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

/**
 * The absolute path of a site path (`/demos/x/1-1.scene.json`) in the served folder, or null when it is not one:
 * not starting with `/`, holding a `\`, `:` or NUL (Windows reads `a:b` as a file's stream), or leaving the folder
 * once `..` is resolved, or through a link (for the part of the path that exists, such as the folder of a new file).
 * @param {string} root - the served folder
 * @param {unknown} sitePath
 * @returns {string|null}
 */
export function resolveInside(root, sitePath) {
  if (typeof sitePath !== 'string' || !sitePath.startsWith('/') || /[\\:\0]/.test(sitePath)) return null;
  const rootReal = fs.realpathSync(root);
  const abs = path.resolve(rootReal, `.${sitePath}`);
  if (!isInside(rootReal, abs)) return null;
  let existing = abs;
  while (!fs.existsSync(existing)) {
    const up = path.dirname(existing);
    if (up === existing) return null;
    existing = up;
  }
  return isInside(rootReal, fs.realpathSync(existing)) ? abs : null;
}

const hasDevExtension = (name, ext) => (ext === undefined ? DEV_FILE_EXTENSIONS.some((e) => name.endsWith(e)) : name.endsWith(ext));

/**
 * Serve the editor's routes. Returns false when the request is none of them, for the caller to serve.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} root - the served folder
 * @param {Record<string, string>} [headers] - added to every answer (the server's isolation headers)
 * @returns {boolean}
 */
export function handleDevRoute(req, res, root, headers = {}) {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;
  if (route !== '/__weed/file' && route !== '/__weed/list') return false;
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  if (!isLocalRequest(req)) {
    send(403, { error: 'only a page of this server, on this machine, may use the editor routes' });
    return true;
  }
  if (route === '/__weed/file') {
    if (req.method !== 'PUT') send(405, { error: 'PUT the file' });
    else writeFileRoute(req, url, root, send);
  } else if (req.method !== 'GET') {
    send(405, { error: 'GET the list' });
  } else {
    listRoute(url, root, send);
  }
  return true;
}

function writeFileRoute(req, url, root, send) {
  const sitePath = url.searchParams.get('path');
  const file = resolveInside(root, sitePath);
  if (file === null) {
    req.resume();
    send(400, { error: `not a path in the served folder: ${sitePath}` });
    return;
  }
  if (!hasDevExtension(path.basename(file))) {
    req.resume();
    send(400, { error: `only ${DEV_FILE_EXTENSIONS.join(', ')} files can be written` });
    return;
  }
  const chunks = [];
  let size = 0;
  let refused = false;
  req.on('data', (chunk) => {
    if (refused) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      refused = true;
      chunks.length = 0;
      send(413, { error: `a file is at most ${MAX_BODY_BYTES} bytes` });
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (refused) return;
    const text = Buffer.concat(chunks).toString('utf8');
    try {
      JSON.parse(text);
    } catch (error) {
      send(400, { error: `not JSON: ${error.message}` });
      return;
    }
    if (!fs.existsSync(path.dirname(file))) {
      send(404, { error: `no folder ${path.posix.dirname(sitePath)}` });
      return;
    }
    writeAtomic(file, text).then(
      (mtimeMs) => send(200, { mtimeMs }),
      (error) => send(500, { error: `could not write ${sitePath}: ${error.code || error.message}` }),
    );
  });
}

function listRoute(url, root, send) {
  const sitePath = url.searchParams.get('dir');
  const ext = url.searchParams.get('ext');
  if (!DEV_FILE_EXTENSIONS.includes(ext)) {
    send(400, { error: `ext must be one of ${DEV_FILE_EXTENSIONS.join(', ')}` });
    return;
  }
  const dir = resolveInside(root, sitePath);
  if (dir === null) {
    send(400, { error: `not a path in the served folder: ${sitePath}` });
    return;
  }
  fs.promises.readdir(dir, { withFileTypes: true }).then(
    (entries) => {
      const files = entries.filter((e) => e.isFile() && hasDevExtension(e.name, ext)).map((e) => e.name);
      send(200, { files: files.sort() });
    },
    (error) => send(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500, { error: `cannot list ${sitePath}` }),
  );
}

/**
 * Write a file so that a reader sees the old text or the new one, never part of it: a temporary file in the same
 * folder, then a rename over the file. Returns the new modification time.
 * @param {string} file
 * @param {string} text
 * @returns {Promise<number>}
 */
export async function writeAtomic(file, text) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await fs.promises.writeFile(temp, text, { flag: 'wx' });
  try {
    await renameOver(temp, file);
  } catch (error) {
    await fs.promises.rm(temp, { force: true });
    throw error;
  }
  return (await fs.promises.stat(file)).mtimeMs;
}

/** How long a rename over a file that someone is reading is tried again (Windows refuses it meanwhile). */
const RENAME_RETRY_MS = 2000;

/**
 * Windows does not rename over a file another program has open (the dev server serving it, an editor, the indexer,
 * an antivirus): try again for up to RENAME_RETRY_MS, as graceful-fs does.
 */
async function renameOver(from, to) {
  const start = Date.now();
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (error) {
      const busy = error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'EACCES';
      if (!busy || Date.now() - start > RENAME_RETRY_MS) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
