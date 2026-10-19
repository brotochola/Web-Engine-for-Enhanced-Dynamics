#!/usr/bin/env node
/**
 * E-19 premise. copyTypeActiveListToBuffer writes a SharedArrayBuffer that other
 * workers read. Gate 4 said TypedArray.set was faster in the writer. Two Predator
 * sittings said the readers got more expensive. This runs the writer and a reader
 * on the same SAB at the same time and reports both.
 *
 *   node tests/bench/e19QueryCopyPremise.mjs
 */
import { isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const N = 16384;

function writeLoop(src, dst) {
  for (let i = 0; i < N; i++) dst[i] = src[i];
}

function writeSet(src, dst) {
  dst.set(src);
}

function runWriter(mode) {
  const src = new Uint16Array(N);
  const dst = new Uint16Array(N);
  for (let i = 0; i < N; i++) src[i] = i & 0xffff;
  const fn = mode === 'set' ? () => writeSet(src, dst) : () => writeLoop(src, dst);
  const checksum = (fn(), dst[N - 1]) >>> 0;
  const result = timeIt(`e19 writer ${mode}`, fn, { iterations: 400, warmup: 40 });
  return {
    checksum,
    msPerCall: result.ms / result.iterations,
    opsPerSec: result.opsPerSec,
    sampleMs: result.ms,
    iterations: result.iterations,
  };
}

async function runOverlap(mode) {
  const { Worker } = await import('node:worker_threads');
  const sab = new SharedArrayBuffer(N * 2);
  const src = new Uint16Array(N);
  const dst = new Uint16Array(sab);
  for (let i = 0; i < N; i++) src[i] = (i * 3) & 0xffff;
  const reader = new Worker(new URL(import.meta.url), { workerData: { role: 'read', sab, ms: 80 } });
  const readerDone = new Promise((resolve, reject) => {
    reader.once('message', resolve);
    reader.once('error', reject);
  });
  await new Promise((r) => setTimeout(r, 5));
  const fn = mode === 'set' ? () => writeSet(src, dst) : () => writeLoop(src, dst);
  const writer = timeIt(`e19 overlap writer ${mode}`, fn, { iterations: 200, warmup: 10 });
  const read = await readerDone;
  return {
    writerMsPerCall: writer.ms / writer.iterations,
    readerPasses: read.passes,
    readerMs: read.ms,
  };
}

async function main() {
  const args = parseArgs();
  const { Worker } = await import('node:worker_threads');
  const writers = {};
  for (const mode of ['loop', 'set']) {
    writers[mode] = await new Promise((resolve, reject) => {
      const w = new Worker(new URL(import.meta.url), { workerData: { role: 'write', mode } });
      w.once('message', resolve);
      w.once('error', reject);
    });
  }
  if (writers.loop.checksum !== writers.set.checksum) {
    throw new Error(`checksum ${writers.loop.checksum} != ${writers.set.checksum}`);
  }
  const overlap = {
    loop: await runOverlap('loop'),
    set: await runOverlap('set'),
  };
  const report = {
    feature: 'e19-query-copy',
    n: N,
    writers,
    overlap,
    setOverLoopWriter: writers.set.msPerCall / writers.loop.msPerCall,
    setOverLoopReaderPasses: overlap.set.readerPasses / overlap.loop.readerPasses,
  };
  if (args.output) writeReport(String(args.output), report);
  console.log(JSON.stringify({
    loopMs: Number(writers.loop.msPerCall.toFixed(4)),
    setMs: Number(writers.set.msPerCall.toFixed(4)),
    setOverLoopWriter: report.setOverLoopWriter,
    loopReaderPasses: overlap.loop.readerPasses,
    setReaderPasses: overlap.set.readerPasses,
    setOverLoopReaderPasses: report.setOverLoopReaderPasses,
  }, null, 2));
}

function readFor(ms, sab) {
  const view = new Uint16Array(sab);
  const t0 = performance.now();
  let passes = 0;
  let sum = 0;
  while (performance.now() - t0 < ms) {
    let s = 0;
    for (let i = 0; i < view.length; i++) s += view[i];
    sum = s;
    passes++;
  }
  return { passes, sum, ms: performance.now() - t0 };
}

const { isMainThread, workerData, parentPort } = await import('node:worker_threads');
if (!isMainThread && workerData?.role === 'write') {
  parentPort.postMessage(runWriter(workerData.mode));
} else if (!isMainThread && workerData?.role === 'read') {
  parentPort.postMessage(readFor(workerData.ms, workerData.sab));
} else if (isCli(import.meta.url)) await main();
