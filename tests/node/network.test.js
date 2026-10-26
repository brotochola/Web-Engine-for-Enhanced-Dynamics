import test from 'node:test';
import assert from 'node:assert/strict';

import WEED, {
  Network,
  NET_MSG,
  generateRoomCode,
  normalizeRoomCode,
  formatRoomCode,
  writePoseSnapshot,
  readPoseSnapshot,
  poseSnapshotBytes,
  isNewerTick,
  LocalStorageStore,
} from '../../src/index.js';
import {
  decodeJsonMessage,
  encodeJsonMessage,
  ROOM_CODE_ALPHABET,
} from '../../src/core/network/netProtocol.js';
import { POSE_MAX_ENTRIES } from '../../src/core/network/poseSnapshot.js';
import { RoomSignaling } from '../../src/core/network/roomSignaling.js';

// Networking N0 (docs/internal/NETWORKING_PLAN.md): framing, room codes, the pose
// codec, and the localStorage signaling store with two tabs sharing one storage.

test('networking symbols are named exports and on WEED', () => {
  for (const [name, value] of Object.entries({
    Network,
    generateRoomCode,
    writePoseSnapshot,
    LocalStorageStore,
  })) {
    assert.equal(WEED[name], value, name);
  }
});

test('room codes: XXXX-XXXX from the alphabet, normalized from what people type', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateRoomCode();
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    for (const ch of code.replace('-', ''))
      assert.ok(ROOM_CODE_ALPHABET.includes(ch), `${ch} in ${code}`);
  }
  assert.equal(normalizeRoomCode(' k7f2-q9mx '), 'K7F2Q9MX');
  assert.equal(normalizeRoomCode('K7F2 Q9MX'), 'K7F2Q9MX');
  assert.equal(formatRoomCode('k7f2q9mx'), 'K7F2-Q9MX');
  assert.equal(normalizeRoomCode('K7F2-Q9M'), '', 'too short');
  assert.equal(normalizeRoomCode('K7F2-Q9M0'), '', '0 is not in the alphabet');
  assert.equal(normalizeRoomCode('K7F2-Q9MO'), '', 'O is not in the alphabet');
  assert.equal(normalizeRoomCode(null), '');
});

test('room codes map bytes below 248 to the alphabet and skip the rest (no modulo bias)', () => {
  const n = ROOM_CODE_ALPHABET.length;
  // 248–255 would make the first 8 symbols more likely: they must be skipped.
  const skipFirst = (bytes) => {
    for (let i = 0; i < bytes.length; i++) bytes[i] = i < 8 ? 248 + i : i - 8;
    return bytes;
  };
  assert.equal(
    generateRoomCode(skipFirst),
    `${ROOM_CODE_ALPHABET.slice(0, 4)}-${ROOM_CODE_ALPHABET.slice(4, 8)}`
  );
  // Every symbol is reachable: byte b maps to symbol b mod 31.
  for (let start = 0; start < 248; start += 8) {
    const code = generateRoomCode((bytes) => {
      for (let i = 0; i < bytes.length; i++) bytes[i] = start + i;
      return bytes;
    }).replace('-', '');
    for (let i = 0; i < 8; i++)
      assert.equal(code[i], ROOM_CODE_ALPHABET[(start + i) % n], `byte ${start + i}`);
  }
});

test('JSON messages round trip by name; malformed frames read as null', () => {
  const bytes = encodeJsonMessage('start', { seed: 7, slots: { a: 0, b: 1 } });
  assert.equal(bytes[0], NET_MSG.JSON);
  assert.deepEqual(decodeJsonMessage(bytes), {
    name: 'start',
    data: { seed: 7, slots: { a: 0, b: 1 } },
  });
  assert.deepEqual(decodeJsonMessage(encodeJsonMessage('ñandú', undefined)), {
    name: 'ñandú',
    data: null,
  });
  assert.equal(decodeJsonMessage(new Uint8Array([NET_MSG.JSON, 9, 65])), null);
  assert.equal(decodeJsonMessage(new Uint8Array([NET_MSG.PING, 1, 65, 0x7b])), null);
  assert.throws(() => encodeJsonMessage('', 1), RangeError);
  assert.throws(() => encodeJsonMessage('x'.repeat(256), 1), RangeError);
});

test('pose snapshot: written from SoA, read into arrays by netId', () => {
  const n = 5;
  const pose = { x: new Float32Array(16), y: new Float32Array(16), rotation: new Float32Array(16) };
  const vel = {
    vx: new Float32Array(16),
    vy: new Float32Array(16),
    angularVelocity: new Float32Array(16),
  };
  const indices = [3, 9, 1, 15, 4];
  const netIds = [0, 1, 2, 3, 70]; // 70 does not fit the target below
  indices.forEach((idx, k) => {
    pose.x[idx] = 100.5 + k;
    pose.y[idx] = -20.25 * k;
    pose.rotation[idx] = 0.5 * k;
    vel.vx[idx] = 10 * k;
    vel.vy[idx] = -3 * k;
    vel.angularVelocity[idx] = 0.125 * k;
  });
  const buf = new ArrayBuffer(poseSnapshotBytes(n));
  assert.equal(
    writePoseSnapshot(new DataView(buf), 0xfffffffe, netIds, indices, n, pose, vel),
    buf.byteLength
  );

  const cap = 64;
  const target = {
    x: new Float32Array(cap),
    y: new Float32Array(cap),
    rotation: new Float32Array(cap),
    vx: new Float32Array(cap),
    vy: new Float32Array(cap),
    angularVelocity: new Float32Array(cap),
    time: new Float64Array(cap),
    tick: new Uint32Array(cap),
  };
  const r = readPoseSnapshot(new DataView(buf), target, 1234.5);
  assert.deepEqual(r, { tick: 0xfffffffe, count: n });
  for (let k = 0; k < 4; k++) {
    const id = netIds[k];
    const idx = indices[k];
    assert.equal(target.x[id], pose.x[idx]);
    assert.equal(target.y[id], pose.y[idx]);
    assert.equal(target.rotation[id], pose.rotation[idx]);
    assert.equal(target.vx[id], vel.vx[idx]);
    assert.equal(target.vy[id], vel.vy[idx]);
    assert.equal(target.angularVelocity[id], vel.angularVelocity[idx]);
    assert.equal(target.time[id], 1234.5);
    assert.equal(target.tick[id], 0xfffffffe);
  }

  // Truncated packet, wrong type
  assert.equal(readPoseSnapshot(new DataView(buf, 0, buf.byteLength - 1), target, 0), null);
  const other = new Uint8Array(buf.slice(0));
  other[0] = NET_MSG.PING;
  assert.equal(readPoseSnapshot(new DataView(other.buffer), target, 0), null);
});

test('pose snapshot without velocity sends zeros; count is capped to one packet', () => {
  const pose = { x: new Float32Array([1]), y: new Float32Array([2]), rotation: null };
  const buf = new ArrayBuffer(poseSnapshotBytes(1));
  writePoseSnapshot(new DataView(buf), 1, [0], [0], 1, pose, null);
  const t = {
    x: new Float32Array(1),
    y: new Float32Array(1),
    rotation: new Float32Array([9]),
    vx: new Float32Array([9]),
    vy: new Float32Array([9]),
    angularVelocity: new Float32Array([9]),
  };
  readPoseSnapshot(new DataView(buf), t, 0);
  assert.deepEqual(
    [t.x[0], t.y[0], t.rotation[0], t.vx[0], t.vy[0], t.angularVelocity[0]],
    [1, 2, 0, 0, 0, 0]
  );
  assert.ok(poseSnapshotBytes(POSE_MAX_ENTRIES) <= 16 * 1024);
});

test('isNewerTick compares u32 ticks across the wrap', () => {
  assert.equal(isNewerTick(5, 4), true);
  assert.equal(isNewerTick(4, 5), false);
  assert.equal(isNewerTick(4, 4), false);
  assert.equal(isNewerTick(2, 0xfffffffe), true);
  assert.equal(isNewerTick(0xfffffffe, 2), false);
});

// --- localStorage store: two "tabs" share one storage --------------------------

class SharedFakeStorage {
  constructor() {
    this.map = new Map();
    this.tabs = new Set();
  }
  get length() {
    return this.map.size;
  }
  key(i) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
    this._broadcast(k);
  }
  removeItem(k) {
    if (this.map.delete(k)) this._broadcast(k);
  }
  /** Other tabs get a 'storage' event, as a browser does (never the writer itself). */
  tab() {
    const target = new EventTarget();
    target.writerDepth = 0;
    this.tabs.add(target);
    return target;
  }
  _broadcast(key) {
    for (const t of this.tabs) {
      if (t === this.writer) continue;
      const e = new Event('storage');
      e.key = key;
      t.dispatchEvent(e);
    }
  }
}

function makeTab(storage, clock) {
  const eventTarget = storage.tab();
  const store = new LocalStorageStore({ storage, eventTarget, now: () => clock.t });
  // Mark which tab is writing so its own writes do not come back as 'storage' events.
  for (const m of ['set', 'remove', 'update', 'push', 'transaction']) {
    const orig = store[m].bind(store);
    store[m] = async (...args) => {
      storage.writer = eventTarget;
      try {
        return await orig(...args);
      } finally {
        storage.writer = null;
      }
    };
  }
  return store;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('LocalStorageStore: subtree reads, push, transaction, remove', async () => {
  const storage = new SharedFakeStorage();
  const clock = { t: 1000 };
  const a = makeTab(storage, clock);
  await a.set('rooms/R/meta', { created: 1 });
  await a.set('rooms/R/presence/p1', { joinedAt: 1 });
  await a.set('rooms/R/presence/p2', { joinedAt: 2 });
  assert.deepEqual(await a.get('rooms/R/presence'), { p1: { joinedAt: 1 }, p2: { joinedAt: 2 } });
  assert.deepEqual(await a.get('rooms/R/meta'), { created: 1 });
  await a.update('rooms/R/meta', { lastUse: 5 });
  assert.deepEqual(await a.get('rooms/R/meta'), { created: 1, lastUse: 5 });
  const k1 = await a.push('rooms/R/list', 'one');
  const k2 = await a.push('rooms/R/list', 'two');
  assert.notEqual(k1, k2);
  assert.deepEqual(Object.values(await a.get('rooms/R/list')).sort(), ['one', 'two']);
  assert.deepEqual(await a.transaction('rooms/R/host', (cur) => (cur ? undefined : 'p1')), {
    committed: true,
  });
  assert.deepEqual(await a.transaction('rooms/R/host', (cur) => (cur ? undefined : 'p2')), {
    committed: false,
  });
  assert.equal(await a.get('rooms/R/host'), 'p1');
  await a.remove('rooms/R');
  assert.equal(await a.get('rooms/R'), null);
  a.close();
});

test('LocalStorageStore: another tab sees children added and removed, and values change', async () => {
  const storage = new SharedFakeStorage();
  const clock = { t: 1000 };
  const host = makeTab(storage, clock);
  const guest = makeTab(storage, clock);
  const added = [];
  const removed = [];
  const values = [];
  const offAdded = host.onChildAdded('rooms/R/presence', (k) => added.push(k));
  const offRemoved = host.onChildRemoved('rooms/R/presence', (k) => removed.push(k));
  const offValue = host.onValue('rooms/R/connections/g/offer', (v) => values.push(v));

  await guest.set('rooms/R/presence/g', { joinedAt: 1 });
  await tick();
  assert.deepEqual(added, ['g']);
  await guest.set('rooms/R/connections/g/offer', { sdp: 'x' });
  await tick();
  assert.deepEqual(values, [null, { sdp: 'x' }]);
  await guest.remove('rooms/R/presence/g');
  await tick();
  assert.deepEqual(removed, ['g']);

  offAdded();
  offRemoved();
  offValue();
  host.close();
  guest.close();
});

test('LocalStorageStore: a removeOnDisconnect node goes away when its tab closes or stops beating', async () => {
  const storage = new SharedFakeStorage();
  const clock = { t: 1000 };
  const watcher = makeTab(storage, clock);
  const tabA = makeTab(storage, clock);
  const tabB = makeTab(storage, clock);
  await tabA.set('rooms/R/presence/a', { joinedAt: 1 });
  await tabA.removeOnDisconnect('rooms/R/presence/a');
  await tabB.set('rooms/R/presence/b', { joinedAt: 1 });
  await tabB.removeOnDisconnect('rooms/R/presence/b');
  assert.deepEqual(Object.keys(await watcher.get('rooms/R/presence')).sort(), ['a', 'b']);

  tabA.close(); // a clean close (pagehide)
  assert.deepEqual(Object.keys(await watcher.get('rooms/R/presence')), ['b']);

  clock.t += 10_000; // b crashed: no heartbeat for 10 s
  assert.equal(await watcher.get('rooms/R/presence'), null);
  tabB.heartbeatTimer && clearInterval(tabB.heartbeatTimer);
  tabB.close();
  watcher.close();
});

test('RoomSignaling over the local store: one host per room, a stale lock is retaken', async () => {
  const storage = new SharedFakeStorage();
  const clock = { t: 1000 };
  const a = new RoomSignaling(makeTab(storage, clock));
  const b = new RoomSignaling(makeTab(storage, clock));
  await a.enter('K7F2Q9MX', 'peerA');
  await b.enter('K7F2Q9MX', 'peerB');
  assert.equal(await a.claimHost('peerA'), true);
  assert.equal(await b.claimHost('peerB'), false);
  assert.equal(await b.liveHost(), 'peerA');

  // The host leaves without releasing the lock (its presence goes, the lock stays).
  await a.store.remove('rooms/K7F2Q9MX/presence/peerA');
  assert.equal(await b.liveHost(), null);
  assert.equal(await b.claimHost('peerB'), true);
  assert.equal(await a.liveHost(), 'peerB');

  // Encrypted offer from host b to a client, read back with the same room key.
  const seen = [];
  const off = a.watchOffer('peerA', (offer) => seen.push(offer));
  await b.sendOffer('peerA', { type: 'offer', sdp: 'v=0', offerId: '1' });
  for (let i = 0; i < 20 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, [{ type: 'offer', sdp: 'v=0', offerId: '1' }]);
  const raw = JSON.parse(storage.getItem('weed-net:rooms/K7F2Q9MX/connections/peerA/offer'));
  assert.ok(raw.v.iv && raw.v.ct && !JSON.stringify(raw).includes('v=0'), 'stored encrypted');
  off();
  a.store.close();
  b.store.close();
});

test('Network rejects a bad room code before touching the network', async () => {
  const storage = new SharedFakeStorage();
  const net = new Network({
    signaling: new LocalStorageStore({ storage, eventTarget: storage.tab() }),
  });
  await assert.rejects(() => net.join('nope'), /not a room code/);
  assert.equal(net.role, null);
  await net.destroy();
});
