/**
 * The Predator frame fixture's parser, browser-safe (predatorFixture.mjs reads the file in Node; a Chrome kernel
 * module fetches it): u32 header byte length, UTF-8 JSON header, then each array's bytes in header order.
 */

const TYPES = { Float32Array, Uint8Array, Uint16Array, Uint32Array, Int32Array };

/**
 * @param {Uint8Array} bytes the whole file
 * @returns {{ meta: object, arrays: Record<string, ArrayBufferView> }}
 */
export function parsePredatorFixture(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLen)).replace(/\0+$/, ''));
  const body = bytes.subarray(4 + headerLen);
  const arrays = {};
  for (const a of header.arrays) {
    const T = TYPES[a.type];
    const n = a.length * T.BYTES_PER_ELEMENT;
    const copy = new ArrayBuffer(n);
    new Uint8Array(copy).set(body.subarray(a.offset, a.offset + n));
    arrays[a.name] = new T(copy);
  }
  const { arrays: _layout, ...meta } = header;
  return { meta, arrays };
}
