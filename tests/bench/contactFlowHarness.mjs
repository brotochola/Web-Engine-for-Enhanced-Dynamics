/**
 * Shared setup for the contact-flow kernel and its parity test: a real
 * LogicWorker (workerHarness) with the Box2D contact ring bound the way
 * `box2dReady` binds it, plus callback-recording game objects.
 */
import { Transform } from '../../src/components/transform.js';
import {
  BOX2D_CONTACT_KIND,
  bindContactRing,
  createContactRingSab,
  publishContactEvent,
} from '../../src/box2d/box2dContactRing.js';
import { coreComponentData, initWorker, loadWorker, quietly } from './workerHarness.mjs';

export { BOX2D_CONTACT_KIND, publishContactEvent };

/** Records callbacks when `log` is an array; counts them otherwise. */
export class ContactRecorder {
  constructor(index, log) {
    this.index = index;
    this.log = log;
    this.stays = 0;
  }
  onCollisionEnter(other) {
    if (this.log) this.log.push(`enter ${this.index} ${other}`);
  }
  onCollisionStay(other) {
    this.stays++;
    if (this.log) this.log.push(`stay ${this.index} ${other}`);
  }
  onCollisionExit(other) {
    if (this.log) this.log.push(`exit ${this.index} ${other}`);
  }
}

let _logicCtor = null;

export async function logicWorkerClass() {
  if (!_logicCtor) _logicCtor = (await loadWorker('logicWorker.js', 'logicWorker')).constructor;
  return _logicCtor;
}

/**
 * @param {{ n: number, workerIndex?: number, totalWorkers?: number, Ctor?: Function, log?: string[] | null, types?: Uint16Array | null }} opts
 */
export async function createContactWorker(opts) {
  const n = opts.n;
  const Base = await logicWorkerClass();
  const Ctor = opts.Ctor || Base;
  const worker = await quietly(() => new Ctor(globalThis.self));
  const bodyGeneration = new SharedArrayBuffer(n * 4);
  await initWorker(worker, {
    config: { logic: { numberOfLogicWorkers: opts.totalWorkers ?? 3 } },
    globalEntityCount: n,
    buffers: { componentData: coreComponentData(n), bodyGeneration },
    extra: { workerIndex: opts.workerIndex ?? 0 },
  });
  const ring = createContactRingSab(65536);
  bindContactRing(ring);
  worker.box2dContactRingI32 = new Int32Array(ring);
  worker.box2dContactCursor = 0;
  worker.useBox2dContacts = true;
  worker.anyTypeNeedsCollisions = true;
  let maxType = 0;
  for (let i = 0; i < n; i++) {
    Transform.active[i] = 1;
    const t = opts.types ? opts.types[i] : 0;
    Transform.entityType[i] = t;
    if (t > maxType) maxType = t;
  }
  worker.collisionListenerByType = new Uint8Array(maxType + 1).fill(1);
  const objects = worker.gameObjects;
  for (let i = 0; i < n; i++) objects[i] = new ContactRecorder(i, opts.log || null);
  return { worker, gen: new Int32Array(bodyGeneration), ring };
}

export function begin(a, b, gen) {
  publishContactEvent(BOX2D_CONTACT_KIND.CONTACT_BEGIN, a, b, gen[a], gen[b]);
}

export function end(a, b, gen) {
  publishContactEvent(BOX2D_CONTACT_KIND.CONTACT_END, a, b, gen[a], gen[b]);
}
