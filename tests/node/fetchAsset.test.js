// DX-GUARDS C6: an asset that does not load names the URL it asked for and what came back. A spritesheet's 404 used
// to reach .json() and read "Unexpected token '<'"; an <img> rejected with an Event.
import test from 'node:test';
import assert from 'node:assert/strict';

import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { fetchAsset, fetchAssetJson } from '../../src/util/fetchAsset.js';

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
