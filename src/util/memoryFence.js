/**
 * N-452: a full memory barrier, for the seqlocks whose data are plain loads and stores (the camera, the sim clock, the
 * frame clock and totals). JavaScript has none, and a plain load may be satisfied after a later Atomics.load on a weakly
 * ordered CPU (ARM: phones, Apple's chips): a reader then took data of two writes as one whole. An atomic
 * read-modify-write orders everything before it with everything after it there; on x86 it costs about 20 cycles.
 *
 *   writer: odd mark (Atomics), memoryFence(), the data, even mark (Atomics)
 *   reader: the mark, the data, memoryFence(), the mark again
 *
 * The word is each thread's own, so no line moves between cores. The physics scripts (classic, no imports) hold copies:
 * box2dMovedBodiesImpl.js, weedjsPost.js, physicsHostImpl.js.
 */
const WORD = new Int32Array(typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(4) : new ArrayBuffer(4));

export function memoryFence() {
  Atomics.add(WORD, 0, 0);
}
