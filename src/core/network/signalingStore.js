// signalingStore.js - the key-value tree RoomSignaling writes to.
//
// One interface, two backends:
//   FirebaseStore      Firebase Realtime Database (two machines, any network)
//   LocalStorageStore  localStorage + 'storage' events (tabs of one browser, no internet)
//
// Interface (paths are '/'-separated, values JSON):
//   get(path)                  → Promise<value | null>   (a parent path returns the subtree)
//   set(path, value)           → Promise
//   update(path, fields)       → Promise                 (shallow merge into an object)
//   remove(path)               → Promise                 (the node and everything under it)
//   push(path, value)          → Promise<key>            (a new child with a unique key)
//   transaction(path, fn)      → Promise<{ committed }>  (fn(current) → next, or undefined to abort)
//   onValue(path, cb)          → unsubscribe             (cb(value | null), now and on change)
//   onChildAdded(path, cb)     → unsubscribe             (cb(key, value) for every child, then new ones)
//   onChildRemoved(path, cb)   → unsubscribe             (cb(key))
//   removeOnDisconnect(path)   → Promise                 (removed when this peer goes away)
//   close()

const FIREBASE_SDK_VERSION = '10.8.0';
const FIREBASE_CDN = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;

// -----------------------------------------------------------------------------
// Firebase
// -----------------------------------------------------------------------------

/**
 * Firebase Realtime Database. The SDK is imported from gstatic the first time a
 * store connects, so nothing loads it unless a game asks for Firebase signaling.
 */
export class FirebaseStore {
  /** @param {object} firebaseConfig - the project's web config (apiKey, databaseURL, …) */
  constructor(firebaseConfig) {
    if (!firebaseConfig || !firebaseConfig.databaseURL) {
      throw new Error('FirebaseStore: the Firebase config needs a databaseURL (Realtime Database)');
    }
    this.config = firebaseConfig;
    this.sdk = null;
    this.db = null;
  }

  async connect() {
    if (this.db) return;
    const [app, database] = await Promise.all([
      import(/* webpackIgnore: true */ `${FIREBASE_CDN}/firebase-app.js`),
      import(/* webpackIgnore: true */ `${FIREBASE_CDN}/firebase-database.js`),
    ]);
    const existing = app
      .getApps()
      .find((a) => a.options && a.options.databaseURL === this.config.databaseURL);
    const fbApp = existing || app.initializeApp(this.config, `weed-net-${app.getApps().length}`);
    this.sdk = database;
    this.db = database.getDatabase(fbApp);
  }

  _ref(path) {
    return this.sdk.ref(this.db, path);
  }

  async get(path) {
    const snap = await this.sdk.get(this._ref(path));
    return snap.exists() ? snap.val() : null;
  }

  set(path, value) {
    return this.sdk.set(this._ref(path), value);
  }

  update(path, fields) {
    return this.sdk.update(this._ref(path), fields);
  }

  remove(path) {
    return this.sdk.remove(this._ref(path));
  }

  async push(path, value) {
    const ref = this.sdk.push(this._ref(path));
    await this.sdk.set(ref, value);
    return ref.key;
  }

  async transaction(path, fn) {
    const tx = await this.sdk.runTransaction(this._ref(path), (current) => fn(current));
    return { committed: tx.committed };
  }

  onValue(path, cb) {
    return this.sdk.onValue(this._ref(path), (snap) => cb(snap.exists() ? snap.val() : null));
  }

  onChildAdded(path, cb) {
    return this.sdk.onChildAdded(this._ref(path), (snap) => cb(snap.key, snap.val()));
  }

  onChildRemoved(path, cb) {
    return this.sdk.onChildRemoved(this._ref(path), (snap) => cb(snap.key));
  }

  removeOnDisconnect(path) {
    return this.sdk.onDisconnect(this._ref(path)).remove();
  }

  close() {}
}

// -----------------------------------------------------------------------------
// localStorage (one browser, many tabs)
// -----------------------------------------------------------------------------

const LOCAL_PREFIX = 'weed-net:';
/** A presence-like node written with removeOnDisconnect is refreshed this often. */
const HEARTBEAT_MS = 1000;
/** …and treated as gone when its heartbeat is older than this. */
const STALE_MS = 4000;

let localPushCounter = 0;

/**
 * Tabs of one browser on one machine: the store is localStorage, change
 * notifications are the 'storage' event other tabs receive, plus a direct call
 * for this tab's own writes. For development and tests, not for players.
 *
 * Nodes registered with removeOnDisconnect carry a heartbeat; a tab that closed
 * without cleaning up (crash, killed process) disappears after STALE_MS.
 */
export class LocalStorageStore {
  /**
   * @param {{ storage?: Storage, eventTarget?: EventTarget, now?: () => number }} [options]
   *   storage / eventTarget / now are injectable for Node tests.
   */
  constructor(options = {}) {
    this.storage = options.storage || globalThis.localStorage;
    this.eventTarget = options.eventTarget || (typeof window !== 'undefined' ? window : null);
    this.now = options.now || (() => Date.now());
    if (!this.storage) throw new Error('LocalStorageStore: localStorage is not available here');

    /** @type {Set<{ kind: string, path: string, cb: Function, last: string|Set<string>|null }>} */
    this.watchers = new Set();
    /** @type {Set<string>} paths this tab keeps alive and removes when it goes away */
    this.owned = new Set();
    this.notifyQueued = false;
    this.heartbeatTimer = null;
    this.sweepTimer = null;

    this._onStorage = (e) => {
      if (e.key === null || (typeof e.key === 'string' && e.key.startsWith(LOCAL_PREFIX)))
        this._queueNotify();
    };
    this._onPageHide = () => this._removeOwned();
    if (this.eventTarget) {
      this.eventTarget.addEventListener('storage', this._onStorage);
      this.eventTarget.addEventListener('pagehide', this._onPageHide);
    }
  }

  async connect() {
    if (this.sweepTimer) return;
    // Stale heartbeats are swept by whoever is watching, so a dead tab's presence goes away.
    this.sweepTimer = setInterval(() => this._sweepStale(), HEARTBEAT_MS);
  }

  // --- keys -------------------------------------------------------------------

  _key(path) {
    return LOCAL_PREFIX + trimPath(path);
  }

  _keys() {
    const out = [];
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i);
      if (k && k.startsWith(LOCAL_PREFIX)) out.push(k);
    }
    return out;
  }

  _read(key) {
    const raw = this.storage.getItem(key);
    if (raw === null) return undefined;
    try {
      const rec = JSON.parse(raw);
      if (rec && typeof rec === 'object' && 'v' in rec) {
        if (rec.hb && this.now() - rec.hb > STALE_MS) return undefined;
        return rec.v;
      }
    } catch {
      // not ours
    }
    return undefined;
  }

  _write(key, value, heartbeat) {
    const rec = heartbeat ? { v: value, hb: this.now() } : { v: value };
    this.storage.setItem(key, JSON.stringify(rec));
  }

  /** Synchronous read: the exact node, or the subtree assembled from its descendants. */
  _getSync(path) {
    const key = this._key(path);
    const exact = this._read(key);
    if (exact !== undefined) return exact;
    const prefix = key + '/';
    let tree = null;
    for (const k of this._keys()) {
      if (!k.startsWith(prefix)) continue;
      const value = this._read(k);
      if (value === undefined) continue;
      const parts = k.slice(prefix.length).split('/');
      tree = tree || {};
      let node = tree;
      for (let i = 0; i < parts.length - 1; i++) {
        if (node[parts[i]] === null || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
        node = node[parts[i]];
      }
      node[parts[parts.length - 1]] = value;
    }
    return tree;
  }

  _childKeys(path) {
    const prefix = this._key(path) + '/';
    const out = new Set();
    for (const k of this._keys()) {
      if (!k.startsWith(prefix)) continue;
      if (this._read(k) === undefined) continue;
      out.add(k.slice(prefix.length).split('/')[0]);
    }
    return out;
  }

  _removeSync(path) {
    const key = this._key(path);
    const prefix = key + '/';
    for (const k of this._keys()) {
      if (k === key || k.startsWith(prefix)) this.storage.removeItem(k);
    }
  }

  // --- interface --------------------------------------------------------------

  async get(path) {
    return this._getSync(path);
  }

  async set(path, value) {
    this._removeSync(path);
    if (value !== null && value !== undefined) {
      this._write(this._key(path), value, this.owned.has(trimPath(path)));
    }
    this._queueNotify();
  }

  async update(path, fields) {
    const current = this._getSync(path);
    const next = current && typeof current === 'object' ? { ...current, ...fields } : { ...fields };
    await this.set(path, next);
  }

  async remove(path) {
    this.owned.delete(trimPath(path));
    this._removeSync(path);
    this._queueNotify();
  }

  async push(path, value) {
    localPushCounter = (localPushCounter + 1) % 1e6;
    const key = `${this.now().toString(36)}-${localPushCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await this.set(`${trimPath(path)}/${key}`, value);
    return key;
  }

  async transaction(path, fn) {
    // localStorage is synchronous inside a tab; two tabs racing in the same
    // millisecond is the only gap, and a dev tool can live with it.
    const next = fn(this._getSync(path));
    if (next === undefined) return { committed: false };
    await this.set(path, next);
    return { committed: true };
  }

  onValue(path, cb) {
    const w = { kind: 'value', path: trimPath(path), cb, last: null };
    w.last = JSON.stringify(this._getSync(w.path));
    this.watchers.add(w);
    cb(JSON.parse(w.last));
    return () => this.watchers.delete(w);
  }

  onChildAdded(path, cb) {
    const w = { kind: 'added', path: trimPath(path), cb, last: new Set() };
    this.watchers.add(w);
    this._fireChildren(w);
    return () => this.watchers.delete(w);
  }

  onChildRemoved(path, cb) {
    const w = { kind: 'removed', path: trimPath(path), cb, last: this._childKeys(path) };
    this.watchers.add(w);
    return () => this.watchers.delete(w);
  }

  async removeOnDisconnect(path) {
    const p = trimPath(path);
    this.owned.add(p);
    const value = this._read(this._key(p));
    if (value !== undefined) this._write(this._key(p), value, true);
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this._heartbeat(), HEARTBEAT_MS);
    }
  }

  close() {
    this._removeOwned();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.heartbeatTimer = null;
    this.sweepTimer = null;
    this.watchers.clear();
    if (this.eventTarget) {
      this.eventTarget.removeEventListener('storage', this._onStorage);
      this.eventTarget.removeEventListener('pagehide', this._onPageHide);
    }
  }

  // --- internals --------------------------------------------------------------

  _heartbeat() {
    for (const p of this.owned) {
      const value = this._read(this._key(p));
      if (value !== undefined) this._write(this._key(p), value, true);
    }
  }

  _sweepStale() {
    let removed = false;
    for (const k of this._keys()) {
      const raw = this.storage.getItem(k);
      try {
        const rec = JSON.parse(raw);
        if (rec && rec.hb && this.now() - rec.hb > STALE_MS) {
          this.storage.removeItem(k);
          removed = true;
        }
      } catch {
        // not ours
      }
    }
    if (removed) this._queueNotify();
  }

  _removeOwned() {
    if (this.owned.size === 0) return;
    for (const p of this.owned) this._removeSync(p);
    this.owned.clear();
    this._queueNotify();
  }

  _queueNotify() {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      this._notify();
    });
  }

  _fireChildren(w) {
    const keys = this._childKeys(w.path);
    for (const k of keys) {
      if (w.last.has(k)) continue;
      w.last.add(k);
      w.cb(k, this._getSync(`${w.path}/${k}`));
    }
    for (const k of [...w.last]) if (!keys.has(k)) w.last.delete(k);
  }

  _notify() {
    for (const w of [...this.watchers]) {
      if (!this.watchers.has(w)) continue;
      if (w.kind === 'value') {
        const now = JSON.stringify(this._getSync(w.path));
        if (now !== w.last) {
          w.last = now;
          w.cb(JSON.parse(now));
        }
      } else if (w.kind === 'added') {
        this._fireChildren(w);
      } else {
        const keys = this._childKeys(w.path);
        for (const k of w.last) if (!keys.has(k)) w.cb(k);
        w.last = keys;
      }
    }
  }
}

function trimPath(path) {
  return String(path).replace(/^\/+|\/+$/g, '');
}
