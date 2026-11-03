// publishedList.js — a [count, index, ...] list that one worker rewrites while another reads it (N-112).
//
// The particle worker writes the visible decoration list on its loop and pre-render reads it on its own; neither
// waits for the other. One list in a SharedArrayBuffer was read while it was being rewritten: the read got part of
// the old list and part of the new one, an index twice and another missing, and the missing decorations were not
// drawn that frame (Conurbano-weed: decorations blinked while the camera moved or zoomed).
//
// Three copies and a two-word header, in one SharedArrayBuffer:
//   0   i32  published  the copy the reader takes (0, 1 or 2)
//   4   i32  reading    the copy the reader took last, or -1 before its first take
//   64  three copies of 1 + max slots at the pool's slot width (u16, u32 past 65 535: E-129), each from a cache line
//
// The writer fills a copy that is neither published nor held by the reader, then publishes it; the reader marks the
// published copy as held, checks that it is still the published one, and reads it whole. With three copies the
// writer always has one to fill, so neither side waits, and the reader never holds a copy the writer is filling.
// One reader: the reading word is pre-render's. Anyone else (the debug panel) only peeks at a count.
import { PoolSlotArray, poolSlotBytes } from './poolSlotWidth.js';

export const PUBLISHED_LIST_COPIES = 3;
const HEADER_BYTES = 64;
const LINE = 64;

/** Bytes of one copy of a list of up to `maxEntries`, rounded up to a cache line. */
function copyBytes(maxEntries) {
  const bytes = (1 + maxEntries) * poolSlotBytes(maxEntries);
  return Math.ceil(bytes / LINE) * LINE;
}

/** Bytes of a published list of up to `maxEntries` indices. */
export function publishedListBytes(maxEntries) {
  return HEADER_BYTES + PUBLISHED_LIST_COPIES * copyBytes(maxEntries);
}

/** A published list's buffer: every copy empty, copy 0 published, none held. */
export function createPublishedList(maxEntries) {
  const sab = new SharedArrayBuffer(publishedListBytes(maxEntries));
  const ctl = new Int32Array(sab, 0, 2);
  ctl[0] = 0;
  ctl[1] = -1;
  return sab;
}

/** Views of a published list: `ctl` [published, reading] and its three `copies` at the pool's slot width. */
export function bindPublishedList(sab, maxEntries) {
  const Slot = PoolSlotArray(maxEntries);
  const stride = copyBytes(maxEntries);
  const copies = [];
  for (let k = 0; k < PUBLISHED_LIST_COPIES; k++) {
    copies.push(new Slot(sab, HEADER_BYTES + k * stride, 1 + maxEntries));
  }
  return { ctl: new Int32Array(sab, 0, 2), copies };
}

/** The writer's copy for this frame: neither the published one nor the one the reader holds. */
export function backPublishedList(ctl) {
  const published = Atomics.load(ctl, 0);
  const reading = Atomics.load(ctl, 1);
  let copy = 0;
  while (copy === published || copy === reading) copy++;
  return copy;
}

/** The writer, once `copy` is written whole: the reader's next take gets it. */
export function publishList(ctl, copy) {
  Atomics.store(ctl, 0, copy);
}

/**
 * The reader: the published copy, held until its next take. It marks the copy, then reads `published` again: if the
 * writer published another one meanwhile, it may have chosen the marked copy before the mark was seen, so the reader
 * takes the newer one instead. Once the check holds the writer passes over the copy until the reader's next take.
 */
export function takePublishedList(ctl) {
  let copy = Atomics.load(ctl, 0);
  for (;;) {
    Atomics.store(ctl, 1, copy);
    const now = Atomics.load(ctl, 0);
    if (now === copy) return copy;
    copy = now;
  }
}

/** The published copy's count, for a display: nothing is marked, so it may be the count of the copy just replaced. */
export function peekPublishedCount(ctl, copies) {
  return copies[Atomics.load(ctl, 0)][0];
}
