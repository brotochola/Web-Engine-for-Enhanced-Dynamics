/**
 * DX-GUARDS C6: an asset that does not load says which URL it asked for and what came back. A spritesheet's 404 used
 * to surface as "Unexpected token '<'" from parsing the error page as JSON, and an image's failure as an Event.
 */

/** The URL as the browser resolves it against the page (or the worker). */
export function resolvedAssetUrl(url) {
  try {
    return new URL(String(url), globalThis.location?.href).href;
  } catch {
    return String(url);
  }
}

function failed(what, url, why) {
  return new Error(`WeedJS: could not load ${what} ${url}: ${why}`);
}

/**
 * fetch(url), or an error naming the resolved URL and the HTTP status.
 * @param {string} url
 * @param {string} what what the asset is, for the message ("spritesheet JSON", "sound")
 * @returns {Promise<Response>}
 */
export async function fetchAsset(url, what) {
  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw failed(what, resolvedAssetUrl(url), err?.message || String(err));
  }
  if (!response.ok) {
    const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
    throw failed(what, response.url || resolvedAssetUrl(url), status);
  }
  return response;
}

/**
 * fetchAsset, then its JSON. A body that is not JSON (a dev server answers a missing file with its index page and
 * a 200) says so, with how it starts.
 * @param {string} url
 * @param {string} what
 */
export async function fetchAssetJson(url, what) {
  const response = await fetchAsset(url, what);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.slice(0, 40).replace(/\s+/g, ' ').trim();
    throw failed(what, response.url || resolvedAssetUrl(url), `it is not JSON (it starts "${start}"), so the URL serves something else`);
  }
}

/**
 * The error for an <img> that did not load: it gives no status, so ask the server once for it.
 * @param {string} url
 * @returns {Promise<Error>}
 */
export async function imageLoadError(url) {
  const at = resolvedAssetUrl(url);
  try {
    const response = await fetch(url);
    if (!response.ok) return failed('image', at, `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
    return failed('image', at, 'the browser could not decode it');
  } catch (err) {
    return failed('image', at, err?.message || String(err));
  }
}
