/**
 * Save and restore of a Predator-sized crowd through the shipped code (E-539, N-314). The world is Predator's: its own
 * entity classes and components (demos/predatorScene), its pools at ?crowd=2.5 and its live counts there (25 000
 * civilians, 15 000 soldiers, the map's 151 rocks, 1 764 trees and 24 houses, 100 lamps, 100 barrels, 100 bags of
 * trash, the destination: 42 240 entities), every saved column filled from a seeded PRNG (tests/helpers/saveWorld.mjs).
 * Each round runs, in order:
 *
 * - the save as a GPU loss or a hot reload takes it (captureSavePayload with allEntities and instanceFields), its parts
 *   from the save's own load marks, and the entity snapshot alone (collectSerializableEntities);
 * - the codec: the body's encode, deflate, inflate and decode (encodeBinarySaveBody, deflateBytes, inflateBytes,
 *   decodeBinarySaveBody);
 * - the load of the decoded save into the same scene (applySavePayloadToScene with allTypes), logic0's side being a
 *   real logic worker: the restoreSave message's clone (postMessage's), logic0's handler (_restoreSave), its reply's
 *   clone, and the rest of the load (instance fields back, camera).
 *
 * The checksum is FNV-1a over the bytes of every saved column of every live entity after the load; `exact` says
 * whether it equals the one taken before the save (a restore that writes any value differently, a NaN or a float's last
 * bit included, breaks it).
 *
 * Tiers: a save and a load run once per restart, so round 1 is cold, as in a page (the per-entity functions get a
 * normal compile within it, called 42 000 times; the loops over the entities run on-stack-replaced code there). The
 * warm figure is the median of the later rounds, where every loop has a normal compile. warmNormalCompile does not
 * apply: the timed code is the one-shot path itself.
 *
 * Allocations (--alloc, needs --expose-gc): the bytes each phase allocates on the JS heap, garbage included, from
 * v8.GCProfiler: a full GC before the phase, then for every GC inside it the growth of the used heap since the previous
 * GC ended (its heap statistics before minus the last one's after), plus the growth after the last one. Exact for the
 * heap V8 accounts (a test of 2 M two-field objects read 128.0 MB against 129.8 MB, the profiler's own records the
 * difference); a typed array's contents live outside that heap and are not counted. `objects` counts what the payload
 * and the restoreSave message hold, by walking them (exact).
 *
 *   node --expose-gc tests/bench/saveRestoreMicrobench.mjs [--crowd 2.5] [--rounds 5] [--alloc] [--output path]
 */
import '../helpers/registerWebRoot.mjs';
import v8 from 'node:v8';
import { isCli, parseArgs, writeReport } from './microbenchHelpers.mjs';
import { buildSaveWorld, savedColumnsChecksum } from '../helpers/saveWorld.mjs';

globalThis.window = globalThis.window || {};

const save = await import('../../src/core/save/saveGame.js');
const snapshot = await import('../../src/core/save/entitySaveSnapshot.js');
const codec = await import('../../src/core/save/binarySaveCodec.js');
const { takeLoadMarks } = await import('../../src/util/loadMarks.js');

async function predatorClasses() {
  const at = (f) => import(`../../demos/predatorScene/gameObjects/${f}.js`);
  const [civ, sol, house, lamp, tree, rock, barrel, trash, fire, explosion, dest, money, ak, pistol, shotgun] = await Promise.all([
    at('civilian'), at('mySoldier'), at('house'), at('tallLight'), at('tree'), at('rock'), at('barrel'), at('trash'),
    at('fire'), at('explosion'), at('destination'), at('dropMoney'), at('dropAk47'), at('dropPistol'), at('dropShotgun'),
  ]);
  return {
    Civilian: civ.Civilian, MySoldier: sol.MySoldier, House: house.House, TallLight: lamp.TallLight, Tree: tree.Tree,
    Rock: rock.Rock, Barrel: barrel.Barrel, Trash: trash.Trash, Fire: fire.Fire, Explosion: explosion.Explosion,
    Destination: dest.Destination, DropMoney: money.DropMoney, DropAk47: ak.DropAk47, DropPistol: pistol.DropPistol,
    DropShotgun: shotgun.DropShotgun,
  };
}

/** Predator's static entities (its pools at `crowd`) and what createNewGame spawns of each. */
function predatorEntries(K, crowd) {
  const civPool = Math.max(15000, Math.ceil(10000 * crowd));
  const solPool = Math.max(10000, Math.ceil(6000 * crowd));
  return [
    { class: K.House, pool: 2000, live: 24 },
    { class: K.TallLight, pool: 300, live: 100 },
    { class: K.Civilian, pool: civPool, live: Math.round(10000 * crowd) },
    { class: K.Tree, pool: 5000, live: 1764 },
    { class: K.Barrel, pool: 1000, live: 100 },
    { class: K.Rock, pool: 5000, live: 151 },
    { class: K.Fire, pool: 100, live: 0 },
    { class: K.Explosion, pool: 100, live: 0 },
    { class: K.MySoldier, pool: solPool, live: Math.round(6000 * crowd) },
    { class: K.Destination, pool: 1, live: 1 },
    { class: K.DropMoney, pool: 1000, live: 0 },
    { class: K.DropAk47, pool: 1000, live: 0 },
    { class: K.DropPistol, pool: 1000, live: 0 },
    { class: K.DropShotgun, pool: 1000, live: 0 },
    { class: K.Trash, pool: 100, live: 100 },
  ];
}

/** JS objects a value holds (arrays, plain objects and typed arrays), each counted once. */
export function countObjects(value) {
  const seen = new Set();
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (v === null || typeof v !== 'object' || seen.has(v)) continue;
    seen.add(v);
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer || v instanceof SharedArrayBuffer) continue;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) stack.push(v[i]);
    } else {
      for (const k in v) stack.push(v[k]);
    }
  }
  return seen.size;
}

/** The bytes `fn` allocates on the JS heap (see the header). */
async function allocatedBytes(fn) {
  globalThis.gc();
  globalThis.gc();
  const prof = new v8.GCProfiler();
  prof.start();
  const u0 = v8.getHeapStatistics().used_heap_size;
  await fn();
  const u1 = v8.getHeapStatistics().used_heap_size;
  const data = prof.stop();
  let bytes = 0;
  let prev = u0;
  for (const s of data.statistics) {
    bytes += s.beforeGC.heapStatistics.usedHeapSize - prev;
    prev = s.afterGC.heapStatistics.usedHeapSize;
  }
  bytes += u1 - prev;
  return { mb: bytes / 1048576, gcs: data.statistics.length };
}

function marksToPhases(marks) {
  const out = {};
  let prevT = null;
  for (let k = 0; k < marks.length; k += 2) {
    const name = marks[k];
    const t = marks[k + 1];
    if (prevT !== null) out[name] = t - prevT;
    prevT = t;
  }
  return out;
}

const CAPTURE = { allEntities: true, instanceFields: true, staysPaused: true, decalsCompressed: false };

/** One round: save, codec, load. Returns ms per phase, and the payloads for the object counts. */
async function round(world) {
  const { scene } = world;
  const ms = {};
  takeLoadMarks();
  const before = savedColumnsChecksum(scene);
  let t = performance.now();
  takeLoadMarks();
  const markStart = performance.now();
  const payload = await save.captureSavePayload(scene, CAPTURE);
  ms.save = performance.now() - t;
  const marks = takeLoadMarks();
  const parts = marksToPhases([`start`, performance.timeOrigin + markStart, ...marks]);
  ms.saveInstanceFields = parts['save instance fields'] ?? 0;
  ms.saveBuilt = parts['save built'] ?? 0;

  t = performance.now();
  snapshot.collectSerializableEntities(scene, { allEntities: true });
  ms.snapshot = performance.now() - t;

  t = performance.now();
  const body = codec.encodeBinarySaveBody(payload);
  ms.encode = performance.now() - t;
  t = performance.now();
  const deflated = await snapshot.deflateBytes(body);
  ms.deflate = performance.now() - t;
  t = performance.now();
  const inflated = await snapshot.inflateBytes(deflated);
  ms.inflate = performance.now() - t;
  t = performance.now();
  const decoded = { magic: snapshot.SAVE_MAGIC, formatVersion: snapshot.SAVE_FORMAT_VERSION, ...codec.decodeBinarySaveBody(inflated) };
  ms.decode = performance.now() - t;

  world.posts.length = 0;
  world.replies.length = 0;
  t = performance.now();
  const result = await save.applySavePayloadToScene(scene, decoded, { allTypes: true });
  ms.load = performance.now() - t;
  const restorePost = world.posts.find((p) => p.msg === 'restoreSave');
  const restoreReply = world.replies.find((p) => p.msg === 'restoreSaveComplete');
  ms.loadMessageClone = restorePost ? restorePost.cloneMs : 0;
  ms.loadRestoreSave = restorePost ? restorePost.handleMs : 0;
  ms.loadReplyClone = restoreReply ? restoreReply.cloneMs : 0;
  ms.loadRest = ms.load - ms.loadMessageClone - ms.loadRestoreSave - ms.loadReplyClone;
  const after = savedColumnsChecksum(scene);
  return {
    ms,
    payload,
    decoded,
    result,
    before,
    after,
    bodyBytes: body.byteLength,
    deflatedBytes: deflated.byteLength,
  };
}

/** The same phases again, one at a time, for the bytes each allocates. */
async function allocations(world) {
  const { scene } = world;
  const out = {};
  let payload;
  out.save = await allocatedBytes(async () => {
    payload = await save.captureSavePayload(scene, CAPTURE);
  });
  out.snapshot = await allocatedBytes(() => {
    snapshot.collectSerializableEntities(scene, { allEntities: true });
  });
  let body;
  out.encode = await allocatedBytes(() => {
    body = codec.encodeBinarySaveBody(payload);
  });
  let decoded;
  out.decode = await allocatedBytes(() => {
    decoded = { magic: snapshot.SAVE_MAGIC, formatVersion: snapshot.SAVE_FORMAT_VERSION, ...codec.decodeBinarySaveBody(body) };
  });
  out.load = await allocatedBytes(async () => {
    await save.applySavePayloadToScene(scene, decoded, { allTypes: true });
  });
  return out;
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : NaN;
}

export async function runSaveRestore({ crowd = 2.5, rounds = 5, alloc = false } = {}) {
  const K = await predatorClasses();
  const entries = predatorEntries(K, crowd);
  const world = await buildSaveWorld(entries);
  const live = entries.reduce((s, e) => s + e.live, 0);
  const runs = [];
  for (let r = 0; r < rounds; r++) runs.push(await round(world));
  const first = runs[0];
  const keys = Object.keys(first.ms);
  const cold = {};
  const warm = {};
  for (const k of keys) {
    cold[k] = first.ms[k];
    warm[k] = median(runs.slice(1).map((x) => x.ms[k]));
  }
  const exact = runs.every((x) => x.after.checksum === x.before.checksum);
  const report = {
    name: 'saveRestore',
    crowd,
    rounds,
    entities: live,
    pools: world.scene.totalEntityCount,
    values: first.before.values,
    restored: first.result.restored,
    failed: first.result.failed,
    bodyBytes: first.bodyBytes,
    deflatedBytes: first.deflatedBytes,
    checksum: runs[runs.length - 1].after.checksum,
    exact,
    objects: {
      payloadEntities: countObjects(first.payload.entities),
      decodedEntities: countObjects(first.decoded.entities),
    },
    coldMs: cold,
    warmMs: warm,
  };
  if (alloc) {
    if (typeof globalThis.gc !== 'function') throw new Error('--alloc needs node --expose-gc');
    report.allocMB = await allocations(world);
  }
  return report;
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const report = await runSaveRestore({ crowd: args.crowd ?? 2.5, rounds: args.rounds ?? 5, alloc: args.alloc === true });
  const f = (x) => (Number.isFinite(x) ? x.toFixed(1).padStart(8) : '       -');
  console.log(`${report.entities} entities (${report.pools} slots), ${report.values} saved values; body ${report.bodyBytes} B, deflated ${report.deflatedBytes} B`);
  console.log(`checksum ${report.checksum} (${report.exact ? 'every column restored bit for bit' : 'RESTORED DIFFERENTLY'}); restored ${report.restored}, failed ${report.failed}`);
  console.log(`objects: payload entities ${report.objects.payloadEntities}, decoded ${report.objects.decodedEntities}`);
  console.log('phase                    cold ms  warm ms' + (report.allocMB ? '   alloc MB' : ''));
  for (const k of Object.keys(report.coldMs)) {
    const a = report.allocMB && report.allocMB[k] ? `${f(report.allocMB[k].mb)} (${report.allocMB[k].gcs} GCs)` : '';
    console.log(`${k.padEnd(22)} ${f(report.coldMs[k])} ${f(report.warmMs[k])}  ${a}`);
  }
  if (args.output) writeReport(args.output, report);
}
