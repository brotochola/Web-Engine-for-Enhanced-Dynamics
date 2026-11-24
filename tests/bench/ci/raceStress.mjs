#!/usr/bin/env node
/**
 * The engine's cross-thread protocols hammered by real threads, to find what a weakly ordered CPU (ARM: phones, Apple's
 * chips) breaks and x86 hides. x86 keeps stores in order and loads in order; ARM keeps neither between plain accesses,
 * so a protocol that leans on that order works on every machine the engine was measured on and tears on those.
 *
 *   node tests/bench/ci/raceStress.mjs [--seconds 10] [--only camera,childList] [--output file.json] [--rounds 1]
 *
 * Each case runs the shipped functions (imported from src/, or the function's own source text where it lives in a
 * closure) in one or more writer threads, the reader on this thread, concurrently for --seconds, and counts the reads
 * the protocol ACCEPTED as whole whose fields came from two writes (`bad`).
 *
 * Kinds of case:
 *   control  not engine code. `plainMessage` (a flag and its data, both plain) and `seqlock*` (the engine's seqlock
 *            shape on data spread over many lines) say whether this machine shows the reorderings at all. A machine
 *            whose controls read 0 says nothing about the engine cases.
 *   engine   shipped code. Any `bad` is a bug. Exit 1.
 *   variant  a protocol with one side changed, to find what mends it: never fails the run.
 *   info     shipped code that returns unchecked values on purpose: compare its rate with x86's.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

import { Camera } from '../../../src/core/camera.js';
import { bindMovedBodies, copyMovedBodies, createMovedBodiesSab, publishMovedBodies, readMovedBodiesHeader }
  from '../../../src/box2d/box2dMovedBodies.js';
import { bindCommandRing, createCommandRingSab, drainCommandRing, enqueueSetVelocity }
  from '../../../src/box2d/box2dCommandRing.js';
import { bindFrameClock, createFrameClockBuffer, publishFrame, readFrame, readSlot, stampStep }
  from '../../../src/util/frameClock.js';
import { addFrame, bindFrameTotals, createFrameTotalsBuffer, readTotals } from '../../../src/util/frameTotals.js';
import { bindImpactRing, IMPACT_FLOATS, impactRingBytes, publishImpacts } from '../../../src/util/impactRing.js';
import { bindListUpdateRing, createListUpdateRings, listUpdateRecordOffset, listUpdatesPending, listUpdatesRead,
  markListUpdatesRead, pushListUpdates } from '../../../src/util/listUpdateRing.js';
import { createMessageInbox, drainMessages, pushMessage } from '../../../src/util/messageRing.js';
import { bindNavRequestRing, createNavRequestRings, drainNavRequests, pushNavRequest }
  from '../../../src/util/navRequestRing.js';
import { backPublishedList, bindPublishedList, createPublishedList, publishList, takePublishedList }
  from '../../../src/util/publishedList.js';
import { bindSpawnCommandRing, createSpawnCommandRingSab, drainSpawnCommands, tryPushSpawn }
  from '../../../src/util/spawnCommandRing.js';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..', '..', '..');

/** Busy work between two writes, so the reader finds the protocol idle often enough to accept a read. */
let sink = 0;
function pause(n) {
  for (let i = 0; i < n; i++) sink = (sink + i) | 0;
}

/** `stop` is read once in 32 turns: an Atomics.load every turn would order the loop's plain accesses itself. */
function loop(stop, turn) {
  let k = 0;
  for (;;) {
    if ((k & 31) === 0 && Atomics.load(stop, 0) !== 0) return k;
    turn(k);
    k++;
  }
}

/** weedjsPost's publishChildList as shipped (a closure's function: its text, with its variables handed in). */
function shippedPublishChildList(words, published) {
  const post = fs.readFileSync(path.join(ROOT, 'src/box2d/weedjsPost.js'), 'utf8');
  const at = post.indexOf('function publishChildList()');
  const end = post.indexOf('// child-links-end', at);
  if (at < 0 || end < 0) throw new Error('publishChildList not found in weedjsPost.js');
  return new Function('linkWords', 'linkPublished', `
    let childPublishDue = false, childList = null, childQueued = null, childCount = 0;
    ${post.slice(at, end)}
    return (list, queued, count) => { childList = list; childQueued = queued; childCount = count; publishChildList(); };
  `)(words, published);
}

const LIST_N = 2000;
const SEQ_F64 = 128;

/**
 * name → { kind, writers, setup() → shared (buffers only), write(shared, stop, id), read(shared, deadline) → counts }.
 * `accepted` counts the reads the protocol called whole, `bad` those whose fields disagree.
 */
export const CASES = {
  plainMessage: {
    kind: 'control',
    writers: 1,
    setup: () => ({ sab: new SharedArrayBuffer(64 * 64) }),
    write({ sab }, stop) {
      const w = new Int32Array(sab);
      return loop(stop, (k) => {
        w[16 * 17] = k;
        w[0] = k;
      });
    },
    read({ sab }, until) {
      const w = new Int32Array(sab);
      let reads = 0;
      let bad = 0;
      while (performance.now() < until) {
        for (let i = 0; i < 4096; i++) {
          const flag = w[0];
          const data = w[16 * 17];
          if (((data - flag) | 0) < 0) bad++;
        }
        reads += 4096;
      }
      return { reads, accepted: reads, bad };
    },
  },
  seqlockAdd: seqlockControl((words) => Atomics.add(words, 0, 1), (words) => Atomics.add(words, 0, 1)),
  seqlockStore: seqlockControl(
    (words) => Atomics.store(words, 0, (words[0] + 1) | 0),
    (words) => Atomics.store(words, 0, (words[0] + 1) | 0),
  ),
  camera: {
    kind: 'engine',
    writers: 1,
    setup: () => ({ sab: new SharedArrayBuffer(256) }),
    write({ sab }, stop) {
      const data = new Float32Array(sab, 0, 17);
      Camera.initialize(data, 100, 100);
      return loop(stop, (k) => {
        const v = k & 0xfffff;
        Camera._followWriteBegin();
        data[Camera.IDX_ZOOM] = v;
        data[Camera.IDX_X] = v;
        data[Camera.IDX_Y] = v;
        data[Camera.IDX_FOLLOW_X] = v + 1;
        data[Camera.IDX_FOLLOW_Y] = v + 1;
        data[Camera.IDX_FOLLOW_ENTITY] = v;
        data[Camera.IDX_FOLLOW_USED_X] = v;
        data[Camera.IDX_FOLLOW_USED_Y] = v;
        Camera._followWriteEnd();
        pause(60);
      });
    },
    read({ sab }, until) {
      const data = new Float32Array(sab, 0, 17);
      Camera.initialize(data, 100, 100);
      // initialize() fills the snapshot from a buffer the writer may be writing: start from a whole one.
      Object.assign(Camera._followSnap, { slot: 0, usedX: 0, usedY: 0, leadX: 1, leadY: 1, zoom: 0, camX: 0, camY: 0 });
      let reads = 0;
      let accepted = 0;
      let bad = 0;
      let last = -1;
      while (performance.now() < until) {
        for (let i = 0; i < 1024; i++) {
          const s = Camera._readFollowSnapshot();
          reads++;
          if (s.zoom === last) continue;
          last = s.zoom;
          if (s.slot === 0 && s.zoom !== 0) continue; // the writer was busy: the last whole set, its slot dropped
          accepted++;
          if (s.camX !== s.zoom || s.camY !== s.zoom || s.slot !== s.zoom || s.usedX !== s.zoom || s.usedY !== s.zoom ||
            (s.zoom !== 0 && (s.leadX !== 1 || s.leadY !== 1))) bad++;
        }
      }
      return { reads, accepted, bad };
    },
  },
  timeScale: {
    kind: 'engine',
    writers: 1,
    setup: () => ({ sab: new SharedArrayBuffer(64) }),
    // The base and the time it was taken, under the clock's lock as _rebaseSim writes them; readSimNow's protocol is read
    // through readSimNow itself with the clock stopped, so it returns the base it read.
    write({ sab }, stop) {
      new Float32Array(sab, 0, 1)[0] = 1;
      const seq = new Int32Array(sab, 4, 1);
      const base = new Float64Array(sab, 8, 2);
      return loop(stop, (k) => {
        for (;;) {
          const v = Atomics.load(seq, 0);
          if ((v & 1) === 0 && Atomics.compareExchange(seq, 0, v, v + 1) === v) break;
        }
        base[0] = k;
        base[1] = k;
        Atomics.add(seq, 0, 1);
        pause(60);
      });
    },
    // timeScale.js's read loop, its accesses in its order.
    read({ sab }, until) {
      const seq = new Int32Array(sab, 4, 1);
      const now = new Float64Array(sab, 8, 2);
      const view = new Float32Array(sab, 0, 1);
      let reads = 0;
      let accepted = 0;
      let bad = 0;
      while (performance.now() < until) {
        for (let i = 0; i < 1024; i++) {
          reads++;
          const before = Atomics.load(seq, 0);
          if (before & 1) continue;
          const base = now[0];
          const at = now[1];
          const scale = view[0];
          if (Atomics.load(seq, 0) !== before) continue;
          accepted++;
          if (base !== at || scale > 1) bad++;
        }
      }
      return { reads, accepted, bad };
    },
  },
  // The camera's seqlock with one side changed, to find what mends it (writer, reader):
  //   plain   as shipped: plain stores after the odd mark; plain loads, then the mark again
  //   fence   an atomic read-modify-write on a private word between the data and the mark (a full barrier on ARM)
  //   atomic  the data itself through Atomics, as Int32 (what the language's memory model asks for)
  //   rmw     the second mark read as Atomics.add(seq, 0, 0)
  seqPlainPlain: cameraVariant('plain', 'plain'),
  seqPlainFence: cameraVariant('plain', 'fence'),
  seqPlainRmw: cameraVariant('plain', 'rmw'),
  seqPlainAtomic: cameraVariant('plain', 'atomic'),
  seqFencePlain: cameraVariant('fence', 'plain'),
  seqFenceFence: cameraVariant('fence', 'fence'),
  seqAtomicAtomic: cameraVariant('atomic', 'atomic'),
  frameClockSlot: {
    kind: 'engine',
    writers: 1,
    setup: () => ({ sab: createFrameClockBuffer() }),
    write({ sab }, stop) {
      const view = bindFrameClock(sab);
      const times = new Float64Array(2);
      return loop(stop, (k) => {
        times[0] = k + 1;
        times[1] = k + 1.5;
        stampStep(view, 7, times);
        pause(60);
      });
    },
    read({ sab }, until) {
      const view = bindFrameClock(sab);
      let reads = 0;
      let accepted = 0;
      let bad = 0;
      while (performance.now() < until) {
        for (let i = 0; i < 1024; i++) {
          reads++;
          const r = readSlot(view, 7);
          if (!r || r.start === 0) continue;
          accepted++;
          if (r.end !== r.start + 0.5) bad++;
        }
      }
      return { reads, accepted, bad };
    },
  },
  frameClockHeader: {
    // info, not engine: readFrame gives up after 8 tries and returns an unchecked pair (a writer preempted between its
    // two marks), so x86 reads a few bad ones too (8 in a million). Compare the machines' rates.
    kind: 'info',
    writers: 1,
    setup: () => ({ sab: createFrameClockBuffer() }),
    write({ sab }, stop) {
      const view = bindFrameClock(sab);
      let gen = 0;
      return loop(stop, () => {
        gen = publishFrame(view, gen + 1);
        pause(400);
      });
    },
    read({ sab }, until) {
      const view = bindFrameClock(sab);
      let reads = 0;
      let bad = 0;
      while (performance.now() < until) {
        for (let i = 0; i < 1024; i++) {
          reads++;
          const r = readFrame(view);
          if (r.t0 !== r.gen) bad++;
        }
      }
      return { reads, accepted: reads, bad };
    },
  },
  frameTotals: {
    kind: 'engine',
    writers: 1,
    setup: () => ({ sab: createFrameTotalsBuffer() }),
    write({ sab }, stop) {
      const view = bindFrameTotals(sab);
      return loop(stop, () => {
        addFrame(view, 3, 1, 0, 0);
        pause(3000);
      });
    },
    read({ sab }, until) {
      const view = bindFrameTotals(sab);
      let reads = 0;
      let accepted = 0;
      let bad = 0;
      while (performance.now() < until) {
        for (let i = 0; i < 64; i++) {
          reads++;
          const r = readTotals(view, 3);
          if (!r) continue;
          accepted++;
          if (r.stepSum !== r.frames || r.hist[8] !== r.frames) bad++;
        }
      }
      return { reads, accepted, bad };
    },
  },
  movedBodies: {
    kind: 'engine',
    writers: 1,
    setup: () => ({ sab: createMovedBodiesSab(LIST_N * 2) }),
    write({ sab }, stop) {
      bindMovedBodies(sab);
      const asleep = new Uint8Array(LIST_N);
      const lists = [0, 1].map((parity) => Int32Array.from({ length: LIST_N }, (_, i) => i * 2 + parity));
      return loop(stop, (k) => {
        publishMovedBodies(lists[k & 1], asleep, LIST_N, null, 0, null);
        pause(6000);
      });
    },
    read({ sab }, until) {
      bindMovedBodies(sab);
      const out = new Int32Array(3);
      const dst = new Int32Array(LIST_N * 2);
      let reads = 0;
      let accepted = 0;
      let bad = 0;
      while (performance.now() < until) {
        for (let i = 0; i < 64; i++) {
          reads++;
          readMovedBodiesHeader(out);
          if (out[2] < 0 || out[1] === 0) continue;
          if (!copyMovedBodies(dst, out[1], out[2])) continue;
          accepted++;
          if (out[1] !== LIST_N || !wholeParity(dst, LIST_N)) bad++;
        }
      }
      return { reads, accepted, bad };
    },
  },
  childList: {
    kind: 'engine',
    writers: 1,
    setup: () => ({ words: new SharedArrayBuffer(64), list: new SharedArrayBuffer(LIST_N * 4) }),
    write({ words, list }, stop) {
      const publish = shippedPublishChildList(new Int32Array(words), new Int32Array(list));
      const queued = new Uint8Array(LIST_N * 2);
      const lists = [0, 1].map((parity) => Int32Array.from({ length: LIST_N }, (_, i) => i * 2 + parity));
      return loop(stop, (k) => {
        publish(lists[k & 1], queued, LIST_N);
        pause(4000);
      });
    },
    // preRenderWorker._composeChildren's accesses, in its order: the sequence, the count, the list, the sequence again
    // (the method itself composes poses between them).
    read({ words, list }, until) {
      const w = new Int32Array(words);
      const l = new Int32Array(list);
      const dst = new Int32Array(LIST_N);
      let reads = 0;
      let accepted = 0;
      let bad = 0;
      while (performance.now() < until) {
        for (let i = 0; i < 64; i++) {
          reads++;
          const seq = Atomics.load(w, 2);
          const count = (seq & 1) === 0 ? Atomics.load(w, 3) : 0;
          if (count === 0) continue;
          for (let k = 0; k < count; k++) dst[k] = l[k];
          if (Atomics.load(w, 2) !== seq) continue;
          accepted++;
          if (count !== LIST_N || !wholeParity(dst, LIST_N)) bad++;
        }
      }
      return { reads, accepted, bad };
    },
  },
  publishedList: {
    kind: 'engine',
    writers: 1,
    setup: () => ({ sab: createPublishedList(LIST_N) }),
    write({ sab }, stop) {
      const { ctl, copies } = bindPublishedList(sab, LIST_N);
      return loop(stop, (k) => {
        const c = backPublishedList(ctl);
        const list = copies[c];
        const v = k & 0xfff;
        list[0] = LIST_N;
        for (let i = 1; i <= LIST_N; i++) list[i] = v;
        publishList(ctl, c);
      });
    },
    read({ sab }, until) {
      const { ctl, copies } = bindPublishedList(sab, LIST_N);
      let reads = 0;
      let accepted = 0;
      let bad = 0;
      while (performance.now() < until) {
        for (let i = 0; i < 64; i++) {
          const list = copies[takePublishedList(ctl)];
          reads++;
          if (list[0] === 0) continue;
          accepted++;
          const v = list[1];
          let same = list[0] === LIST_N;
          for (let k = 2; k <= LIST_N; k++) if (list[k] !== v) same = false;
          if (!same) bad++;
        }
      }
      return { reads, accepted, bad };
    },
  },
  messageRing: {
    kind: 'engine',
    writers: 2,
    setup: () => ({ sab: createMessageInbox(256) }),
    write({ sab }, stop, id) {
      const i32 = new Int32Array(sab);
      const f64 = new Float64Array(sab);
      let sent = 0;
      loop(stop, () => {
        const v = sent & 0xfffffff;
        if (pushMessage(i32, f64, v, id, 7, v & 0xffff, v, v + 1, v + 2, v + 3)) sent++;
      });
      return sent;
    },
    read({ sab }, until) {
      const i32 = new Int32Array(sab);
      const f64 = new Float64Array(sab);
      const next = [0, 0];
      let accepted = 0;
      let bad = 0;
      while (performance.now() < until) {
        for (let i = 0; i < 64; i++) {
          drainMessages(i32, f64, (target, from, nameId, gen, a, b, c, d) => {
            accepted++;
            const want = next[from] & 0xfffffff;
            next[from]++;
            if (target !== want || nameId !== 7 || gen !== (want & 0xffff) || a !== want || b !== want + 1 ||
              c !== want + 2 || d !== want + 3) bad++;
          });
        }
      }
      return { reads: accepted, accepted, bad };
    },
  },
  spawnRing: {
    kind: 'engine',
    writers: 2,
    setup: () => ({ sab: createSpawnCommandRingSab(256) }),
    write({ sab }, stop, id) {
      bindSpawnCommandRing(sab);
      let sent = 0;
      loop(stop, () => {
        const v = sent & 0x3fffff;
        if (tryPushSpawn(v, v, v, -v, id)) sent++;
      });
      return sent;
    },
    read({ sab }, until) {
      bindSpawnCommandRing(sab);
      const next = [0, 0];
      let accepted = 0;
      let bad = 0;
      while (performance.now() < until) {
        for (let i = 0; i < 64; i++) {
          drainSpawnCommands((kind, typeId, index, x, y, owner) => {
            accepted++;
            const want = next[owner]++ & 0x3fffff;
            if (typeId !== want || index !== want || x !== want || y !== -want) bad++;
          });
        }
      }
      return { reads: accepted, accepted, bad };
    },
  },
  commandRing: {
    kind: 'engine',
    writers: 2,
    setup: () => ({ sab: createCommandRingSab(256) }),
    write({ sab }, stop, id) {
      bindCommandRing(sab);
      let sent = 0;
      loop(stop, () => {
        const v = sent & 0x3fffff;
        if (enqueueSetVelocity(id, v, -v)) sent++;
      });
      return sent;
    },
    read({ sab }, until) {
      const i32 = new Int32Array(sab);
      const f32 = new Float32Array(sab);
      const next = [0, 0];
      let accepted = 0;
      let bad = 0;
      const handlers = {
        setVelocity(entity, vx, vy) {
          accepted++;
          const want = next[entity]++ & 0x3fffff;
          if (vx !== want || vy !== -want) bad++;
        },
      };
      while (performance.now() < until) for (let i = 0; i < 64; i++) drainCommandRing(i32, f32, handlers);
      return { reads: accepted, accepted, bad };
    },
  },
  navRing: {
    kind: 'engine',
    writers: 1,
    setup: () => ({ sab: createNavRequestRings(1) }),
    write({ sab }, stop) {
      const ring = bindNavRequestRing(sab, 0);
      let sent = 0;
      loop(stop, () => {
        if (pushNavRequest(ring, sent | 0, ~sent)) sent = (sent + 1) | 0;
      });
      return sent;
    },
    read({ sab }, until) {
      const ring = bindNavRequestRing(sab, 0);
      let want = 0;
      let accepted = 0;
      let bad = 0;
      while (performance.now() < until) {
        for (let i = 0; i < 64; i++) {
          drainNavRequests(ring, (a, b) => {
            accepted++;
            if (a !== want || b !== ~want) bad++;
            want = (want + 1) | 0;
          });
        }
      }
      return { reads: accepted, accepted, bad };
    },
  },
  listUpdateRing: {
    kind: 'engine',
    writers: 1,
    setup: () => ({ sab: createListUpdateRings(2, 4096) }),
    write({ sab }, stop) {
      const ring = bindListUpdateRing(sab, 1, 4096);
      const idx = new Int32Array(8);
      const type = new Int32Array(8);
      let sent = 0;
      loop(stop, () => {
        for (let i = 0; i < 8; i++) {
          idx[i] = (sent + i) & 0xffffff;
          type[i] = (sent + i) & 0xff;
        }
        if (pushListUpdates(ring, idx, type, 0, idx, type, 8)) sent += 8;
      });
      return sent;
    },
    read({ sab }, until) {
      const ring = bindListUpdateRing(sab, 1, 4096);
      const h = ring.i32;
      let want = 0;
      let accepted = 0;
      let bad = 0;
      while (performance.now() < until) {
        for (let i = 0; i < 64; i++) {
          const end = listUpdatesPending(ring);
          let at = listUpdatesRead(ring);
          while (at !== end) {
            const o = listUpdateRecordOffset(ring, at);
            accepted++;
            if (h[o] !== (want & 0xffffff) || h[o + 1] !== (want & 0xff)) bad++;
            want++;
            at = (at + 1) | 0;
          }
          markListUpdatesRead(ring, at);
        }
      }
      return { reads: accepted, accepted, bad };
    },
  },
  impactRing: {
    kind: 'engine',
    writers: 1,
    // The ring has no back pressure: a reader that falls 8 frames behind loses records. The reader here checks only
    // records the writer has not come back to (it re-reads the published count after them).
    setup: () => ({ sab: new SharedArrayBuffer(impactRingBytes(64)) }),
    write({ sab }, stop) {
      const ring = bindImpactRing(sab, 64);
      const src = new Float32Array(8 * IMPACT_FLOATS);
      return loop(stop, (k) => {
        for (let j = 0; j < 8; j++) for (let f = 0; f < IMPACT_FLOATS; f++) src[j * IMPACT_FLOATS + f] = ((k * 8 + j) & 0x3fffff) + f;
        publishImpacts(ring, src, 8);
        pause(2000);
      });
    },
    read({ sab }, until) {
      const ring = bindImpactRing(sab, 64);
      let at = 0;
      let accepted = 0;
      let bad = 0;
      const rec = new Float32Array(IMPACT_FLOATS);
      while (performance.now() < until) {
        const end = Atomics.load(ring.header, 0);
        if (((end - at) | 0) > ring.slots >> 1) at = (end - 8) | 0;
        while (at !== end) {
          const o = (at & ring.mask) * IMPACT_FLOATS;
          for (let f = 0; f < IMPACT_FLOATS; f++) rec[f] = ring.data[o + f];
          const now = Atomics.load(ring.header, 0);
          if (((now - at) | 0) < ring.slots >> 1) {
            accepted++;
            const want = at & 0x3fffff;
            for (let f = 0; f < IMPACT_FLOATS; f++) if (rec[f] !== want + f) { bad++; break; }
          }
          at = (at + 1) | 0;
        }
      }
      return { reads: accepted, accepted, bad };
    },
  },
};

/** Every entry of one of the writer's two lists (even slots or odd ones), in its order. */
function wholeParity(dst, n) {
  const parity = dst[0] & 1;
  for (let i = 0; i < n; i++) if (dst[i] !== i * 2 + parity) return false;
  return true;
}

/** The engine's seqlock shape (odd mark, plain data, even mark; read: mark, plain data, mark) over SEQ_F64 doubles. */
function seqlockControl(begin, end) {
  return {
    kind: 'control',
    writers: 1,
    setup: () => ({ sab: new SharedArrayBuffer(64 + SEQ_F64 * 8) }),
    write({ sab }, stop) {
      const words = new Int32Array(sab, 0, 16);
      const data = new Float64Array(sab, 64, SEQ_F64);
      return loop(stop, (k) => {
        begin(words);
        for (let i = 0; i < SEQ_F64; i++) data[i] = k;
        end(words);
        pause(300);
      });
    },
    read({ sab }, until) {
      const words = new Int32Array(sab, 0, 16);
      const data = new Float64Array(sab, 64, SEQ_F64);
      const copy = new Float64Array(SEQ_F64);
      let reads = 0;
      let accepted = 0;
      let bad = 0;
      while (performance.now() < until) {
        for (let i = 0; i < 256; i++) {
          reads++;
          const s = Atomics.load(words, 0);
          if (s & 1) continue;
          for (let k = 0; k < SEQ_F64; k++) copy[k] = data[k];
          if (Atomics.load(words, 0) !== s) continue;
          accepted++;
          for (let k = 1; k < SEQ_F64; k++) if (copy[k] !== copy[0]) { bad++; break; }
        }
      }
      return { reads, accepted, bad };
    },
  };
}

/** The camera's layout (8 fields, the mark at word 16) and accesses, its writer's and reader's order kept three ways. */
function cameraVariant(writer, reader) {
  const FIELDS = 8;
  const SEQ = 16;
  return {
    kind: 'variant',
    writers: 1,
    setup: () => ({ sab: new SharedArrayBuffer(256) }),
    write({ sab }, stop) {
      const f32 = new Float32Array(sab, 0, 17);
      const i32 = new Int32Array(sab, 0, 17);
      const fence = new Int32Array(new SharedArrayBuffer(4));
      const bits = new Float32Array(1);
      const asInt = new Int32Array(bits.buffer);
      if (writer === 'atomic') {
        return loop(stop, (k) => {
          bits[0] = k & 0xfffff;
          const v = asInt[0];
          Atomics.add(i32, SEQ, 1);
          for (let f = 0; f < FIELDS; f++) Atomics.store(i32, f, v);
          Atomics.add(i32, SEQ, 1);
          pause(60);
        });
      }
      const fenced = writer === 'fence';
      return loop(stop, (k) => {
        const v = k & 0xfffff;
        Atomics.add(i32, SEQ, 1);
        if (fenced) Atomics.add(fence, 0, 0);
        f32[0] = v;
        f32[1] = v;
        f32[2] = v;
        f32[3] = v;
        f32[4] = v;
        f32[5] = v;
        f32[6] = v;
        f32[7] = v;
        Atomics.add(i32, SEQ, 1);
        pause(60);
      });
    },
    read({ sab }, until) {
      const f32 = new Float32Array(sab, 0, 17);
      const i32 = new Int32Array(sab, 0, 17);
      const fence = new Int32Array(new SharedArrayBuffer(4));
      const counts = { reads: 0, accepted: 0, bad: 0 };
      const turn = reader === 'atomic' ? readAtomic : reader === 'fence' ? readFence : reader === 'rmw' ? readRmw : readPlain;
      while (performance.now() < until) for (let i = 0; i < 1024; i++) turn();
      return counts;

      function readPlain() {
        counts.reads++;
        const s = Atomics.load(i32, SEQ);
        if (s & 1) return;
        const a = f32[0], b = f32[1], c = f32[2], d = f32[3], e = f32[4], f = f32[5], g = f32[6], h = f32[7];
        if (Atomics.load(i32, SEQ) !== s) return;
        counts.accepted++;
        if (a !== b || a !== c || a !== d || a !== e || a !== f || a !== g || a !== h) counts.bad++;
      }
      function readFence() {
        counts.reads++;
        const s = Atomics.load(i32, SEQ);
        if (s & 1) return;
        const a = f32[0], b = f32[1], c = f32[2], d = f32[3], e = f32[4], f = f32[5], g = f32[6], h = f32[7];
        Atomics.add(fence, 0, 0);
        if (Atomics.load(i32, SEQ) !== s) return;
        counts.accepted++;
        if (a !== b || a !== c || a !== d || a !== e || a !== f || a !== g || a !== h) counts.bad++;
      }
      function readRmw() {
        counts.reads++;
        const s = Atomics.load(i32, SEQ);
        if (s & 1) return;
        const a = f32[0], b = f32[1], c = f32[2], d = f32[3], e = f32[4], f = f32[5], g = f32[6], h = f32[7];
        if (Atomics.add(i32, SEQ, 0) !== s) return;
        counts.accepted++;
        if (a !== b || a !== c || a !== d || a !== e || a !== f || a !== g || a !== h) counts.bad++;
      }
      function readAtomic() {
        counts.reads++;
        const s = Atomics.load(i32, SEQ);
        if (s & 1) return;
        const a = Atomics.load(i32, 0), b = Atomics.load(i32, 1), c = Atomics.load(i32, 2), d = Atomics.load(i32, 3);
        const e = Atomics.load(i32, 4), f = Atomics.load(i32, 5), g = Atomics.load(i32, 6), h = Atomics.load(i32, 7);
        if (Atomics.load(i32, SEQ) !== s) return;
        counts.accepted++;
        if (a !== b || a !== c || a !== d || a !== e || a !== f || a !== g || a !== h) counts.bad++;
      }
    },
  };
}

async function runCase(name, seconds) {
  const c = CASES[name];
  const shared = c.setup();
  const stop = new Int32Array(new SharedArrayBuffer(4));
  const threads = [];
  for (let id = 0; id < c.writers; id++) {
    const w = new Worker(SELF, { workerData: { name, shared, stop: stop.buffer, id } });
    const up = new Promise((resolve, reject) => {
      w.once('message', resolve);
      w.once('error', reject);
    });
    threads.push({ w, up });
  }
  await Promise.all(threads.map((t) => t.up));
  const done = threads.map((t) => new Promise((resolve, reject) => {
    t.w.once('message', resolve);
    t.w.once('error', reject);
  }));
  for (const t of threads) t.w.postMessage('go');
  const counts = c.read(shared, performance.now() + seconds * 1000);
  Atomics.store(stop, 0, 1);
  const writes = (await Promise.all(done)).reduce((a, b) => a + b, 0);
  await Promise.all(threads.map((t) => t.w.terminate()));
  return { name, kind: c.kind, writers: c.writers, seconds, writes, ...counts };
}

if (!isMainThread) {
  const { name, shared, stop, id } = workerData;
  parentPort.once('message', () => {
    parentPort.postMessage(CASES[name].write(shared, new Int32Array(stop), id));
  });
  parentPort.postMessage('up');
} else if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase()) {
  const arg = (k, d) => {
    const i = process.argv.indexOf(`--${k}`);
    return i >= 0 ? process.argv[i + 1] : d;
  };
  const seconds = Number(arg('seconds', 10));
  const rounds = Number(arg('rounds', 1));
  const only = arg('only', null);
  const names = Object.keys(CASES).filter((n) => !only || only.split(',').includes(n));
  const rows = [];
  for (let r = 0; r < rounds; r++) {
    for (const name of names) {
      const row = await runCase(name, seconds);
      rows.push({ round: r, ...row });
      console.log(`${row.kind.padEnd(8)} ${name.padEnd(18)} writes ${String(row.writes).padStart(11)}  reads ` +
        `${String(row.reads).padStart(11)}  accepted ${String(row.accepted).padStart(11)}  bad ${row.bad}`);
    }
  }
  const broken = rows.filter((x) => x.kind === 'engine' && x.bad > 0);
  // A case whose reader accepted next to nothing checked nothing.
  const idle = rows.filter((x) => x.accepted < 100).map((x) => x.name);
  const out = { arch: os.arch(), platform: os.platform(), cpu: os.cpus()[0]?.model, node: process.version, rows,
    broken: [...new Set(broken.map((x) => x.name))], idle };
  const file = arg('output', null);
  if (file) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
  }
  if (idle.length) console.log(`idle (accepted < 100): ${idle.join(', ')}`);
  console.log(broken.length ? `BROKEN: ${out.broken.join(', ')}` : 'no engine case broke');
  process.exitCode = broken.length || idle.length ? 1 : 0;
}
