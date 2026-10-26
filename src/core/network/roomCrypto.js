// roomCrypto.js - AES-GCM-256 for signaling payloads (SDP, ICE) kept in a shared store.
//
// Both peers derive the same key from the room code with PBKDF2, so a store that
// anyone can read (Firebase with a public API key, localStorage) sees ciphertext only.
// The data channels themselves are DTLS, encrypted by the browser. The key is only as
// strong as the room code: see docs/internal/NETWORKING_PLAN.md (NET-61).

const SALT = new TextEncoder().encode('weedjs-signal-salt-v1');
const ITERATIONS = 100_000;

/**
 * @param {string} roomCode - the normalized code (no separator)
 * @returns {Promise<CryptoKey>}
 */
export async function deriveRoomKey(roomCode) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(roomCode),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: SALT, iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromBase64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * @param {CryptoKey} key
 * @param {unknown} value - JSON-serializable
 * @returns {Promise<{ iv: string, ct: string }>}
 */
export async function encryptValue(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

/**
 * @param {CryptoKey} key
 * @param {{ iv: string, ct: string }} payload
 * @returns {Promise<unknown>}
 */
export async function decryptValue(key, payload) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(payload.iv) },
    key,
    fromBase64(payload.ct)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}
