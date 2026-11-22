#!/usr/bin/env node
/**
 * Kernel (E-436, DX-STATICSGEN step 2): what logic and pre-render pay for writing the same dirty-flag columns
 * (SpriteRenderer.renderDirty and keyedDirty, a byte an entity). Two worker threads on one SharedArrayBuffer, each frame:
 *   logic       sets both flags of `marks` sprites (a statics setter: two plain byte stores), spread over the `sprites`
 *               on screen;
 *   pre-render  takes the flags of the sprites it emits (a plain read, an atomic exchange where set: sprite_row and
 *               persist_take_dirty) and, keyed, or's the texture bit of `advances` sprites (the persist path's clock,
 *               an atomic fetch_or).
 * Case `shared` runs them on the same columns, as the engine does; case `apart` gives pre-render its own copy of the
 * columns (the same work on lines logic never writes): the difference is what the sharing costs a frame. The threads
 * meet once a frame (a barrier on an Int32Array) so their frames overlap as the workers' do.
 *
 *   node tests/bench/dirtyFlagSharingMicrobench.mjs [--sprites 4000] [--entities 57633] [--marks 470] [--advances 670]
 *     [--frames 2000] [--output path]
 *
 * Defaults from E-436's estimate (Predator crowd 2.5: 4 000 sprites on screen, a tenth of the ticks changing statics, a
 * frame advance every six frames). Reports each thread's median microseconds a frame in each case.
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

function workerMain({ role, sab, apartSab, barrier, sprites, entities, marks, advances, frames, seed, timesSab }) {
  const shared = new Uint8Array(sab);
  const own = apartSab ? new Uint8Array(apartSab) : shared;
  const renderDirty = role === 'logic' ? shared.subarray(0, entities) : own.subarray(0, entities);
  const keyedDirty = role === 'logic' ? shared.subarray(entities, 2 * entities) : own.subarray(entities, 2 * entities);
  const bar = new Int32Array(barrier);
  const times = new Float64Array(timesSab);
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // The sprites on screen: a fixed spread of entity indices.
  const onScreen = new Int32Array(sprites);
  for (let k = 0; k < sprites; k++) onScreen[k] = Math.floor((k / sprites) * entities);
  for (let f = 0; f < frames; f++) {
    // The frame barrier: both threads start a frame together.
    const gen = Atomics.load(bar, 1);
    if (Atomics.add(bar, 0, 1) === 1) {
      Atomics.store(bar, 0, 0);
      Atomics.add(bar, 1, 1);
      Atomics.notify(bar, 1);
    } else {
      while (Atomics.load(bar, 1) === gen) Atomics.wait(bar, 1, gen, 1);
    }
    // Apart, pre-render's own columns get the frame's marks untimed (as many as logic sets), so it takes as many.
    if (role !== 'logic' && apartSab) {
      for (let m = 0; m < marks; m++) {
        const i = onScreen[(rand() * sprites) | 0];
        renderDirty[i] = 1;
        keyedDirty[i] = 1;
      }
    }
    const t0 = performance.now();
    if (role === 'logic') {
      for (let m = 0; m < marks; m++) {
        const i = onScreen[(rand() * sprites) | 0];
        renderDirty[i] = 1;
        keyedDirty[i] = 1;
      }
    } else {
      let taken = 0;
      for (let k = 0; k < sprites; k++) {
        const i = onScreen[k];
        if (keyedDirty[i] && Atomics.exchange(keyedDirty, i, 0)) taken++;
        if (renderDirty[i] && Atomics.exchange(renderDirty, i, 0)) taken++;
      }
      for (let a = 0; a < advances; a++) Atomics.or(keyedDirty, onScreen[(rand() * sprites) | 0], 2);
      if (taken < 0) throw new Error('unreachable');
    }
    times[f] = (performance.now() - t0) * 1000;
  }
}

if (process.argv[2] === '--worker') {
  const { workerData } = await import('node:worker_threads');
  workerMain(workerData);
} else {
  const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
    return acc;
  }, []));
  const opts = {
    sprites: Number(args.sprites ?? 4000),
    entities: Number(args.entities ?? 57633),
    marks: Number(args.marks ?? 470),
    advances: Number(args.advances ?? 670),
    frames: Number(args.frames ?? 2000),
  };
  const median = (a) => {
    const s = Array.from(a).slice(Math.floor(a.length / 4)).sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  const runCase = (apart) => new Promise((resolve, reject) => {
    const sab = new SharedArrayBuffer(2 * opts.entities);
    const apartSab = apart ? new SharedArrayBuffer(2 * opts.entities + 4096) : null;
    const barrier = new SharedArrayBuffer(8);
    const tl = new SharedArrayBuffer(8 * opts.frames);
    const tp = new SharedArrayBuffer(8 * opts.frames);
    let done = 0;
    const start = (role, timesSab, seed) => {
      const w = new Worker(SELF, { argv: ['--worker'], workerData: { role, sab, apartSab, barrier, timesSab, seed, ...opts } });
      w.on('error', reject);
      w.on('exit', () => {
        if (++done === 2) resolve({ logic: median(new Float64Array(tl)), preRender: median(new Float64Array(tp)) });
      });
    };
    start('logic', tl, 11);
    start('preRender', tp, 23);
  });
  const rounds = Number(args.rounds ?? 4);
  const out = { shared: [], apart: [] };
  for (let r = 0; r < rounds; r++) {
    out.shared.push(await runCase(false));
    out.apart.push(await runCase(true));
  }
  const med = (list, k) => median(Float64Array.from(list.map((x) => x[k])));
  console.log(`${opts.sprites} sprites on screen, ${opts.marks} marks and ${opts.advances} advances a frame, ${opts.frames} frames, ${rounds} rounds`);
  for (const k of ['logic', 'preRender']) {
    console.log(`${k.padEnd(9)} shared ${med(out.shared, k).toFixed(2)} us a frame, apart ${med(out.apart, k).toFixed(2)} us (each round: ${out.shared.map((x) => x[k].toFixed(1)).join(' ')} | ${out.apart.map((x) => x[k].toFixed(1)).join(' ')})`);
  }
}
