// atomicFreeList.js - Lock-free MPMC free list (Treiber stack with ABA tag)
//
// Shared by ALL pool free lists in the engine (entity pools, particles,
// decorations, bullets, constraints). Any worker or the main thread can
// pop (spawn) and push (despawn) concurrently.
//
// ============================================================================
// WHY A LINKED STACK INSTEAD OF "ATOMIC COUNTER + ARRAY" ?
// ============================================================================
// The previous design used an atomic top counter over a plain index array:
//   pop:  oldTop = Atomics.sub(top); idx = freeList[oldTop - 1]   (plain read)
//   push: slot  = Atomics.add(top); freeList[slot] = idx          (plain write)
// The counter updates were atomic, but the PAYLOAD accesses were not part of
// them. A pop's read of freeList[oldTop-1] could interleave with a concurrent
// push's write to the same slot, so a thread could be handed an index that is
// still live (two entities sharing one slot) or a just-pushed index could be
// handed out twice while the original entry leaked. Concurrent failed pops on
// an exhausted pool also drove the counter negative, making concurrent pushes
// write out of bounds and leak indices.
//
// A Treiber stack avoids all of this: the only shared mutable hot state is a
// single packed head word updated by compare-exchange, and per-slot links are
// only ever written by the slot's current owner before the CAS publishes them.
//
// ============================================================================
// MEMORY LAYOUT
// ============================================================================
// top:   Int32Array[2] over an 8-byte SAB
//   [0] = packed head: (tag << 16) | (localIndex + 1). Low 16 bits 0 = empty.
//         The 16-bit tag is bumped on EVERY successful push/pop, defeating
//         ABA (a stalled CAS can only succeed if no other op landed since
//         its head load, modulo 65536 ops - astronomically unlikely).
//   [1] = free count. Eventually consistent (updated AFTER the CAS), for
//         stats / heuristics only - never used for correctness decisions.
// links: Uint16Array[poolSize] - next pointers, value = (localIndex + 1),
//        0 = end of chain. Slot values are LOCAL (0..poolSize-1); pool start
//        offsets are applied via the startIndex parameter.
//
// Indices fit u16: MAX_ENTITIES is 65535, so localIndex + 1 <= 65535.

/**
 * Reset a free list to "all free", chaining slots so that pop order matches
 * the historical array-stack order for the same interleave factor.
 *
 * INTERLEAVED ORDERING: scatter consecutive pops across the index range to
 * reduce multi-core cache-line contention (workers that spawn at the same
 * time get indices far apart). interleaveFactor = 1 gives plain sequential
 * ordering (pop yields poolSize-1, poolSize-2, ...).
 *
 * NOT thread-safe: only call while no other thread is using the list
 * (scene init / despawnAll).
 *
 * @param {Int32Array} top - Int32Array[2]: [0]=packed head, [1]=free count
 * @param {Uint16Array} links - Per-slot next pointers (length >= count)
 * @param {number} count - Number of slots in the pool
 * @param {number} [interleaveFactor=8] - Stride between consecutive pops
 */
export function resetFreeList(top, links, count, interleaveFactor = 8) {
  let headPlusOne = 0;
  // Chain in the same write order as the old array fill; each element becomes
  // the new head, so pops yield the exact same sequence as before.
  for (let offset = 0; offset < interleaveFactor; offset++) {
    for (let i = offset; i < count; i += interleaveFactor) {
      links[i] = headPlusOne;
      headPlusOne = i + 1;
    }
  }
  Atomics.store(top, 1, count);
  Atomics.store(top, 0, headPlusOne); // tag = 0
}

/**
 * Atomically pop a free index. Lock-free; safe from any thread.
 *
 * @param {Int32Array} top
 * @param {Uint16Array} links
 * @param {number} [startIndex=0] - Pool's global start offset
 * @returns {number} Global index, or -1 if the pool is exhausted
 */
export function popFreeIndex(top, links, startIndex = 0) {
  for (;;) {
    const head = Atomics.load(top, 0);
    const plusOne = head & 0xffff;
    if (plusOne === 0) return -1; // empty

    const local = plusOne - 1;
    // Plain read is safe: if this slot was popped/re-pushed since our head
    // load, the tag has advanced and the CAS below fails, discarding it.
    const next = links[local];
    const newHead = ((head + 0x10000) & ~0xffff) | next;

    if (Atomics.compareExchange(top, 0, head, newHead) === head) {
      Atomics.sub(top, 1, 1);
      return startIndex + local;
    }
    // CAS lost - another thread popped/pushed first. Retry.
  }
}

/**
 * Atomically push an index back to the free list. Lock-free; safe from any
 * thread. Caller must guarantee the index is not double-freed (pools guard
 * this with their per-slot active flags).
 *
 * @param {Int32Array} top
 * @param {Uint16Array} links
 * @param {number} index - Global index to return
 * @param {number} [startIndex=0] - Pool's global start offset
 */
export function pushFreeIndex(top, links, index, startIndex = 0) {
  const local = index - startIndex;
  for (;;) {
    const head = Atomics.load(top, 0);
    // We own `local` until the CAS publishes it, so this plain write is only
    // visible to others through the CAS (which creates the ordering edge).
    links[local] = head & 0xffff;
    const newHead = ((head + 0x10000) & ~0xffff) | (local + 1);

    if (Atomics.compareExchange(top, 0, head, newHead) === head) {
      Atomics.add(top, 1, 1);
      return;
    }
  }
}

/**
 * Approximate number of free slots (eventually consistent).
 * @param {Int32Array} top
 * @returns {number}
 */
export function getFreeListCount(top) {
  return Atomics.load(top, 1);
}
