// Messages.js — entity-to-entity messages over per-logic-worker SAB inboxes.
// this.sendTo(other, 'hit', a, b, c, d) → other.onMessage('hit', from, a, b, c, d)
// on the logic worker that owns the target (target % workers), next frame,
// before tick. Names are the scene's `static messages`, so every realm maps a
// name to the same id. Numbers only: no allocation to send or deliver.

import { createMessageInbox, pushMessage, MESSAGE_HDR_OVERFLOW } from '../util/messageRing.js';

/** System message id: pre-render reports a finished non-looping animation (a = 0 sprite, 1 Adobe; b = anim/clip id). */
export const MESSAGE_ANIMATION_END = 0xffff;

export class Messages {
  /** Int32 / Float64 views of each logic worker's inbox. */
  static inboxI32 = [];
  static inboxF64 = [];
  /** id → name (the scene's static messages). */
  static names = [];
  static nameToId = new Map();
  /** Per-entity spawn generation (Uint16); bumped on every despawn. */
  static spawnGen = new Uint16Array(0);
  static _warnedUnbound = false;

  /** Scene side: one inbox per logic worker, plus the generation column. */
  static createBuffers(logicWorkerCount, capacity, entityCount) {
    const inboxes = [];
    for (let w = 0; w < logicWorkerCount; w++) inboxes.push(createMessageInbox(capacity));
    return { inboxes, spawnGen: new SharedArrayBuffer(Math.max(2, (entityCount | 0) * 2)) };
  }

  /**
   * @param {{ inboxes: SharedArrayBuffer[], spawnGen: SharedArrayBuffer } | null} buffers
   * @param {string[]} names
   */
  static bind(buffers, names) {
    this.unbind();
    if (!buffers) return;
    for (const sab of buffers.inboxes) {
      this.inboxI32.push(new Int32Array(sab));
      this.inboxF64.push(new Float64Array(sab));
    }
    this.spawnGen = new Uint16Array(buffers.spawnGen);
    const list = names || [];
    for (let i = 0; i < list.length; i++) {
      this.names.push(list[i]);
      this.nameToId.set(list[i], i);
    }
  }

  static unbind() {
    this.inboxI32 = [];
    this.inboxF64 = [];
    this.names = [];
    this.nameToId = new Map();
    this.spawnGen = new Uint16Array(0);
    this._warnedUnbound = false;
  }

  static get enabled() {
    return this.inboxI32.length > 0;
  }

  /** A despawn: messages already sent to this slot will not reach its next occupant. */
  static bumpGeneration(index) {
    const gen = this.spawnGen;
    if (index < gen.length) gen[index]++;
  }

  /**
   * @param {number} target - entity index
   * @param {string} name - one of the scene's static messages
   * @param {number} from - sender entity index, -1 for the scene
   * @returns {boolean} false when not delivered (no listener in the scene, inbox full)
   */
  static send(target, name, from, a, b, c, d) {
    if (this.inboxI32.length === 0) {
      if (!this._warnedUnbound) {
        this._warnedUnbound = true;
        console.warn(
          `WeedJS: message '${name}' was not sent: no entity type in this scene defines onMessage.`
        );
      }
      return false;
    }
    const id = this.nameToId.get(name);
    if (id === undefined) {
      throw new Error(
        `WeedJS: message '${name}' is not declared. Add it to the scene's static messages = [${this.names
          .map((n) => `'${n}'`)
          .join(', ')}${this.names.length ? ', ' : ''}'${name}'].`
      );
    }
    return this._push(target, from, id, a, b, c, d);
  }

  /** Engine messages (animation end, …): id outside the scene's names. */
  static sendSystem(target, id, a, b) {
    if (this.inboxI32.length === 0) return false;
    return this._push(target, -1, id, a, b, 0, 0);
  }

  static _push(target, from, id, a, b, c, d) {
    const w = target % this.inboxI32.length;
    const i32 = this.inboxI32[w];
    const gen = target < this.spawnGen.length ? this.spawnGen[target] : 0;
    if (pushMessage(i32, this.inboxF64[w], target, from, id, gen, +a || 0, +b || 0, +c || 0, +d || 0)) return true;
    if (Atomics.add(i32, MESSAGE_HDR_OVERFLOW, 1) === 0) {
      console.warn(
        `WeedJS: logic${w}'s message inbox is full (logic.maxMessages = ${i32[2]}); messages are dropped until it drains. ` +
          'Raise logic.maxMessages or send fewer per frame.'
      );
    }
    return false;
  }
}
