// N-312: a scene's own files (`static assets = { files }`), fetched with its other assets, all at once, and handed to it
// before preload() as `scene.files`: a level's data, a map, a table the scene reads itself. Each comes as its bytes (an
// ArrayBuffer), its text or its parsed JSON, gzip decompressed when asked. The barrio fetched its floor, traffic and
// scene file in preload(), after the workers were ready: about 200 ms of a warm start spent waiting on them alone.

import { fetchAssetRead, resolvedAssetUrl } from './fetchAsset.js';

/** How a file's body is handed over. */
const READS = Object.freeze(['arrayBuffer', 'text', 'json']);

/**
 * One entry of `assets.files` as { url, as, decompress }, or a TypeError that names it: a URL string, or
 * { url, as?: 'arrayBuffer' | 'text' | 'json', decompress?: 'gzip' }.
 * @param {string} name
 * @param {string | { url: string, as?: string, decompress?: string }} entry
 * @returns {{ url: string, as: 'arrayBuffer' | 'text' | 'json', decompress: 'gzip' | null }}
 */
export function sceneFileEntry(name, entry) {
  const spec = typeof entry === 'string' ? { url: entry } : entry;
  if (!spec || typeof spec !== 'object' || typeof spec.url !== 'string' || spec.url === '') {
    throw new TypeError(`WeedJS: assets.files.${name} needs a URL: a string, or { url, as, decompress }`);
  }
  const as = spec.as ?? 'arrayBuffer';
  if (!READS.includes(as)) {
    throw new TypeError(`WeedJS: assets.files.${name}.as is ${JSON.stringify(as)}: a file is read as 'arrayBuffer', 'text' or 'json'`);
  }
  const decompress = spec.decompress ?? null;
  if (decompress !== null && decompress !== 'gzip') {
    throw new TypeError(`WeedJS: assets.files.${name}.decompress is ${JSON.stringify(decompress)}: the one it knows is 'gzip'`);
  }
  return { url: spec.url, as, decompress };
}

/** Whether bytes start as a gzip stream does (1f 8b): a server that sent the file with Content-Encoding decoded it. */
function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** A body's bytes, gunzipped when they are gzip (and the entry asks for it). */
async function bodyBytes(response, entry) {
  const buffer = await response.arrayBuffer();
  if (entry.decompress !== 'gzip' || !isGzip(new Uint8Array(buffer))) return buffer;
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/** One file, read as its entry says. */
async function loadSceneFile(name, entry) {
  const what = `the scene's file "${name}"`;
  const { response, body } = await fetchAssetRead(entry.url, what, (r) => bodyBytes(r, entry));
  if (entry.as === 'arrayBuffer') return body;
  const text = new TextDecoder().decode(body);
  if (entry.as === 'text') return text;
  try {
    return JSON.parse(text);
  } catch (error) {
    const start = text.slice(0, 40).replace(/\s+/g, ' ').trim();
    throw new Error(
      `WeedJS: could not load ${what} ${response.url || resolvedAssetUrl(entry.url)}: it is not JSON (${error.message}; it starts "${start}")`,
    );
  }
}

/**
 * Every file of `assets.files`, fetched at once, by name. The entries are checked before any request.
 * @param {Record<string, string | { url: string, as?: string, decompress?: string }> | null | undefined} files
 * @returns {Promise<Record<string, ArrayBuffer | string | unknown>>}
 */
export async function loadSceneFiles(files) {
  if (!files) return {};
  const names = Object.keys(files);
  const entries = names.map((name) => sceneFileEntry(name, files[name]));
  const values = await Promise.all(entries.map((entry, i) => loadSceneFile(names[i], entry)));
  const loaded = {};
  for (let i = 0; i < names.length; i++) loaded[names[i]] = values[i];
  return loaded;
}
