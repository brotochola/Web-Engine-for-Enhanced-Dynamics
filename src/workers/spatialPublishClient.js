// Loads the neighbor-publish module onto the scene's shared memory.
// Candidates and poses are already stored in that memory. The module writes
// neighbor rows in place. There is no result copy.

const wasmUrl = new URL('./spatialPublish.wasm', import.meta.url);

/**
 * @param {WebAssembly.Memory} memory
 * @param {{ posByte: number, rangeByte: number, neighborByte: number, candByte: number, listByte: number }} layout
 * @param {number} workerIndex
 * @param {number} entityCount
 * @param {number} maxNeighbors
 */
export async function bindSpatialPublish(memory, layout, workerIndex, entityCount, maxNeighbors) {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`spatialPublish.wasm ${response.status}`);
  const bytes = await response.arrayBuffer();
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
