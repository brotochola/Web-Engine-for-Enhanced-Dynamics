// navRequestRing.js — the path and flowfield requests a logic worker sends the particle worker (E-213).
//
// NavGrid's getNextAStarPosition, getPathAStar and requestVector ask the particle worker for a path or a flowfield it
// has not computed. Each request used to be a postMessage: a clone on the way and a message event on arrival, 10 % of
// the particle worker in astarStressScene. Now each logic worker has a ring of its own in shared memory (one writer,
// one reader): two words a record, a path's from and to cells, or a flowfield's target with the high bit set. The
// particle worker drains every ring at the start of its nav step. A ring without room leaves the request to the
// message, so nothing is dropped; the particle worker handles both roads the same way.
//
// Each ring: a header of two cache lines, word 0 the writer's count of records written and word 16 the reader's count
// of records read (int32 counts that wrap), then its records.

const HEADER_I32 = 32;
const WRITE = 0;
const READ = 16;
/** Records a ring holds: more requests than a logic worker makes between two particle frames. */
export const NAV_REQUEST_SLOTS = 4096;
/** The bit of a record's first word that marks a flowfield request (cells stay under 2^31). */
export const NAV_REQUEST_FLOWFIELD = 0x80000000;

const RING_I32 = HEADER_I32 + NAV_REQUEST_SLOTS * 2;

/** The rings of `logicWorkers` workers in one buffer, or null without navigation. */
export function createNavRequestRings(logicWorkers) {
  const workers = Math.max(1, logicWorkers | 0);
  return new SharedArrayBuffer(workers * RING_I32 * 4);
}

/** Logic worker `workerIndex`'s ring in `buffer`. */
export function bindNavRequestRing(buffer, workerIndex) {
  return { i32: new Int32Array(buffer, (workerIndex | 0) * RING_I32 * 4, RING_I32), mask: NAV_REQUEST_SLOTS - 1 };
}

/** Every ring in `buffer`, for the particle worker. */
export function bindNavRequestRings(buffer) {
  const n = (buffer.byteLength / (RING_I32 * 4)) | 0;
  const out = [];
  for (let k = 0; k < n; k++) out.push(bindNavRequestRing(buffer, k));
  return out;
}

/** The writer: one record, published; false when the ring is full. */
export function pushNavRequest(ring, a, b) {
  const h = ring.i32;
  const w = h[WRITE];
  if (((w - Atomics.load(h, READ)) | 0) >= NAV_REQUEST_SLOTS) return false;
  const o = HEADER_I32 + (w & ring.mask) * 2;
  h[o] = a | 0;
  h[o + 1] = b | 0;
  Atomics.store(h, WRITE, (w + 1) | 0);
  return true;
}

/**
 * The reader: every record published since the last drain, through `handle(a, b)` (a's high bit set for a
 * flowfield), then marked read. Returns the records handled.
 */
export function drainNavRequests(ring, handle) {
  const h = ring.i32;
  const end = Atomics.load(h, WRITE);
  let at = h[READ];
  let n = 0;
  while (at !== end) {
    const o = HEADER_I32 + (at & ring.mask) * 2;
    handle(h[o], h[o + 1]);
    at = (at + 1) | 0;
    n++;
  }
  Atomics.store(h, READ, at);
  return n;
}
