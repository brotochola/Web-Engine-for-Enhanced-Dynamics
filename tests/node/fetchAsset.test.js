// DX-GUARDS C6: an asset that does not load names the URL it asked for and what came back. A spritesheet's 404 used
// to reach .json() and read "Unexpected token '<'"; an <img> rejected with an Event.
import test from 'node:test';
import assert from 'node:assert/strict';

import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { fetchAsset, fetchAssetJson, fetchAssetRead } from '../../src/util/fetchAsset.js';

const PAGE = '<!doctype html><html><body>Not Found</body></html>';

/** fetch answering from a table of path → [status, body, statusText]; anything else is a 404 page. */
function serve(table) {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const [status, body, statusText] = table[String(url)] || [404, PAGE, 'Not Found'];
    return new Response(body, { status, statusText });
  };
  return () => {
    globalThis.fetch = saved;
  };
}

test('fetchAsset names the URL and the HTTP status; a network failure, its reason', async () => {
  const restore = serve({});
  try {
    await assert.rejects(fetchAsset('img/hero.png', 'image'), {
      message: 'WeedJS: could not load image img/hero.png: HTTP 404 Not Found',
    });
  } finally {
    restore();
  }
  const saved = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  try {
    await assert.rejects(fetchAsset('img/hero.png', 'image'), { message: /could not load image img\/hero\.png: Failed to fetch$/ });
  } finally {
    globalThis.fetch = saved;
  }
});

test('fetchAssetJson says when a 200 is not JSON (a dev server\'s index page)', async () => {
  const restore = serve({ 'a.json': [200, PAGE, 'OK'], 'b.json': [200, '{"frames":{}}', 'OK'] });
  try {
    await assert.rejects(fetchAssetJson('a.json', 'spritesheet JSON'), {
      message: 'WeedJS: could not load spritesheet JSON a.json: it is not JSON (it starts "<!doctype html><html><body>Not Found</bo"), so the URL serves something else',
    });
    assert.deepEqual(await fetchAssetJson('b.json', 'spritesheet JSON'), { frames: {} });
  } finally {
    restore();
  }
});

test('a spritesheet whose JSON 404s names it, not "Unexpected token"', async () => {
  const restore = serve({ 'img/hero.png': [200, 'png', 'OK'] });
  try {
    await assert.rejects(SpriteSheetRegistry._loadSpritesheet('hero', { json: 'img/hero.json', png: 'img/hero.png' }), {
      message: 'WeedJS: could not load spritesheet "hero" JSON img/hero.json: HTTP 404 Not Found',
    });
  } finally {
    restore();
  }
});

test('an image that does not load names its URL and status, in a worker and on a page', async () => {
  const restore = serve({});
  try {
    await assert.rejects(SpriteSheetRegistry._loadImage('img/missing.png'), {
      message: 'WeedJS: could not load image img/missing.png: HTTP 404 Not Found',
    });
    // A page: an <img>, whose error event says nothing.
    globalThis.Image = class {
      set src(v) {
        setTimeout(() => this.onerror(new Event('error')), 0);
      }
    };
    await assert.rejects(SpriteSheetRegistry._loadImage('img/missing.png'), {
      message: 'WeedJS: could not load image img/missing.png: HTTP 404 Not Found',
    });
  } finally {
    delete globalThis.Image;
    restore();
  }
});

// N-144: two tabs of one browser loading a 16 MB tilemap at once failed one with net::ERR_CACHE_WRITE_FAILURE (the body
// read rejected though the server answered), and nothing tried again. A network failure of the request or of the body
// read is tried once more past the HTTP cache; an HTTP error or a body the caller rejects is an answer.
function fake(answer) {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(init?.cache);
    return answer(calls.length, String(url));
  };
  return { calls, restore: () => { globalThis.fetch = saved; } };
}

test('N-144: a failed request is tried once more with cache: no-store', async () => {
  const f = fake((n) => {
    if (n === 1) throw new TypeError('Failed to fetch');
    return new Response('{"ok":1}', { status: 200 });
  });
  try {
    assert.deepEqual(await fetchAssetJson('map.json', 'tilemap JSON'), { ok: 1 });
    assert.deepEqual(f.calls, [undefined, 'no-store']);
  } finally {
    f.restore();
  }
});

test('N-144: a body read that fails on the network tries the request and the read again', async () => {
  const f = fake((n) => {
    const r = new Response('png bytes', { status: 200 });
    if (n === 1) r.blob = async () => { throw new TypeError('network error'); }; // the stream broke
    return r;
  });
  try {
    const { body } = await fetchAssetRead('tiles.png', 'tileset', (r) => r.blob());
    assert.equal(await body.text(), 'png bytes');
    assert.deepEqual(f.calls, [undefined, 'no-store']);
  } finally {
    f.restore();
  }
});

test('N-144: an HTTP error and a body that is not JSON are answers, not tried again', async () => {
  let f = fake(() => new Response(PAGE, { status: 404, statusText: 'Not Found' }));
  try {
    await assert.rejects(fetchAssetRead('a.png', 'image', (r) => r.blob()), { message: 'WeedJS: could not load image a.png: HTTP 404 Not Found' });
    assert.equal(f.calls.length, 1);
  } finally {
    f.restore();
  }
  f = fake(() => new Response(PAGE, { status: 200 }));
  try {
    await assert.rejects(fetchAssetJson('a.json', 'tilemap JSON'), { message: /it is not JSON/ });
    assert.equal(f.calls.length, 1);
  } finally {
    f.restore();
  }
});

test('N-144: a second network failure says the URL and the reason (C6)', async () => {
  const f = fake(() => {
    throw new TypeError('Failed to fetch');
  });
  try {
    await assert.rejects(fetchAssetRead('big.json', 'tilemap JSON', (r) => r.text()), { message: /could not load tilemap JSON big\.json: Failed to fetch$/ });
    assert.deepEqual(f.calls, [undefined, 'no-store']);
  } finally {
    f.restore();
  }
});
