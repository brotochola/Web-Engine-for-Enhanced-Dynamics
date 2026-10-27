// Scene files a game carries in its code (registerSceneFile): an exported game (ED-32, game.min.js) registers its
// levels, and every load of one of their URLs (loadScene, defaultSceneFile, a save's recorded file) reads that
// document instead of fetching. Checked at registration; each load gets its own copy.
import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchSceneFile, registerSceneFile } from '../../src/core/sceneFile.js';
import WEED, { registerSceneFile as namedExport } from '../../src/index.js';

const level = () => ({
  format: 1,
  script: '../game.min.js',
  export: 'Level',
  entities: [{ name: 'Box1', class: 'Box', x: 10, y: 20, config: { width: 30 } }],
});

/** Run `fn` with a fetch that answers `files` (URL → text) and counts its calls. */
async function withFetch(files, fn) {
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const text = files[String(url)];
    return text === undefined ? new Response('missing', { status: 404 }) : new Response(text, { status: 200 });
  };
  try {
    await fn(asked);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('a registered file loads with no fetch, as a copy of what was registered, each load its own', async () => {
  await withFetch({}, async (asked) => {
    const doc = level();
    registerSceneFile('http://game.test/levels/1-1.scene.json', doc);
    doc.entities[0].x = 999; // the caller's object is not what was registered
    const a = await fetchSceneFile('http://game.test/levels/1-1.scene.json');
    assert.deepEqual(a, level());
    a.entities.length = 0; // a load that changes its document changes no other load's
    const b = await fetchSceneFile('http://game.test/levels/1-1.scene.json#start');
    assert.deepEqual(b, level(), 'the fragment is not part of the file');
    assert.notEqual(a, b);
    assert.deepEqual(asked, []);
  });
});

test('a file that was not registered is fetched as before', async () => {
  const text = JSON.stringify({ ...level(), export: 'Other' });
  await withFetch({ 'http://game.test/levels/other.scene.json': text }, async (asked) => {
    registerSceneFile('http://game.test/levels/1-2.scene.json', level());
    const doc = await fetchSceneFile('http://game.test/levels/other.scene.json');
    assert.equal(doc.export, 'Other');
    assert.deepEqual(asked, ['http://game.test/levels/other.scene.json']);
    await assert.rejects(fetchSceneFile('http://game.test/levels/none.scene.json'), /HTTP 404/);
  });
});

test('a malformed file throws at registration, naming its URL, and is not kept', async () => {
  assert.throws(() => registerSceneFile('http://game.test/levels/bad.scene.json', { format: 2, script: 's.js' }),
    /bad\.scene\.json: scene file format 2 is not supported/);
  assert.throws(() => registerSceneFile('http://game.test/levels/bad.scene.json', { format: 1, script: 's.js', entities: [{ name: 'A' }] }),
    /bad\.scene\.json: entities\[0\] \(A\) needs a "class"/);
  await withFetch({}, async () => {
    await assert.rejects(fetchSceneFile('http://game.test/levels/bad.scene.json'), /HTTP 404/);
  });
});

test('a relative URL is the page’s; without a page it must be absolute', async () => {
  assert.throws(() => registerSceneFile('levels/rel.scene.json', level()), TypeError);
  const hadLocation = Object.hasOwn(globalThis, 'location');
  const saved = globalThis.location;
  globalThis.location = { href: 'http://game.test/play/index.html' };
  try {
    registerSceneFile('levels/rel.scene.json', level());
    await withFetch({}, async (asked) => {
      assert.deepEqual(await fetchSceneFile('http://game.test/play/levels/rel.scene.json'), level());
      assert.deepEqual(await fetchSceneFile('/play/levels/rel.scene.json'), level(), 'from the site root too');
      assert.deepEqual(asked, []);
    });
  } finally {
    if (hadLocation) globalThis.location = saved;
    else delete globalThis.location;
  }
});

test('the engine exports it, named and on WEED', () => {
  assert.equal(typeof namedExport, 'function');
  assert.equal(WEED.registerSceneFile, namedExport);
  assert.equal(namedExport, registerSceneFile);
});
