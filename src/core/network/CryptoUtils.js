/**
 * AES-GCM-256 helpers for encrypting WebRTC signaling payloads stored in Firebase.
 * Both peers derive the same key from the room name via PBKDF2, so SDP/ICE data
 * stored in Firebase is opaque to third parties.
 */

const SALT = new TextEncoder().encode('weedjs-signal-salt-v1');
const ITERATIONS = 100_000;

/**
 * Derives an AES-GCM-256 CryptoKey from a room name using PBKDF2-SHA-256.
 * @param {string} roomName
 * @returns {Promise<CryptoKey>}
 */
export async function deriveRoomKey(roomName) {
  const raw = new TextEncoder().encode(roomName);
  const keyMaterial = await crypto.subtle.importKey(
    'raw', raw, 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: SALT, iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts any JSON-serialisable value.
 * @param {CryptoKey} key
 * @param {*} value
 * @returns {Promise<{iv: string, ct: string}>} base64-encoded ciphertext safe for Firebase
 */
export async function encryptVal(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    iv: btoa(String.fromCharCode(...iv)),
    ct: btoa(String.fromCharCode(...new Uint8Array(ct))),
  };
}

/**
 * Decrypts a {iv, ct} payload produced by encryptVal.
 * @param {CryptoKey} key
 * @param {{iv: string, ct: string}} payload
 * @returns {Promise<*>}
 */
export async function decryptVal(key, { iv, ct }) {
  const ivBytes = Uint8Array.from(atob(iv), c => c.charCodeAt(0));
  const ctBytes = Uint8Array.from(atob(ct), c => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, key, ctBytes);
  return JSON.parse(new TextDecoder().decode(plain));
}
