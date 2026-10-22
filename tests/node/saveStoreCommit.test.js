import test from 'node:test';
import assert from 'node:assert/strict';
import { SaveStore } from '../../src/core/save/saveStore.js';

// IndexedDB reports a request's success before its transaction commits, and a
// page that unloads in between (hot reload calls location.reload() right after
// saving) loses the write. A save must resolve only once the data is committed.

/** IndexedDB with one store: requests succeed at once, transactions commit when told. */
function installFakeIndexedDb() {
  const data = new Map();
  const open = [];
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    close() {},
    transaction() {
      const staged = new Map();
      const tx = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: null,
        objectStore() {
          const request = (apply, result) => {
            const req = { result: undefined, onsuccess: null, onerror: null };
            queueMicrotask(() => {
              apply();
              req.result = result();
              if (req.onsuccess) req.onsuccess();
            });
            return req;
          };
          return {
            put: (value, key) => request(() => staged.set(key, value), () => key),
            delete: (key) => request(() => staged.set(key, undefined), () => undefined),
            get: (key) => request(() => {}, () => data.get(key)),
          };
        },
        commit() {
          for (const [k, v] of staged) {
            if (v === undefined) data.delete(k);
            else data.set(k, v);
          }
          if (tx.oncomplete) tx.oncomplete();
        },
        abort(error) {
          tx.error = error;
          if (tx.onabort) tx.onabort();
        },
      };
      open.push(tx);
      return tx;
    },
  };
  globalThis.indexedDB = {
    open() {
      const req = { result: db, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => req.onsuccess && req.onsuccess());
      return req;
    },
  };
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  return { data, open };
}

const ticks = () => new Promise((r) => setTimeout(r, 5));

test('SaveStore.put resolves when the transaction commits, not when the request succeeds', async () => {
  const idb = installFakeIndexedDb();
  let done = false;
  const saving = SaveStore.put('slot', new Uint8Array([1, 2, 3]), { scene: 'S' }).then(() => (done = true));
  await ticks();
  assert.equal(idb.open.length, 1);
  assert.equal(done, false, 'resolved before the data was committed');
  idb.open[0].commit();
  await saving;
  assert.deepEqual([...idb.data.get('slot')], [1, 2, 3]);
  assert.equal((await SaveStore.getMeta('slot')).bytes, 3);
});

test('SaveStore.put rejects when the transaction aborts, and lists nothing', async () => {
  const idb = installFakeIndexedDb();
  const saving = SaveStore.put('lost', new Uint8Array([9]), { scene: 'S' });
  await ticks();
  idb.open[0].abort(new Error('quota'));
  await assert.rejects(saving, /quota/);
  assert.equal(await SaveStore.getMeta('lost'), null);
});

test('SaveStore.remove resolves when the delete commits', async () => {
  const idb = installFakeIndexedDb();
  const saving = SaveStore.put('slot', new Uint8Array([1]), { scene: 'S' });
  await ticks();
  idb.open[0].commit();
  await saving;
  let done = false;
  const removing = SaveStore.remove('slot').then(() => (done = true));
  await ticks();
  assert.equal(done, false);
  idb.open[1].commit();
  await removing;
  assert.equal(idb.data.has('slot'), false);
});
