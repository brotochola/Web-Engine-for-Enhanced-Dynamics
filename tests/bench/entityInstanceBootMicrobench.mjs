// E-209 step 0: what a pool's entity instances cost at boot, per worker. Every logic worker makes `new EntityClass`
// for every pool slot (LogicWorker.createGameObjectInstances) and the page keeps a frozen copy of each
// (Scene._createPageInstances), whether or not the slot is ever spawned. This times both real paths on a pool of
// --entities slots and reads the heap they leave behind.
//
//   node --expose-gc tests/bench/entityInstanceBootMicrobench.mjs [--entities 100000] [--runs 5] [--output path]
//
// Boot code runs once, so each run is a cold call on fresh classes: the time includes whatever tier V8 runs it in,
// as a scene's boot does. Heap is the growth after a full GC, with the instances still referenced.
import { isCli, parseArgs, writeReport } from './microbenchHelpers.mjs';
import { loadWorker, quietly } from './workerHarness.mjs';
import { buildPoolScene } from '../helpers/poolScene.mjs';
import { GameObject } from '../../src/core/gameObject.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Scene } from '../../src/core/scene.js';

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

function heapUsed() {
  globalThis.gc();
  globalThis.gc();
  return process.memoryUsage().heapUsed;
}

/** A class like a game's: two fields of its own and a tick. A new one per run, so no run reuses another's shapes. */
function makeClass(run) {
  const C = class extends GameObject {
    hp = 3;
    target = -1;
    tick() {
      this.hp -= 1;
    }
  };
  Object.defineProperty(C, 'name', { value: `BootThing${run}` });
  C.components = [SpriteRenderer];
  return C;
}

export async function runEntityInstanceBoot({ entities = 100000, runs = 5 } = {}) {
  if (typeof globalThis.gc !== 'function') throw new Error('run with node --expose-gc');
  const n = entities | 0;
  const scene = buildPoolScene({ entities: n });
  const lw = await loadWorker('logicWorker.js', 'logicWorker');
  lw.config = scene.config;
  lw.globalEntityCount = n;
  const logicMs = [];
  const logicBytes = [];
  const pageMs = [];
  const pageBytes = [];
  for (let r = 0; r < runs; r++) {
    const C = makeClass(r);
    globalThis.self[C.name] = C;
    lw.registeredClasses = [{ name: C.name, poolSize: n, startIndex: 0, endIndex: n - 1, entityType: 0 }];
    GameObject.instances = [];
    lw.gameObjects = new Array(n);
    const before = heapUsed();
    const t0 = performance.now();
    await quietly(() => lw.createGameObjectInstances());
    logicMs.push(performance.now() - t0);
    logicBytes.push(heapUsed() - before);
    if (C.instances.length !== n) throw new Error(`logic made ${C.instances.length} instances, not ${n}`);
    lw.gameObjects = null;
    C.instances = [];
    GameObject.instances = [];

    const P = makeClass(runs + r);
    const page = { totalEntityCount: n, registeredClasses: [{ class: P, count: n, startIndex: 0 }], config: scene.config };
    const beforePage = heapUsed();
    const t1 = performance.now();
    Scene.prototype._createPageInstances.call(page);
    pageMs.push(performance.now() - t1);
    pageBytes.push(heapUsed() - beforePage);
    if (P.instances.length !== n) throw new Error(`the page made ${P.instances.length} instances, not ${n}`);
    P.instances = [];
    GameObject.instances = [];
  }
  const per = (b) => b / n;
  return {
    entities: n,
    runs,
    logic: { ms: median(logicMs), msRuns: logicMs, bytesPerSlot: per(median(logicBytes)), mb: median(logicBytes) / 1048576 },
    page: { ms: median(pageMs), msRuns: pageMs, bytesPerSlot: per(median(pageBytes)), mb: median(pageBytes) / 1048576 },
  };
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const res = await runEntityInstanceBoot({ entities: args.entities ?? 100000, runs: args.runs ?? 5 });
  const f = (x) => x.toFixed(1);
  console.log(`${res.entities} slots, ${res.runs} runs (median)`);
  console.log(`  logic worker: ${f(res.logic.ms)} ms, ${f(res.logic.mb)} MB (${f(res.logic.bytesPerSlot)} B a slot)  runs ${res.logic.msRuns.map(f).join(', ')}`);
  console.log(`  page:         ${f(res.page.ms)} ms, ${f(res.page.mb)} MB (${f(res.page.bytesPerSlot)} B a slot)  runs ${res.page.msRuns.map(f).join(', ')}`);
  if (args.output) writeReport(args.output, { kernel: 'entityInstanceBoot', ...res });
}
