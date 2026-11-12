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

/** One request and its body read; an HTTP error is an answer (C6's message), a network failure a TypeError. */
async function fetchAndRead(url, what, read, init) {
  const response = await (init ? fetch(url, init) : fetch(url));
  if (!response.ok) {
    const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
    throw failed(what, response.url || resolvedAssetUrl(url), status);
  }
  return { response, body: await read(response) };
}

/**
 * N-144: fetch(url) and read its body with `read`; when either fails on the network (a TypeError: two tabs of one
 * browser loading a 16 MB tilemap at once failed one with net::ERR_CACHE_WRITE_FAILURE, the body read rejecting though
 * the server had answered), both once more past the HTTP cache (`cache: 'no-store'`). An HTTP error and a body the
 * caller's `read` rejects are answers, not tried again. Errors name the resolved URL and the reason (C6).
 * @template T
 * @param {string} url
 * @param {string} what what the asset is, for the message ("spritesheet JSON", "sound")
 * @param {(response: Response) => Promise<T>} read
 * @returns {Promise<{ response: Response, body: T }>}
 */
export async function fetchAssetRead(url, what, read) {
  try {
    return await fetchAndRead(url, what, read, null);
  } catch (first) {
    if (!(first instanceof TypeError)) throw first;
    try {
      return await fetchAndRead(url, what, read, { cache: 'no-store' });
    } catch (second) {
      if (!(second instanceof TypeError)) throw second;
      throw failed(what, resolvedAssetUrl(url), second?.message || String(second));
    }
  }
}

/**
 * fetch(url), or an error naming the resolved URL and the HTTP status. Its body is the caller's to read: one that
 * reads it at once takes fetchAssetRead, which retries the read too (N-144).
 * @param {string} url
 * @param {string} what what the asset is, for the message ("spritesheet JSON", "sound")
 * @returns {Promise<Response>}
 */
export async function fetchAsset(url, what) {
  return (await fetchAssetRead(url, what, async () => null)).response;
}

/**
 * fetchAssetRead of its text, then its JSON. A body that is not JSON (a dev server answers a missing file with its
 * index page and a 200) says so, with how it starts.
 * @param {string} url
 * @param {string} what
 */
export async function fetchAssetJson(url, what) {
  const { response, body: text } = await fetchAssetRead(url, what, (r) => r.text());
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
