import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';

// N-146: physics's wait for the logic workers' frame (E-198, weedjsPost's waitForLogic), run as shipped. It waited in
// 0.25 ms slices, answering sync queries between them, and below 1 ms V8's Atomics.wait spins on Windows: physics
// burned a core as long as it waited. It now sleeps on the frame chain's bell ([2]), which a logic worker rings at
// its frame's end and when it posts a sync query (box2dSyncSlotImpl's post), and answers the queries each time it rings.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const post = readFileSync(join(root, 'src/box2d/weedjsPost.js'), 'utf8');

function loadWait() {
  const start = post.indexOf('// chain-wait-start');
  const end = post.indexOf('// chain-wait-end');
  assert.ok(start >= 0 && end > start, 'the chain wait block is missing in weedjsPost.js');
  return new Function('env', `
    let { chainI32, chainLogicWorkers } = env;
    let chainSeen = 0, chainOffUntil = 0, chainSteps = 0, chainStepMs = env.stepMs, chainPeriodMs = env.periodMs;
    let chainLastStart = NaN, chainWaited = 0;
    const serviceQueryAabb = env.service, serviceOverlapCircle = () => {}, serviceRayCast = () => {};
    const serviceCastRayAll = () => {}, serviceLiquidFunQuery = () => {}, serviceLiquidFunExtract = () => {};
    ${post.slice(start, end)}
    return { wait() { waitForLogic(); return { waited: chainWaited, offUntil: chainOffUntil, steps: chainSteps }; } };
  `);
}

// A thread that, once go() is called, spins until each event's time and then rings the bell (and adds frames).
const RINGER = `
const { workerData, parentPort } = require('node:worker_threads');
const a = new Int32Array(workerData.sab);
const go = new Int32Array(workerData.go);
parentPort.postMessage('ready');
Atomics.wait(go, 0, 0);
const t0 = performance.now();
for (const e of workerData.events) {
  while (performance.now() - t0 < e.at);
  if (e.frames) Atomics.add(a, 0, e.frames);
  Atomics.add(a, 2, 1);
  Atomics.notify(a, 2);
}
`;

async function ringer(sab, events) {
  const go = new Int32Array(new SharedArrayBuffer(4));
  const w = new Worker(RINGER, { eval: true, workerData: { sab, events, go: go.buffer } });
  await new Promise((resolve) => w.once('message', resolve));
  return {
    go() {
      Atomics.store(go, 0, 1);
      Atomics.notify(go, 0);
    },
    stop: () => w.terminate(),
  };
}

test('physics sleeps until the bell rings: a query posted mid-wait is answered, the frames end the wait', async () => {
  const chain = new Int32Array(new SharedArrayBuffer(16));
  let services = 0;
  // A long frame (40 ms, an own step of 1 ms: a budget of 16 ms) leaves room for a slow test machine.
  const w = loadWait()({ chainI32: chain, chainLogicWorkers: 2, stepMs: 1, periodMs: 40, service: () => { services++; } });
  const r = await ringer(chain.buffer, [{ at: 3 }, { at: 6, frames: 1 }, { at: 9, frames: 1 }]);
  r.go();
  const out = w.wait();
  await r.stop();
  assert.equal(Atomics.load(chain, 0), 2, 'both logic frames in');
  assert.ok(out.waited >= 8, `it waited for the second frame (${out.waited.toFixed(2)} ms)`);
  // One pass before it sleeps, one per ring (3). The 0.25 ms slices made one every 0.25 ms: about 36 here.
  assert.ok(services >= 3 && services <= 5, `a service pass per ring, not per slice (${services})`);
  assert.equal(out.offUntil, 0, 'within the budget: not turned off');
});

test('no logic frame within the budget turns the waits off for 120 steps', () => {
  const chain = new Int32Array(new SharedArrayBuffer(16));
  let services = 0;
  // A 2 ms budget (period 40, own step 32, 6 for pre-render and Pixi).
  const w = loadWait()({ chainI32: chain, chainLogicWorkers: 1, stepMs: 32, periodMs: 40, service: () => { services++; } });
  const out = w.wait();
  assert.ok(out.waited >= 2, `it waited out the budget (${out.waited.toFixed(2)} ms)`);
  assert.equal(out.offUntil, out.steps + 120);
  assert.ok(services <= 3, `no ring, no pass but the first (${services})`);
});

test('a sync query post rings the chain bell of the worker that posts it', async () => {
  await import('../../src/box2d/box2dSyncSlotImpl.js');
  const Slot = globalThis.Box2dSyncSlot;
  const slot = new Int32Array(new SharedArrayBuffer(16));
  const chain = new Int32Array(new SharedArrayBuffer(16));
  Slot.setChainBell(chain);
  Slot.post(slot);
  assert.equal(Atomics.load(slot, 0), Slot.STATUS_PENDING);
  assert.equal(Atomics.load(chain, Slot.CHAIN_BELL), 1, 'rung');
  Slot.setChainBell(null);
  Slot.post(slot);
  assert.equal(Atomics.load(chain, Slot.CHAIN_BELL), 1, 'no bell bound: not rung');
});
