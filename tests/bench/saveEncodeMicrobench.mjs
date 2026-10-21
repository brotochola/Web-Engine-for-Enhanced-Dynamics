/**
 * Save time on the main thread (E-49): the entity snapshot and the binary
 * encode, through the shipped functions, for a Predator-sized population of
 * serializable entities with the core components.
 *
 *   node tests/bench/saveEncodeMicrobench.mjs [--entities 4000] [--output path]
 *
 * The checksum is FNV-1a over the encoded bytes: a change that claims to keep
 * the format must keep it.
 */
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { collectSerializableEntities } from '../../src/core/save/entitySaveSnapshot.js';
import { encodeBinarySaveBody } from '../../src/core/save/binarySaveCodec.js';
import { checksumInts, isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { mulberry32 } from './benchMath.js';

const COMPONENTS = [Transform, RigidBody, Collider, SpriteRenderer];

function fillRandom(arr, rnd) {
  if (!arr || typeof arr.length !== 'number') return;
  for (let i = 0; i < arr.length; i++) {
    arr[i] = arr instanceof Float32Array || arr instanceof Float64Array ? rnd() * 1000 : (rnd() * 200) | 0;
  }
}

/** Component arrays for n entities, four serializable types, every entity active. */
export function savePopulation(n, seed = 0x5a7e) {
  const rnd = mulberry32(seed);
  for (const C of COMPONENTS) {
    C.initializeArrays(new SharedArrayBuffer(C.getBufferSize(n)), n);
    for (const name of Object.keys(C.ARRAY_SCHEMA)) fillRandom(C[name], rnd);
  }
  // Pose and velocity live on the physics heap in a scene; plain arrays here.
  for (const name of ['x', 'y', 'rotC', 'rotS']) Transform[name] = new Float32Array(n).map(() => rnd() * 1000);
  for (const name of ['vx', 'vy', 'angularVelocity']) RigidBody[name] = new Float32Array(n).map(() => rnd() * 100);
  RigidBody.sleeping = new Uint8Array(n);
  Transform.active.fill(1);

  const types = 4;
  const per = Math.ceil(n / types);
  const registeredClasses = [];
  for (let t = 0; t < types; t++) {
    const indices = new Uint32Array(Math.max(0, Math.min(per, n - t * per)));
    for (let k = 0; k < indices.length; k++) indices[k] = t * per + k;
    const EntityClass = {
      [`Unit${t}`]: class {
        static serializable = true;
        static _componentClassMap = { Transform, RigidBody, Collider, SpriteRenderer };
        static getAllActive() {
          return indices;
        }
      },
    }[`Unit${t}`];
    registeredClasses.push({ class: EntityClass });
  }
  return { registeredClasses };
}

function payloadOf(entities) {
  return {
    sceneName: 'SaveBench',
    engineVersion: '0',
    layout: { types: [], totalEntityCount: entities.length },
    camera: null,
    sun: null,
    entities,
    joints: [],
  };
}

function main() {
  const args = parseArgs();
  const n = args.entities || 4000;
  const scene = savePopulation(n);
  const entities = collectSerializableEntities(scene);
  const bytes = encodeBinarySaveBody(payloadOf(entities));
  const checksum = checksumInts(bytes, bytes.length);

  const snapshot = timeIt(`snapshot ${n} entities`, (iters) => {
    for (let k = 0; k < iters; k++) collectSerializableEntities(scene);
  }, { iterations: 3, warmup: 2 });
  const encode = timeIt(`encode ${n} entities`, (iters) => {
    for (let k = 0; k < iters; k++) encodeBinarySaveBody(payloadOf(entities));
  }, { iterations: 3, warmup: 2 });

  const report = {
    name: 'saveEncode',
    entities: n,
    bytes: bytes.length,
    checksum,
    snapshot: { msPerSave: snapshot.ms / snapshot.iterations, opsPerSec: snapshot.opsPerSec },
    encode: { msPerSave: encode.ms / encode.iterations, opsPerSec: encode.opsPerSec },
  };
  console.log(`${n} entities, ${bytes.length} bytes: snapshot ${report.snapshot.msPerSave.toFixed(1)} ms, encode ${report.encode.msPerSave.toFixed(1)} ms per save (checksum ${checksum})`);
  writeReport(args.output || 'tests/results/save-encode/kernel.json', report);
}

if (isCli(import.meta.url)) main();
