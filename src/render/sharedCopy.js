// W30: Pixi's copies out of the render-queue memory by WebAssembly memory.copy into a private memory.
//
// A batch uploads from arrays of its own, not from the shared rows (E-123: uploading from the shared memory made the
// other workers slower), so every frame Pixi copies the rows pre-render (or its own pack) wrote into them.
// TypedArray.set from a view of a shared memory copies word by word; WebAssembly's memory.copy between two memories
// (multi-memory: Chrome 120, Firefox 125) is the engine's memmove: 15 MB in 1.25 ms against 1.99 ms in Chrome 155.
// The batch's arrays then live in a private (unshared) WebAssembly.Memory, whose buffer is an ordinary ArrayBuffer
// that WebGL and WebGPU upload as before; it is made at its full size and never grown, so its views stay valid.
// Without multi-memory there is no arena and the batches keep their arrays and TypedArray.set.
//
// The module, assembled by hand (C has no syntax for a second memory):
//   (module
//     (import "env" "src" (memory 1 65536 shared))
//     (import "env" "dst" (memory 1 65536))
//     (func (export "copy") (param $dst i32) (param $src i32) (param $len i32)
//       local.get $dst local.get $src local.get $len
//       memory.copy 1 0))
const COPY_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic, version 1
  0x01, 0x07, 0x01, 0x60, 0x03, 0x7f, 0x7f, 0x7f, 0x00, // type: (i32, i32, i32) -> ()
  0x02, 0x1d, 0x02, // imports, 2
  0x03, 0x65, 0x6e, 0x76, 0x03, 0x73, 0x72, 0x63, 0x02, 0x03, 0x01, 0x80, 0x80, 0x04, // env.src: memory 1..65536, shared
  0x03, 0x65, 0x6e, 0x76, 0x03, 0x64, 0x73, 0x74, 0x02, 0x01, 0x01, 0x80, 0x80, 0x04, // env.dst: memory 1..65536
  0x03, 0x02, 0x01, 0x00, // one function of type 0
  0x07, 0x08, 0x01, 0x04, 0x63, 0x6f, 0x70, 0x79, 0x00, 0x00, // export "copy"
  0x0a, 0x0e, 0x01, 0x0c, 0x00, 0x20, 0x00, 0x20, 0x01, 0x20, 0x02, 0xfc, 0x0a, 0x01, 0x00, 0x0b, // memory.copy 1 0
]);

/** The compiled copy module, or false where the engine has no multi-memory (compiled once per worker). */
let copyModule = null;

function compiledCopyModule() {
  if (copyModule === null) {
    try {
      copyModule = new WebAssembly.Module(COPY_MODULE);
    } catch {
      copyModule = false;
    }
  }
  return copyModule;
}

/**
 * A private WebAssembly.Memory of at least `bytes`, never grown, with a bump allocator, and the copy into it from
 * `shared` (a shared WebAssembly.Memory). null without multi-memory, without `shared`, or when the memory cannot be
 * made: the caller keeps plain arrays.
 * @param {WebAssembly.Memory | null} shared
 * @param {number} bytes
 * @returns {null | { memory: WebAssembly.Memory, buffer: ArrayBuffer, source: SharedArrayBuffer,
 *   copy: (dstByte: number, srcByte: number, bytes: number) => void, f32: (length: number) => Float32Array | null }}
 */
export function createPrivateArena(shared, bytes) {
  const module = compiledCopyModule();
  if (!module || !shared || !(bytes > 0)) return null;
  const pages = Math.ceil(bytes / 65536) + 1;
  let memory;
  let copy;
  try {
    memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
    copy = new WebAssembly.Instance(module, { env: { src: shared, dst: memory } }).exports.copy;
  } catch {
    return null;
  }
  const buffer = memory.buffer;
  let top = 0;
  return {
    memory,
    buffer,
    source: shared.buffer,
    copy,
    /** A Float32Array of `length` in the arena (16-byte aligned), or null when it is full. */
    f32(length) {
      const at = (top + 15) & ~15;
      if (at + length * 4 > buffer.byteLength) return null;
      top = at + length * 4;
      return new Float32Array(buffer, at, length);
    },
  };
}
