// netProtocol.js - wire constants, message framing and room codes for Network.
//
// Every packet starts with one byte, its type. Types 0–15 belong to the engine,
// 16–255 to the game (NET_MSG.USER_MIN and up). Pure functions over typed arrays:
// they run the same on the main thread, in a worker and in Node tests.

/** WebRTC data channels. RELIABLE: ordered, retransmitted. FAST: unordered, no retransmits. */
export const NET_CHANNEL = Object.freeze({
  RELIABLE: 0,
  FAST: 1,
});

/** First byte of every packet. */
export const NET_MSG = Object.freeze({
  /** u8 nameLength, name (UTF-8), JSON body (UTF-8). Reliable channel. */
  JSON: 0,
  /** f64 sender epoch ms. Fast channel. */
  PING: 1,
  /** f64 echoed epoch ms. Fast channel. */
  PONG: 2,
  /** Pose snapshot (poseSnapshot.js). Fast channel. */
  POSES: 3,
  /** First type a game may use. */
  USER_MIN: 16,
});

/** Bumped when the framing of an engine message changes. Sent in the hello message. */
export const NET_PROTOCOL_VERSION = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Frame a named JSON message: [NET_MSG.JSON][nameLength][name][json].
 * @param {string} name - 1–255 bytes of UTF-8
 * @param {unknown} data - anything JSON.stringify accepts (undefined becomes null)
 * @returns {Uint8Array}
 */
export function encodeJsonMessage(name, data) {
  const nameBytes = encoder.encode(String(name));
  if (nameBytes.length === 0 || nameBytes.length > 255) {
    throw new RangeError(`Network message name must be 1–255 bytes: "${name}"`);
  }
  const body = encoder.encode(JSON.stringify(data === undefined ? null : data));
  const out = new Uint8Array(2 + nameBytes.length + body.length);
  out[0] = NET_MSG.JSON;
  out[1] = nameBytes.length;
  out.set(nameBytes, 2);
  out.set(body, 2 + nameBytes.length);
  return out;
}

/**
 * Read a frame written by encodeJsonMessage.
 * @param {Uint8Array} bytes
 * @returns {{ name: string, data: unknown } | null} null when the frame is malformed
 */
export function decodeJsonMessage(bytes) {
  if (bytes.length < 2 || bytes[0] !== NET_MSG.JSON) return null;
  const nameLength = bytes[1];
  if (nameLength === 0 || 2 + nameLength > bytes.length) return null;
  const name = decoder.decode(bytes.subarray(2, 2 + nameLength));
  try {
    return { name, data: JSON.parse(decoder.decode(bytes.subarray(2 + nameLength))) };
  } catch {
    return null;
  }
}

/** A ping or pong: [type][f64 time]. */
export function encodeTimeMessage(type, timeMs) {
  const buf = new ArrayBuffer(9);
  const view = new DataView(buf);
  view.setUint8(0, type);
  view.setFloat64(1, timeMs, true);
  return new Uint8Array(buf);
}

/** Epoch milliseconds, comparable across the main thread and workers. */
export function netNow() {
  return performance.timeOrigin + performance.now();
}

// -----------------------------------------------------------------------------
// Room codes
// -----------------------------------------------------------------------------

/** No 0/O, 1/I/L: a code read aloud or from a phone survives. 31 symbols. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** 8 symbols ≈ 2^39.6 codes. Shown as XXXX-XXXX. */
export const ROOM_CODE_LENGTH = 8;

/**
 * A new random room code, formatted XXXX-XXXX.
 * @param {(bytes: Uint8Array) => Uint8Array} [fillRandom] - defaults to crypto.getRandomValues
 */
export function generateRoomCode(fillRandom) {
  const fill = fillRandom || ((b) => crypto.getRandomValues(b));
  const n = ROOM_CODE_ALPHABET.length;
  // Rejection sampling: 256 is not a multiple of 31, so drop bytes ≥ 248 (= 8·31).
  const limit = 256 - (256 % n);
  let code = '';
  const bytes = new Uint8Array(16);
  while (code.length < ROOM_CODE_LENGTH) {
    fill(bytes);
    for (let i = 0; i < bytes.length && code.length < ROOM_CODE_LENGTH; i++) {
      if (bytes[i] < limit) code += ROOM_CODE_ALPHABET[bytes[i] % n];
    }
  }
  return formatRoomCode(code);
}

/**
 * Canonical form of what a person typed or pasted: upper case, separators and
 * spaces removed. Look-alikes are not guessed: O, 0, I, 1 and L are not in the
 * alphabet, so a code holding one is invalid. Returns '' when it is not a valid code.
 * @param {string} input
 */
export function normalizeRoomCode(input) {
  if (typeof input !== 'string') return '';
  const raw = input.toUpperCase().replace(/[\s\-_.]/g, '');
  if (raw.length !== ROOM_CODE_LENGTH) return '';
  for (let i = 0; i < raw.length; i++) {
    if (ROOM_CODE_ALPHABET.indexOf(raw[i]) < 0) return '';
  }
  return raw;
}

/** XXXXXXXX → XXXX-XXXX (normalizes first; '' when invalid). */
export function formatRoomCode(input) {
  const raw = normalizeRoomCode(input);
  if (!raw) return '';
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
