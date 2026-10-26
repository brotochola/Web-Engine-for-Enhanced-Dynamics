// fetchRetry - fetch and read once more, past the HTTP cache, when the first try fails on the network.
//
// Two tabs of one browser loading the same large asset at once (the 16 MB roads
// tilemap) can fail one of them with net::ERR_CACHE_WRITE_FAILURE: the request or
// the body read rejects with a TypeError though the server answered. A second
// request that skips the cache gets it. HTTP errors (404, 500) and bad content
// (a SyntaxError from json()) are answers, not network failures: not retried.

/** An HTTP status that is not ok. Not a TypeError, so it is never retried. */
export class FetchStatusError extends Error {
  constructor(url, status) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'FetchStatusError';
    this.url = url;
    this.status = status;
  }
}

/**
 * Fetch `url` and read it with `read(response)`; on a network failure, do both again
 * with `cache: 'no-store'`.
 *
 * @template T
 * @param {string} url
 * @param {(response: Response) => Promise<T>} read - e.g. (r) => r.json(), (r) => r.blob()
 * @param {typeof fetch} [fetchImpl] - injectable for tests
 * @returns {Promise<T>}
 */
export async function fetchReadRetryUncached(url, read, fetchImpl = globalThis.fetch) {
  const attempt = async (init) => {
    const response = await fetchImpl(url, init);
    if (!response.ok) throw new FetchStatusError(url, response.status);
    return read(response);
  };
  try {
    return await attempt(undefined);
  } catch (first) {
    if (!(first instanceof TypeError)) throw first;
    return attempt({ cache: 'no-store' });
  }
}
