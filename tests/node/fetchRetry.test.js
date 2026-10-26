import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchReadRetryUncached, FetchStatusError } from '../../src/util/fetchRetry.js';

// Tilemaps load through fetchReadRetryUncached: a network failure in the request or
// in the body read (two tabs writing one cache entry: net::ERR_CACHE_WRITE_FAILURE)
// gets one more try, request and read, without the cache.

const okResponse = (body, onRead) => ({
  ok: true,
  status: 200,
  json: async () => {
    if (onRead) onRead();
    return body;
  },
});

test('a failed request is retried once with cache: no-store', async () => {
  const caches = [];
  const fake = async (_url, init) => {
    caches.push(init ? init.cache : undefined);
    if (caches.length === 1) throw new TypeError('Failed to fetch');
    return okResponse({ ok: 1 });
  };
  assert.deepEqual(await fetchReadRetryUncached('/map.json', (r) => r.json(), fake), { ok: 1 });
  assert.deepEqual(caches, [undefined, 'no-store']);
});

test('a body read that fails on the network retries the request and the read', async () => {
  const caches = [];
  const fake = async (_url, init) => {
    caches.push(init ? init.cache : undefined);
    return okResponse({ layers: [] }, () => {
      if (caches.length === 1) throw new TypeError('Failed to fetch'); // the stream broke
    });
  };
  assert.deepEqual(await fetchReadRetryUncached('/map.json', (r) => r.json(), fake), {
    layers: [],
  });
  assert.deepEqual(caches, [undefined, 'no-store']);
});

test('an HTTP error and bad content are answers: thrown at once, not retried', async () => {
  let n = 0;
  await assert.rejects(
    fetchReadRetryUncached(
      '/missing.json',
      (r) => r.json(),
      async () => {
        n++;
        return { ok: false, status: 404 };
      }
    ),
    (e) => e instanceof FetchStatusError && e.status === 404
  );
  assert.equal(n, 1);
  n = 0;
  await assert.rejects(
    fetchReadRetryUncached(
      '/bad.json',
      async () => JSON.parse('{'),
      async () => {
        n++;
        return { ok: true, status: 200 };
      }
    ),
    SyntaxError
  );
  assert.equal(n, 1);
});

test('a second network failure is thrown', async () => {
  let n = 0;
  await assert.rejects(
    fetchReadRetryUncached(
      '/x',
      (r) => r.json(),
      async () => {
        n++;
        throw new TypeError('Failed to fetch');
      }
    ),
    TypeError
  );
  assert.equal(n, 2);
});
