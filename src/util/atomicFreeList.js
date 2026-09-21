// atomicFreeList.js - Lock-free MPMC free list (Treiber stack with ABA tag)
//
// Two concrete APIs. Hot pop/push never branches on array type.
//
// Slots (particles, decorations, bullets, joint/fixture pools): Uint16 links,
// head Int32 (tag << 16) | (local+1). SharedAtomicPool calls popU16 / pushU16.
//
// Entities: popEntity / pushEntity / resetEntity, bound once in bindEntityIdWidth.
// Width 16 uses the same u16 Treiber. Width 32 uses FL4: one Int32 CAS,
// 19-bit (local+1) + 13-bit tag. Product ceiling 300000 fits in 19 index bits.
// Tag window is 8192 ops.
//
// top u16: Int32Array[2] over 8 bytes. [0]=packed head, [1]=free count.
// top u32: Int32Array[4] over 16 bytes. [0]=FL4 head, [2]=free count.
// links: next = (localIndex + 1), 0 = end. Values are LOCAL.

const FL4_INDEX_BITS = 19;
const FL4_INDEX_MASK = (1 << FL4_INDEX_BITS) - 1;
const FL4_TAG_MASK = 0x1fff;

function chainLinks(links, count, interleaveFactor) {
  let headPlusOne = 0;
  for (let offset = 0; offset < interleaveFactor; offset++) {
    for (let i = offset; i < count; i += interleaveFactor) {
      links[i] = headPlusOne;
      headPlusOne = i + 1;
    }
  }
  return headPlusOne;
}

export function resetU16(top, links, count, interleaveFactor = 8) {
  const headPlusOne = chainLinks(links, count, interleaveFactor);
  Atomics.store(top, 1, count);
  Atomics.store(top, 0, headPlusOne);
}

export function popU16(top, links, startIndex = 0) {
  for (;;) {
    const head = Atomics.load(top, 0);
    const plusOne = head & 0xffff;
    if (plusOne === 0) return -1;
    const local = plusOne - 1;
    const next = links[local];
    const newHead = ((head + 0x10000) & ~0xffff) | next;
    if (Atomics.compareExchange(top, 0, head, newHead) === head) {
      Atomics.sub(top, 1, 1);
      return startIndex + local;
    }
  }
}

export function popIndicesU16(top, links, maxToPop, outArray, outOffset = 0, startIndex = 0) {
  if (maxToPop <= 0) return 0;
  for (;;) {
    const head = Atomics.load(top, 0);
    let plusOne = head & 0xffff;
    if (plusOne === 0) return 0;
    let popped = 0;
    let cur = plusOne;
    while (cur !== 0 && popped < maxToPop) {
      outArray[outOffset + popped] = startIndex + (cur - 1);
      cur = links[cur - 1];
      popped++;
    }
    const newHead = ((head + 0x10000) & ~0xffff) | cur;
    if (Atomics.compareExchange(top, 0, head, newHead) === head) {
      Atomics.sub(top, 1, popped);
      return popped;
    }
  }
}

export function pushU16(top, links, index, startIndex = 0) {
  const local = index - startIndex;
  for (;;) {
    const head = Atomics.load(top, 0);
    links[local] = head & 0xffff;
    const newHead = ((head + 0x10000) & ~0xffff) | (local + 1);
    if (Atomics.compareExchange(top, 0, head, newHead) === head) {
      Atomics.add(top, 1, 1);
      return;
    }
  }
}

export function resetFl4(top, links, count, interleaveFactor = 8) {
  const headPlusOne = chainLinks(links, count, interleaveFactor);
  Atomics.store(top, 2, count);
  Atomics.store(top, 0, headPlusOne & FL4_INDEX_MASK);
}

export function popFl4(top, links, startIndex = 0) {
  for (;;) {
    const head = Atomics.load(top, 0);
    const plusOne = head & FL4_INDEX_MASK;
    if (plusOne === 0) return -1;
    const local = plusOne - 1;
    const next = links[local] >>> 0;
    const tag = ((head >>> FL4_INDEX_BITS) + 1) & FL4_TAG_MASK;
    const newHead = (tag << FL4_INDEX_BITS) | (next & FL4_INDEX_MASK);
    if (Atomics.compareExchange(top, 0, head, newHead) === head) {
      Atomics.sub(top, 2, 1);
      return startIndex + local;
    }
  }
}

export function popIndicesFl4(top, links, maxToPop, outArray, outOffset = 0, startIndex = 0) {
  if (maxToPop <= 0) return 0;
  for (;;) {
    const head = Atomics.load(top, 0);
    let plusOne = head & FL4_INDEX_MASK;
    if (plusOne === 0) return 0;
    let popped = 0;
    let cur = plusOne;
    while (cur !== 0 && popped < maxToPop) {
      outArray[outOffset + popped] = startIndex + (cur - 1);
      cur = links[cur - 1] >>> 0;
      popped++;
    }
    const tag = ((head >>> FL4_INDEX_BITS) + 1) & FL4_TAG_MASK;
    const newHead = (tag << FL4_INDEX_BITS) | (cur & FL4_INDEX_MASK);
    if (Atomics.compareExchange(top, 0, head, newHead) === head) {
      Atomics.sub(top, 2, popped);
      return popped;
    }
  }
}

export function pushFl4(top, links, index, startIndex = 0) {
  const local = index - startIndex;
  for (;;) {
    const head = Atomics.load(top, 0);
    links[local] = head & FL4_INDEX_MASK;
    const tag = ((head >>> FL4_INDEX_BITS) + 1) & FL4_TAG_MASK;
    const newHead = (tag << FL4_INDEX_BITS) | ((local + 1) & FL4_INDEX_MASK);
    if (Atomics.compareExchange(top, 0, head, newHead) === head) {
      Atomics.add(top, 2, 1);
      return;
    }
  }
}

/** Entity pools. Rebound by bindEntityFreeList. Default matches width 16. */
export let popEntity = popU16;
export let pushEntity = pushU16;
export let popEntities = popIndicesU16;
export let resetEntity = resetU16;

export function bindEntityFreeList(width32) {
  if (width32) {
    popEntity = popFl4;
    pushEntity = pushFl4;
    popEntities = popIndicesFl4;
    resetEntity = resetFl4;
  } else {
    popEntity = popU16;
    pushEntity = pushU16;
    popEntities = popIndicesU16;
    resetEntity = resetU16;
  }
}

/**
 * Init / tests only. Branches once on element size, then the concrete Treiber.
 * Entity spawn uses popEntity. Slot pools use popU16.
 */
export function resetFreeList(top, links, count, interleaveFactor = 8) {
  if (links.BYTES_PER_ELEMENT === 4) resetFl4(top, links, count, interleaveFactor);
  else resetU16(top, links, count, interleaveFactor);
}

export function popFreeIndex(top, links, startIndex = 0) {
  if (links.BYTES_PER_ELEMENT === 4) return popFl4(top, links, startIndex);
  return popU16(top, links, startIndex);
}

export function popFreeIndices(top, links, maxToPop, outArray, outOffset = 0, startIndex = 0) {
  if (links.BYTES_PER_ELEMENT === 4) {
    return popIndicesFl4(top, links, maxToPop, outArray, outOffset, startIndex);
  }
  return popIndicesU16(top, links, maxToPop, outArray, outOffset, startIndex);
}

export function pushFreeIndex(top, links, index, startIndex = 0) {
  if (links.BYTES_PER_ELEMENT === 4) pushFl4(top, links, index, startIndex);
  else pushU16(top, links, index, startIndex);
}

export function getFreeListCount(top) {
  return Atomics.load(top, top.length >= 3 ? 2 : 1);
}
