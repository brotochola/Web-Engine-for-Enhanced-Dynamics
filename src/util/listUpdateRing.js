// listUpdateRing.js — the list updates a logic worker other than logic0 sends it (E-208).
//
// A logic worker that spawns or despawns an entity queues a list update; logic0 alone edits the active lists, at the
// start of its frame. Workers 1..N used to post their updates as a message each frame: an object and a class name a
// record, cloned on the way and turned into another object on arrival, about 33 MB/s of garbage on logic0 in
// spawnStormScene with two workers. Now each of those workers has a ring of its own in shared memory (one writer, one
// reader): two words a record, the entity (its high bit set for a despawn) and its type, which logic0 turns back into
// the class through GameObject.classByType. A ring without room for a frame's updates leaves them to the message, so
// nothing is dropped; logic0's passes skip an index that is alive again or no longer alive, so the two roads' order does
// not matter.
//
// Each ring: a header of two cache lines, word 0 the writer's count of records written and word 16 logic0's count of
// records read (int32 counts that wrap), then its records.

const HEADER_I32 = 32;
const WRITE = 0;
const READ = 16;
const MIN_SLOTS = 4096;
/** The bit of a record's first word that marks a despawn (entities stay under 2^31). */
export const LIST_UPDATE_DESPAWN = 0x80000000;

/** A ring's records for `totalEntityCount` entities: a power of two, at least one record an entity. */
export function listUpdateRingSlots(totalEntityCount) {
  let slots = MIN_SLOTS;
  while (slots < (totalEntityCount | 0)) slots *= 2;
  return slots;
}

/** The rings of `logicWorkers` workers (none for logic0) in one buffer, or null with one worker. */
export function createListUpdateRings(logicWorkers, totalEntityCount) {
  const workers = logicWorkers | 0;
  if (workers < 2) return null;
  const ringI32 = HEADER_I32 + listUpdateRingSlots(totalEntityCount) * 2;
  return new SharedArrayBuffer((workers - 1) * ringI32 * 4);
}

/** Worker `workerIndex`'s ring (1 or more) in `buffer`: its words, `slots` and `mask`. */
export function bindListUpdateRing(buffer, workerIndex, totalEntityCount) {
  const slots = listUpdateRingSlots(totalEntityCount);
  const ringI32 = HEADER_I32 + slots * 2;
  return { i32: new Int32Array(buffer, (workerIndex - 1) * ringI32 * 4, ringI32), slots, mask: slots - 1 };
}

/**
 * The writer: `dn` despawns and `sn` spawns (entity indices and types) into the ring, then published; false, and
 * nothing written, when the ring has no room for them all.
 */
export function pushListUpdates(ring, despawnIdx, despawnType, dn, spawnIdx, spawnType, sn) {
  const h = ring.i32;
  const w = h[WRITE];
  const r = Atomics.load(h, READ);
  if (((w - r) | 0) + dn + sn > ring.slots) return false;
  const mask = ring.mask;
  let at = w;
  for (let i = 0; i < dn; i++, at = (at + 1) | 0) {
    const o = HEADER_I32 + (at & mask) * 2;
    h[o] = (despawnIdx[i] | LIST_UPDATE_DESPAWN) | 0;
    h[o + 1] = despawnType[i];
  }
  for (let i = 0; i < sn; i++, at = (at + 1) | 0) {
    const o = HEADER_I32 + (at & mask) * 2;
    h[o] = spawnIdx[i];
    h[o + 1] = spawnType[i];
  }
  Atomics.store(h, WRITE, at);
  return true;
}

/** The reader's view: the records published and not yet read, as [from, to) counts; markRead(to) after. */
export function listUpdatesPending(ring) {
  return Atomics.load(ring.i32, WRITE);
}

export function listUpdatesRead(ring) {
  return ring.i32[READ];
}

export function markListUpdatesRead(ring, to) {
  Atomics.store(ring.i32, READ, to);
}

/** The first word and the type of record `at` (a count), for the reader. */
export function listUpdateRecordOffset(ring, at) {
  return HEADER_I32 + (at & ring.mask) * 2;
}
