/**
 * The frame format of a worker replay (replayWorker.mjs): what a worker read each frame, as the changes from the
 * frame before, so a few seconds of a scene fit a file and replay bit for bit.
 *
 * A recording is a list of columns (meta.json `columns`: name, length, bytes an element, `predict`, `masked`) and a
 * stream of frame records. A record is 8-byte aligned:
 *
 *   int32 [0] magic 'WRF1', [1] frame, [2] byte length, [3] query version,
 *         [4] physics' moved generation, [5] its count, [6] its sequence, [7] moved entries stored,
 *   f64   at byte 32 logic 0's frame number (NaN: none), at byte 40 the recorder's clock,
 *   int32 [12] column count, [13..15] 0,
 *   uint32 the moved entries, then per column: int32 mode, int32 count, its payload (padded to 4 bytes).
 *
 * Modes: SAME (no payload), SPARSE (count indices, then count values at the column's width), FULL (every element
 * XOR its prediction: the frame before, or for a `predict` float32 column the line through the two frames before).
 * A `masked` column compares only the indices the recorder lists (rotations of non-circle colliders), always SPARSE.
 *
 * createReplayEncoder runs in the recorded worker: it is sent there as its source text, so it uses only its
 * arguments and the language's globals. Both sides keep the same shadow (the last frame's values) and update it the
 * same way in every mode, so a FULL record's prediction is the decoder's too.
 */

export const REPLAY_MAGIC = 0x31465257;
export const REPLAY_HEADER_BYTES = 64;
export const MODE_SAME = 0;
export const MODE_SPARSE = 1;
export const MODE_FULL = 2;

/**
 * @param {{ name: string, length: number, bpe: 1 | 2 | 4, predict?: boolean, masked?: boolean }[]} specs
 */
export function createReplayEncoder(specs) {
  const MAGIC = 0x31465257;
  const intType = (bpe) => (bpe === 1 ? Uint8Array : bpe === 2 ? Uint16Array : Uint32Array);
  const shadow = specs.map((s) => new (intType(s.bpe))(s.length));
  const shadowF = specs.map((s, c) => (s.predict ? new Float32Array(shadow[c].buffer) : null));
  const prev2 = specs.map((s) => (s.predict ? new Float32Array(s.length) : null));
  const predF = specs.map((s) => (s.predict ? new Float32Array(s.length) : null));
  const predU = predF.map((p) => (p ? new Uint32Array(p.buffer) : null));
  let bytes = new Uint8Array(1 << 20);
  let i32 = new Int32Array(bytes.buffer);
  let at = 0;
  function ensure(more) {
    if (at + more <= bytes.length) return;
    let size = bytes.length;
    while (at + more > size) size *= 2;
    const next = new Uint8Array(size);
    next.set(bytes.subarray(0, at));
    bytes = next;
    i32 = new Int32Array(bytes.buffer);
  }
  const pad4 = (b) => (b + 3) & ~3;
  function putValues(T, src, count) {
    // at is 4-aligned; values at their width, then padding.
    const nb = count * T.BYTES_PER_ELEMENT;
    ensure(pad4(nb));
    const dst = new T(bytes.buffer, at, count);
    dst.set(src.subarray(0, count));
    at += pad4(nb);
  }
  const scratch = { idx: new Int32Array(1024) };
  const vals = { 1: new Uint8Array(1024), 2: new Uint16Array(1024), 4: new Uint32Array(1024) };
  function growScratch(n, bpe) {
    if (scratch.idx.length < n) scratch.idx = new Int32Array(Math.max(n, scratch.idx.length * 2));
    if (vals[bpe].length < n) vals[bpe] = new (intType(bpe))(Math.max(n, vals[bpe].length * 2));
  }
  return {
    specs,
    /**
     * @param {{ frame: number, queryVersion: number, movedGen: number, movedCount: number, movedSeq: number, logicFrame: number, clock: number }} h
     * @param {Uint32Array | null} moved physics' moved list (its first `movedLen` entries are stored)
     * @param {number} movedLen
     * @param {(ArrayLike<number> | null)[]} views per column: the values as unsigned integers of its width (null: all 0)
     * @param {(Int32Array | null)[]} masks per masked column: the indices to compare
     * @param {number[]} maskCounts
     * @returns {Uint8Array} the record (a copy)
     */
    encode(h, moved, movedLen, views, masks, maskCounts) {
      at = 0;
      ensure(64 + movedLen * 4);
      i32.fill(0, 0, 16);
      i32[0] = MAGIC;
      i32[1] = h.frame | 0;
      i32[3] = h.queryVersion | 0;
      i32[4] = h.movedGen | 0;
      i32[5] = h.movedCount | 0;
      i32[6] = h.movedSeq | 0;
      i32[7] = movedLen | 0;
      const dv = new DataView(bytes.buffer);
      dv.setFloat64(32, h.logicFrame, true);
      dv.setFloat64(40, h.clock, true);
      i32[12] = specs.length;
      at = 64;
      if (movedLen > 0) putValues(Uint32Array, moved, movedLen);
      for (let c = 0; c < specs.length; c++) {
        const s = specs[c];
        const len = s.length;
        const sh = shadow[c];
        const cur = views[c];
        const bpe = s.bpe;
        const T = intType(bpe);
        ensure(8);
        const head = at >> 2;
        at += 8;
        if (s.predict) {
          // The line through the two frames before, as the decoder will compute it (before the shadow moves).
          const p = predF[c];
          const sf = shadowF[c];
          const p2 = prev2[c];
          for (let i = 0; i < len; i++) p[i] = 2 * sf[i] - p2[i];
        }
        if (s.masked) {
          const list = masks[c];
          const m = maskCounts[c] | 0;
          growScratch(m, bpe);
          let k = 0;
          const v = vals[bpe];
          if (cur) {
            for (let j = 0; j < m; j++) {
              const i = list[j];
              const x = cur[i];
              if (x !== sh[i]) {
                scratch.idx[k] = i;
                v[k] = x;
                sh[i] = x;
                k++;
              }
            }
          }
          i32[head] = k === 0 ? 0 : 1;
          i32[head + 1] = k;
          if (k > 0) {
            putValues(Int32Array, scratch.idx, k);
            putValues(T, v, k);
          }
          continue;
        }
        let changed = 0;
        if (cur) {
          for (let i = 0; i < len; i++) if (cur[i] !== sh[i]) changed++;
        } else {
          for (let i = 0; i < len; i++) if (sh[i] !== 0) changed++;
        }
        if (s.predict) prev2[c].set(shadowF[c]);
        if (changed === 0) {
          i32[head] = 0;
          i32[head + 1] = 0;
          continue;
        }
        if (changed * (4 + bpe) < len * bpe) {
          growScratch(changed, bpe);
          const v = vals[bpe];
          let k = 0;
          for (let i = 0; i < len; i++) {
            const x = cur ? cur[i] : 0;
            if (x !== sh[i]) {
              scratch.idx[k] = i;
              v[k] = x;
              sh[i] = x;
              k++;
            }
          }
          i32[head] = 1;
          i32[head + 1] = k;
          putValues(Int32Array, scratch.idx, k);
          putValues(T, v, k);
          continue;
        }
        i32[head] = 2;
        i32[head + 1] = len;
        const nb = pad4(len * bpe);
        ensure(nb);
        const out = new T(bytes.buffer, at, len);
        const ref = s.predict ? predU[c] : sh;
        for (let i = 0; i < len; i++) out[i] = (cur ? cur[i] : 0) ^ ref[i];
        at += nb;
        if (cur) sh.set(cur.length === len ? cur : cur.subarray(0, len));
        else sh.fill(0);
      }
      at = (at + 7) & ~7;
      ensure(0);
      i32[2] = at;
      return bytes.slice(0, at);
    },
  };
}

/**
 * The replay's side of createReplayEncoder: decodes records in order and writes each column's values into its target.
 * @param {{ name: string, length: number, bpe: 1 | 2 | 4, predict?: boolean, masked?: boolean }[]} specs
 */
export function createReplayDecoder(specs) {
  const intType = (bpe) => (bpe === 1 ? Uint8Array : bpe === 2 ? Uint16Array : Uint32Array);
  const shadow = specs.map((s) => new (intType(s.bpe))(s.length));
  const shadowF = specs.map((s, c) => (s.predict ? new Float32Array(shadow[c].buffer) : null));
  const prev2 = specs.map((s) => (s.predict ? new Float32Array(s.length) : null));
  const predF = specs.map((s) => (s.predict ? new Float32Array(s.length) : null));
  const predU = predF.map((p) => (p ? new Uint32Array(p.buffer) : null));
  const header = {
    frame: 0,
    byteLength: 0,
    queryVersion: 0,
    movedGen: 0,
    movedCount: 0,
    movedSeq: 0,
    movedLen: 0,
    moved: new Uint32Array(0),
    logicFrame: NaN,
    clock: NaN,
  };
  return {
    specs,
    header,
    /** The column's current values (as unsigned integers of its width). */
    values(c) {
      return shadow[c];
    },
    /**
     * Decode the record at `offset` of `buf` (an ArrayBuffer-backed Uint8Array, offset 8-aligned from its buffer's
     * start), write every changed column into `targets[c]` (an unsigned integer view of the column, or null), and
     * return the next record's offset.
     */
    decode(buf, offset, targets) {
      const base = buf.byteOffset + offset;
      const i32 = new Int32Array(buf.buffer, base, 16);
      if (i32[0] !== REPLAY_MAGIC) throw new Error(`replay: bad record at byte ${offset}`);
      const dv = new DataView(buf.buffer, base, 64);
      header.frame = i32[1];
      header.byteLength = i32[2];
      header.queryVersion = i32[3];
      header.movedGen = i32[4];
      header.movedCount = i32[5];
      header.movedSeq = i32[6];
      header.movedLen = i32[7];
      header.logicFrame = dv.getFloat64(32, true);
      header.clock = dv.getFloat64(40, true);
      if (i32[12] !== specs.length) throw new Error(`replay: record has ${i32[12]} columns, meta ${specs.length}`);
      let at = base + 64;
      header.moved = new Uint32Array(buf.buffer, at, header.movedLen);
      at += header.movedLen * 4;
      for (let c = 0; c < specs.length; c++) {
        const s = specs[c];
        const len = s.length;
        const T = intType(s.bpe);
        const sh = shadow[c];
        const hv = new Int32Array(buf.buffer, at, 2);
        const mode = hv[0];
        const count = hv[1];
        at += 8;
        const target = targets ? targets[c] : null;
        if (s.predict) {
          const p = predF[c];
          const sf = shadowF[c];
          const p2 = prev2[c];
          for (let i = 0; i < len; i++) p[i] = 2 * sf[i] - p2[i];
          if (!s.masked) p2.set(sf);
        }
        if (mode === MODE_SAME) continue;
        if (mode === MODE_SPARSE) {
          const idx = new Int32Array(buf.buffer, at, count);
          at += count * 4;
          const v = new T(buf.buffer, at, count);
          at += (count * s.bpe + 3) & ~3;
          for (let k = 0; k < count; k++) sh[idx[k]] = v[k];
          if (target) for (let k = 0; k < count; k++) target[idx[k]] = v[k];
          continue;
        }
        if (mode !== MODE_FULL || count !== len) throw new Error(`replay: column ${s.name}: mode ${mode}, count ${count}`);
        const r = new T(buf.buffer, at, len);
        at += (len * s.bpe + 3) & ~3;
        const ref = s.predict ? predU[c] : sh;
        if (s.predict) for (let i = 0; i < len; i++) sh[i] = r[i] ^ ref[i];
        else for (let i = 0; i < len; i++) sh[i] ^= r[i];
        if (target) target.set(sh);
      }
      return offset + header.byteLength;
    },
  };
}

/** An unsigned integer view of `arr`'s first `length` elements (same bytes), for createReplayEncoder/Decoder. */
export function unsignedView(arr, length = arr.length) {
  const bpe = arr.BYTES_PER_ELEMENT;
  const T = bpe === 1 ? Uint8Array : bpe === 2 ? Uint16Array : Uint32Array;
  if (arr instanceof T && arr.length === length) return arr;
  return new T(arr.buffer, arr.byteOffset, length);
}
