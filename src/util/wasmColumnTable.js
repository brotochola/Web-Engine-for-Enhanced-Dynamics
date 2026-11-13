// A WASM kernel's column table: each slot holds the byte offset of a column (a typed array) in the kernel's memory.
// The writers (collect, gather, bullet tick) fill it once a frame; this is their one step, a module function so a frame
// makes no closure (N-158: a `put` closure per writer per frame was 2 to 4 KB/s of garbage in pre-render).

/**
 * Writes column `a`'s byte offset at `slot` of table `t`, or 0 when the scene has no such column (the kernel reads 0 as
 * absent). Returns 0 when the kernel cannot run on this frame's columns: a required column is missing, or a column is
 * outside `buffer` (the kernel's memory); 1 otherwise. Writers fold it with `ok &= putColumn(...)`.
 * @param {Uint32Array} t
 * @param {number} slot
 * @param {ArrayBufferView|null|undefined} a
 * @param {boolean} required
 * @param {ArrayBufferLike} buffer
 * @returns {0|1}
 */
export function putColumn(t, slot, a, required, buffer) {
  if (!a) {
    t[slot] = 0;
    return required ? 0 : 1;
  }
  if (a.buffer === buffer) {
    t[slot] = a.byteOffset;
    return 1;
  }
  return 0;
}
