// Loads the neighbor-publish module onto the scene's shared memory.
// Candidates and poses are already stored in that memory. The module writes
// neighbor rows in place. There is no result copy.

const wasmUrl = new URL('./spatialPublish.wasm', import.meta.url);

function bytesFromDataUrl(href) {
  const binary = atob(href.slice(href.indexOf(',') + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function loadWasmBytes() {
  // Bundle embed rewrites this asset to a data URL. A blob worker has no
  // directory, so a relative wasm path cannot be fetched.
  const href = String(wasmUrl);
  if (href.startsWith('data:')) return bytesFromDataUrl(href);
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`spatialPublish.wasm ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * @param {WebAssembly.Memory} memory
 * @param {{ posByte: number, rangeByte: number, neighborByte: number, candByte: number, listByte: number }} layout
 * @param {number} workerIndex
 * @param {number} entityCount
 * @param {number} maxNeighbors
 */
export async function bindSpatialPublish(memory, layout, workerIndex, entityCount, maxNeighbors) {
  const bytes = await loadWasmBytes();
  const env = new Proxy(
    { memory },
    { get: (target, prop) => (prop in target ? target[prop] : () => 0) },
  );
  const wasi = new Proxy({}, { get: () => () => 0 });
  const { instance } = await WebAssembly.instantiate(bytes, {
    env,
    wasi_snapshot_preview1: wasi,
  });
  const count = entityCount | 0;
  const stride = 1 + (maxNeighbors | 0);
  const listByte = (layout.listByte | 0) + (workerIndex | 0) * count * 2;
  const buffer = memory.buffer;
  const pub = {
    range: new Float32Array(buffer, layout.rangeByte, count),
    list: new Uint16Array(buffer, listByte, count),
    cand: new Uint16Array(buffer, layout.candByte, count * stride),
    publish: instance.exports.publish_batch,
    listByte,
    queued: 0,
  };
  return pub;
}
