/**
 * The file format of a shadow stamp capture (E-160): captureStampInputs.mjs writes it, shadowStampReplayKernel.mjs
 * reads it. Browser-safe (no node: imports), so chromeKernel.mjs can replay a capture in Chrome.
 *
 * Layout: "STC1", a uint32 header length, the header (JSON, UTF-8), zero padding to 8 bytes, then the arrays,
 * each at an 8-byte-aligned offset from there. The header holds `meta` and one entry per frame: the call's
 * scalars and, under `arrays`, each array as [offset, byteLength, type].
 */

const MAGIC = 'STC1';
const TYPES = { f32: Float32Array, f64: Float64Array, u16: Uint16Array };
const TYPE_OF = new Map(Object.entries(TYPES).map(([k, v]) => [v, k]));
/** The arrays of a frame, in file order. */
export const STAMP_CAPTURE_ARRAYS = ['sun', 'lights', 'stamp', 'lightIdx'];

const align8 = (n) => (n + 7) & ~7;

/**
 * @param {{ meta: object, frames: Array<Record<string, any>> }} capture frames hold scalars and the typed arrays
 *   named in STAMP_CAPTURE_ARRAYS
 * @returns {Uint8Array}
 */
export function encodeStampCapture(capture) {
  let blob = 0;
  const frames = capture.frames.map((f) => {
    const scalars = {};
    const arrays = {};
    for (const [k, v] of Object.entries(f)) {
      if (STAMP_CAPTURE_ARRAYS.includes(k)) {
        const type = TYPE_OF.get(v.constructor);
        if (!type) throw new Error(`stampCapture: ${k} is a ${v.constructor.name}`);
        arrays[k] = [blob, v.byteLength, type];
        blob = align8(blob + v.byteLength);
      } else scalars[k] = v;
    }
    return { ...scalars, arrays };
  });
  const header = new TextEncoder().encode(JSON.stringify({ meta: capture.meta, frames }));
  const start = align8(8 + header.length);
  const out = new Uint8Array(start + blob);
  out.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(out.buffer).setUint32(4, header.length, true);
  out.set(header, 8);
  capture.frames.forEach((f, i) => {
    for (const k of STAMP_CAPTURE_ARRAYS) {
      const v = f[k];
      if (!v) continue;
      out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), start + frames[i].arrays[k][0]);
    }
  });
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @returns {{ meta: object, frames: Array<Record<string, any>> }} each frame's arrays as typed arrays (copies)
 */
export function decodeStampCapture(bytes) {
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) throw new Error('stampCapture: not a stamp capture');
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  const { meta, frames } = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)));
  const start = align8(8 + headerLength);
  return {
    meta,
    frames: frames.map(({ arrays, ...scalars }) => {
      const f = { ...scalars };
      for (const [k, [offset, byteLength, type]] of Object.entries(arrays)) {
        const T = TYPES[type];
        const at = bytes.byteOffset + start + offset;
        f[k] = new T(bytes.buffer.slice(at, at + byteLength));
      }
      return f;
    }),
  };
}
