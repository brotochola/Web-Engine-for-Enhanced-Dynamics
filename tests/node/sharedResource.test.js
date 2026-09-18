import test from 'node:test';
import assert from 'node:assert/strict';

import { SharedResource } from '../../src/core/sharedResource.js';

class WorldGrid extends SharedResource {}
class GameState extends SharedResource {}

test('SharedResource: two views of the same SAB see cells[i] writes', () => {
  const schema = {
    cells: { type: Float32Array, length: 8 },
    score: Int32Array,
  };
  const bytes = SharedResource.getBufferSize(schema);
  assert.ok(bytes >= 8 * 4 + 4);

  const sab = new SharedArrayBuffer(bytes);
  WorldGrid.initialize(sab, schema);
  GameState.initialize(sab, schema);

  WorldGrid.cells[3] = 1.5;
  WorldGrid.score[0] = 10;
  assert.equal(GameState.cells[3], 1.5);
  assert.equal(GameState.score[0], 10);

  GameState.cells[3] = 2.25;
  assert.equal(WorldGrid.cells[3], 2.25);

  SharedResource.resetAll();
  assert.equal(WorldGrid.cells, null);
  assert.equal(GameState.score, null);
});

test('serializeSchema uses type names for worker postMessage', () => {
  const packed = SharedResource.serializeSchema({
    flags: { type: Uint8Array, length: 32 },
    score: Int32Array,
  });
  assert.deepEqual(packed.flags, { type: 'Uint8Array', length: 32 });
  assert.deepEqual(packed.score, { type: 'Int32Array', length: 1 });

  class Other extends SharedResource {}
  const sab = new SharedArrayBuffer(SharedResource.getBufferSize(packed));
  Other.initialize(sab, packed);
  Other.flags[4] = 7;
  assert.equal(Other.flags[4], 7);
  assert.equal(Other.flags.length, 32);
  SharedResource.resetAll();
});

test('parseRows requires [Class, schema]', () => {
  assert.equal(SharedResource.parseRows(undefined).length, 0);
  assert.throws(() => SharedResource.parseRows([WorldGrid]), {
    name: 'TypeError',
  });
});

test('bindFromInit throws when scriptUrl was omitted and class is missing', () => {
  assert.throws(
    () => SharedResource.bindFromInit([{ name: 'MissingGrid', schema: { n: Int32Array } }], {}),
    /set static scriptUrl/,
  );
});

test('bindFromInit throws when scriptUrl was set and class did not load', () => {
  assert.throws(
    () =>
      SharedResource.bindFromInit(
        [{ name: 'MissingGrid', schema: { n: Int32Array }, scriptUrl: '/missing.js' }],
        {},
      ),
    /not loaded after scriptUrl/,
  );
});

test('bindFromInit binds a loaded class', () => {
  class LoadedGrid extends SharedResource {}
  const schema = { n: Int32Array };
  const sab = new SharedArrayBuffer(SharedResource.getBufferSize(schema));
  SharedResource.bindFromInit(
    [{ name: 'LoadedGrid', sab, schema, scriptUrl: '/loaded.js' }],
    { LoadedGrid },
  );
  LoadedGrid.n[0] = 9;
  assert.equal(LoadedGrid.n[0], 9);
  SharedResource.resetAll();
});
