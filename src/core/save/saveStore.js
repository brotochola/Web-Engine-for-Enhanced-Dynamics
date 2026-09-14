// IndexedDB blob store + localStorage catalog for Weed save games.

const DB_NAME = 'weed-saves';
const DB_VERSION = 1;
const STORE_BLOBS = 'blobs';
const CATALOG_KEY = 'weed.save.catalog';

/**
 * @typedef {{ id: string, scene: string, savedAt: string, bytes: number, engineVersion: string, entityCount?: number, particleCount?: number }} SaveMeta
 */

function readCatalog() {
  try {
    const raw = localStorage.getItem(CATALOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCatalog(entries) {
  localStorage.setItem(CATALOG_KEY, JSON.stringify(entries));
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS);
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

function idbReq(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class SaveStore {
  /**
   * @returns {Promise<SaveMeta[]>}
   */
  static async list() {
    return readCatalog().slice().sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  }

  /**
   * @param {string} sceneName
   * @returns {Promise<SaveMeta[]>}
   */
  static async listForScene(sceneName) {
    const all = await this.list();
    return all.filter((m) => m.scene === sceneName);
  }

  /**
   * @param {string} slotId
   * @param {Uint8Array|ArrayBuffer} blob
   * @param {Omit<SaveMeta, 'id'|'bytes'> & { id?: string, bytes?: number }} meta
   * @returns {Promise<SaveMeta>}
   */
  static async put(slotId, blob, meta) {
    const bytes =
      blob instanceof Uint8Array ? blob : new Uint8Array(blob);
    const entry = {
      id: slotId,
      scene: meta.scene,
      savedAt: meta.savedAt || new Date().toISOString(),
      bytes: bytes.byteLength,
      engineVersion: meta.engineVersion || '',
      entityCount: meta.entityCount | 0,
      particleCount: meta.particleCount | 0,
    };

    const db = await openDb();
    try {
      const tx = db.transaction(STORE_BLOBS, 'readwrite');
      await idbReq(tx.objectStore(STORE_BLOBS).put(bytes, slotId));
    } finally {
      db.close();
    }

    const catalog = readCatalog().filter((m) => m.id !== slotId);
    catalog.push(entry);
    writeCatalog(catalog);
    return entry;
  }

  /**
   * @param {string} slotId
   * @returns {Promise<Uint8Array|null>}
   */
  static async get(slotId) {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE_BLOBS, 'readonly');
      const result = await idbReq(tx.objectStore(STORE_BLOBS).get(slotId));
      if (!result) return null;
      return result instanceof Uint8Array ? result : new Uint8Array(result);
    } finally {
      db.close();
    }
  }

  /**
   * @param {string} slotId
   * @returns {Promise<SaveMeta|null>}
   */
  static async getMeta(slotId) {
    return readCatalog().find((m) => m.id === slotId) || null;
  }

  /**
   * @param {string} slotId
   * @returns {Promise<void>}
   */
  static async remove(slotId) {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE_BLOBS, 'readwrite');
      await idbReq(tx.objectStore(STORE_BLOBS).delete(slotId));
    } finally {
      db.close();
    }
    writeCatalog(readCatalog().filter((m) => m.id !== slotId));
  }

  /**
   * @param {Uint8Array|Blob} blob
   * @param {string} [filename]
   */
  static downloadSave(blob, filename = 'game.weedsave') {
    const file =
      blob instanceof Blob ? blob : new Blob([blob], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * @param {File|Blob} file
   * @returns {Promise<Uint8Array>}
   */
  static async parseUploadedFile(file) {
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }
}
