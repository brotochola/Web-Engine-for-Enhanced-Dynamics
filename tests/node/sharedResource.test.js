import test from 'node:test';
import assert from 'node:assert/strict';

import { SharedResource, SharedResourceMailbox } from '../../src/core/sharedResource.js';

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
    mail: { type: Int32Array, mailbox: true },
  });
  assert.deepEqual(packed.flags, { type: 'Uint8Array', length: 32 });
  assert.deepEqual(packed.score, { type: 'Int32Array', length: 1 });
  assert.deepEqual(packed.mail, { type: 'Int32Array', length: 1, atomic: true });
  assert.equal('atomic' in packed.flags, false);
  assert.equal('atomic' in packed.score, false);

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

test('bindFromInit throws when class is missing', () => {
  assert.throws(
    () => SharedResource.bindFromInit([{ name: 'MissingGrid', schema: { n: Int32Array } }], {}),
    /class MissingGrid not loaded/,
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

test('atomic:true on Float32Array throws', () => {
  const schema = { cells: { type: Float32Array, length: 4, atomic: true } };
  assert.throws(() => SharedResource.serializeSchema(schema), {
    name: 'TypeError',
    message: /field "cells" atomic:true/,
  });
  assert.throws(() => SharedResource.getBufferSize(schema), {
    name: 'TypeError',
    message: /field "cells" atomic:true/,
  });
});

test('atomic:true on Uint8ClampedArray throws', () => {
  assert.throws(
    () => SharedResource.getBufferSize({ pix: { type: Uint8ClampedArray, atomic: true } }),
    /field "pix" atomic:true/,
  );
});

test('two class views add the same mailbox', () => {
  class MailA extends SharedResource {}
  class MailB extends SharedResource {}
  const schema = { score: { type: Int32Array, atomic: true } };
  const sab = new SharedArrayBuffer(SharedResource.getBufferSize(schema));
  MailA.initialize(sab, schema);
  MailB.initialize(sab, schema);

  assert.ok(MailA.score instanceof SharedResourceMailbox);
  assert.equal(MailA.score.add(3), 0);
  assert.equal(MailB.score.add(4), 3);
  assert.equal(MailA.score.load(), 7);
  MailB.score.store(11);
  assert.equal(MailA.score.view[0], 11);
  assert.equal(MailA.score.exchange(0), 11);
  assert.equal(MailB.score.load(), 0);
  assert.equal(MailA.score.compareExchange(0, 5), 0);
  assert.equal(MailB.score.load(), 5);
  assert.equal(MailA.score.compareExchange(0, 9), 5);
  assert.equal(MailB.score.load(), 5);

  SharedResource.resetAll();
});

test('mailbox:true is the same as atomic:true', () => {
  class Slots extends SharedResource {}
  const schema = { lives: { type: Uint32Array, length: 10, mailbox: true } };
  Slots.initialize(new SharedArrayBuffer(SharedResource.getBufferSize(schema)), schema);
  assert.equal(Slots.lives.length, 10);
  assert.equal(Slots.lives.add(2, 3), 0);
  assert.equal(Slots.lives.load(3), 2);
  SharedResource.resetAll();
});

test('unmarked Int32Array is a typed array, not a mailbox', () => {
  class Plain extends SharedResource {}
  const schema = { score: Int32Array };
  const sab = new SharedArrayBuffer(SharedResource.getBufferSize(schema));
  Plain.initialize(sab, schema);
  assert.equal(Plain.score instanceof SharedResourceMailbox, false);
  assert.equal(Plain.score instanceof Int32Array, true);
  Plain.score[0] = 2;
  assert.equal(Plain.score[0], 2);
  SharedResource.resetAll();
});
