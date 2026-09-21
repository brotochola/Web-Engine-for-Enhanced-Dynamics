/**
 * Local entity-id encodings for wrap tests + kernels.
 * src/ is not the source of truth here — variants stay in the bench.
 */

export const IDS = Object.freeze([0, 1, 65535, 65536, 299999]);

export function pair0(minE, maxE) {
  return ((minE & 0xffff) << 16) | (maxE & 0xffff);
}

export function unpackPair0(key, out) {
  out.a = (key >>> 16) & 0xffff;
  out.b = key & 0xffff;
  return out;
}

export function pair1(minE, maxE) {
  return minE * 4294967296 + maxE;
}

export function unpackPair1(key, out) {
  out.a = (key / 4294967296) | 0;
  out.b = key - out.a * 4294967296;
  return out;
}

export function pair3Cantor(minE, maxE) {
  return ((minE + maxE) * (minE + maxE + 1)) / 2 + maxE;
}

export function unpackPair3Cantor(key, out) {
  const w = Math.floor((Math.sqrt(8 * key + 1) - 1) / 2);
  out.b = key - (w * (w + 1)) / 2;
  out.a = w - out.b;
  return out;
}

export function pair2Store(colA, colB, i, minE, maxE) {
  colA[i] = minE;
  colB[i] = maxE;
}

export function pair2Load(colA, colB, i, out) {
  out.a = colA[i];
  out.b = colB[i];
  return out;
}

/** FL0: current 16+16 pack. links must be Uint16Array. */
export function resetFl0(top, links, count, interleave = 1) {
  let headPlusOne = 0;
  for (let offset = 0; offset < interleave; offset++) {
    for (let i = offset; i < count; i += interleave) {
      links[i] = headPlusOne;
      headPlusOne = i + 1;
    }
  }
  Atomics.store(top, 1, count);
  Atomics.store(top, 0, headPlusOne);
}

export function popFl0(top, links, startIndex = 0) {
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

export function pushFl0(top, links, index, startIndex = 0) {
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

function head64(top) {
  return new BigInt64Array(top.buffer, top.byteOffset, 1);
}

/** FL1: BigInt64 (tag<<32)|(local+1), links Uint32Array. top SAB ≥ 16 bytes. */
export function resetFl1(top, links, count, interleave = 1) {
  const h = head64(top);
  let headPlusOne = 0;
  for (let offset = 0; offset < interleave; offset++) {
    for (let i = offset; i < count; i += interleave) {
      links[i] = headPlusOne;
      headPlusOne = i + 1;
    }
  }
  Atomics.store(top, 2, count);
  Atomics.store(h, 0, BigInt(headPlusOne));
}

export function popFl1(top, links, startIndex = 0) {
  const h = head64(top);
  for (;;) {
    const packed = Atomics.load(h, 0);
    const plusOne = Number(packed & 0xffffffffn);
    if (plusOne === 0) return -1;
    const local = plusOne - 1;
    const next = links[local] >>> 0;
    const tag = packed >> 32n;
    const nextPacked = ((tag + 1n) << 32n) | BigInt(next);
    if (Atomics.compareExchange(h, 0, packed, nextPacked) === packed) {
      Atomics.sub(top, 2, 1);
      return startIndex + local;
    }
  }
}

export function pushFl1(top, links, index, startIndex = 0) {
  const h = head64(top);
  const local = index - startIndex;
  for (;;) {
    const packed = Atomics.load(h, 0);
    links[local] = Number(packed & 0xffffffffn);
    const tag = packed >> 32n;
    const nextPacked = ((tag + 1n) << 32n) | BigInt((local + 1) >>> 0);
    if (Atomics.compareExchange(h, 0, packed, nextPacked) === packed) {
      Atomics.add(top, 2, 1);
      return;
    }
  }
}

/** FL2: CAS only on index Int32; tag is a plain store (ABA). */
export function resetFl2(indexTop, tagTop, links, count, interleave = 1) {
  let headPlusOne = 0;
  for (let offset = 0; offset < interleave; offset++) {
    for (let i = offset; i < count; i += interleave) {
      links[i] = headPlusOne;
      headPlusOne = i + 1;
    }
  }
  Atomics.store(indexTop, 1, count);
  Atomics.store(tagTop, 0, 0);
  Atomics.store(indexTop, 0, headPlusOne);
}

export function popFl2(indexTop, tagTop, links, startIndex = 0) {
  for (;;) {
    const plusOne = Atomics.load(indexTop, 0);
    if (plusOne === 0) return -1;
    const local = plusOne - 1;
    const next = links[local];
    if (Atomics.compareExchange(indexTop, 0, plusOne, next) === plusOne) {
      tagTop[0] = (tagTop[0] + 1) | 0;
      Atomics.sub(indexTop, 1, 1);
      return startIndex + local;
    }
  }
}

export function pushFl2(indexTop, tagTop, links, index, startIndex = 0) {
  const local = index - startIndex;
  for (;;) {
    const plusOne = Atomics.load(indexTop, 0);
    links[local] = plusOne;
    if (Atomics.compareExchange(indexTop, 0, plusOne, local + 1) === plusOne) {
      tagTop[0] = (tagTop[0] + 1) | 0;
      Atomics.add(indexTop, 1, 1);
      return;
    }
  }
}

/** FL3: two Int32 views on the same 8 bytes as FL1's BigInt64. */
export function resetFl3(top, links, count, interleave = 1) {
  resetFl1(top, links, count, interleave);
}

export function popFl3(top, links, startIndex = 0) {
  return popFl1(top, links, startIndex);
}

export function pushFl3(top, links, index, startIndex = 0) {
  pushFl1(top, links, index, startIndex);
}

export function writeNeighbor(data, stride, entity, slot, id) {
  data[entity * stride + 1 + slot] = id;
}

export function readNeighbor(data, stride, entity, slot) {
  return data[entity * stride + 1 + slot];
}

export function setNeighborCount(data, stride, entity, count) {
  data[entity * stride] = count;
}

export function gridCellByteSize(mec, idBytes) {
  return 4 + mec * idBytes;
}

export function gridGetBase(cellIndex, cellByteSize, idBytes) {
  const byteOffset = cellIndex * cellByteSize;
  return (byteOffset / idBytes) + (4 / idBytes);
}
