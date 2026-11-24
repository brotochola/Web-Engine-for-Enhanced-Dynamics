// sharedMemoryMessage.js — a message that carries shared WebAssembly memories and views of them, for every browser (N-451).
//
// The kernels' clients ask `view.buffer === memory.buffer` before they hand a column's byte to a kernel. In Chrome and
// Firefox a worker that gets a memory and its buffer in one message holds one buffer; in WebKit (Safari) it holds two
// objects on the same memory, and a memory named twice comes out as two memories, so every client refused every column:
// no sprites, and most scenes did not boot.
//
// Where the browser does that (cloneSplitsMemories), the sender writes each memory once, in a list, and a reference in
// place of every other mention of it, of its buffer and of the views on it; the receiver puts the list's memories, their
// own buffers and new views of those where the references are. Elsewhere a message goes as it is.

/** The field of a packed message that holds its memories. */
const MEMORIES = 'sharedMemories';
/** The key of a reference: the memory's place in that list. */
const REF = '$sharedMemory';

let splits = null;

/**
 * Does a structured clone here give a memory's buffer as another object than the memory's own? Asked once, with a
 * one-page memory. A browser that cannot clone a memory on the spot is taken to split them: packing is right anywhere.
 */
export function cloneSplitsMemories() {
  if (splits === null) {
    try {
      const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
      const copy = structuredClone({ memory, buffer: memory.buffer });
      splits = copy.memory.buffer !== copy.buffer;
    } catch {
      splits = true;
    }
  }
  return splits;
}

/** A plain object or an array: what a structured clone copies field by field, and what the walks below go into. */
function walks(value) {
  return Array.isArray(value) || Object.prototype.toString.call(value) === '[object Object]';
}

function collectMemories(value, memories, seen) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  if (value instanceof WebAssembly.Memory) {
    if (!memories.includes(value)) memories.push(value);
    return;
  }
  if (!walks(value)) return;
  seen.add(value);
  for (const key of Object.keys(value)) collectMemories(value[key], memories, seen);
}

/** `value` with a reference for each memory, buffer and view of `memories`; what holds none of them stays as it is. */
function packed(value, memories, done) {
  if (value === null || typeof value !== 'object') return value;
  if (done.has(value)) return done.get(value);
  if (value instanceof WebAssembly.Memory) return { [REF]: memories.indexOf(value), as: 'memory' };
  if (value instanceof SharedArrayBuffer) {
    const at = memories.findIndex((m) => m.buffer === value);
    return at < 0 ? value : { [REF]: at, as: 'buffer' };
  }
  if (ArrayBuffer.isView(value)) {
    const at = memories.findIndex((m) => m.buffer === value.buffer);
    if (at < 0) return value;
    return { [REF]: at, as: value.constructor.name, byte: value.byteOffset, length: value.length ?? value.byteLength };
  }
  if (!walks(value)) return value;
  // The copy is known before its fields are, for a message that names itself.
  const copy = Array.isArray(value) ? [] : {};
  done.set(value, copy);
  let changed = false;
  for (const key of Object.keys(value)) {
    copy[key] = packed(value[key], memories, done);
    if (copy[key] !== value[key]) changed = true;
  }
  if (!changed) done.set(value, value);
  return changed ? copy : value;
}

/**
 * `message` as a browser that splits memories must send it: a copy with references and the list of its memories, or the
 * message itself when it names none. Transferables (ports, canvases, bitmaps) keep their place.
 * @template {Record<string, any>} T
 * @param {T} message
 * @returns {T}
 */
export function packSharedMemories(message) {
  const memories = [];
  collectMemories(message, memories, new Set());
  if (memories.length === 0) return message;
  return { ...packed(message, memories, new Map()), [MEMORIES]: memories };
}

function unpacked(value, memories, seen) {
  if (value === null || typeof value !== 'object' || !walks(value)) return value;
  if (seen.has(value)) return value;
  const at = value[REF];
  if (typeof at === 'number') {
    const memory = memories[at];
    if (value.as === 'memory') return memory;
    if (value.as === 'buffer') return memory.buffer;
    return new globalThis[value.as](memory.buffer, value.byte, value.length);
  }
  seen.add(value);
  for (const key of Object.keys(value)) {
    const was = value[key];
    const now = unpacked(was, memories, seen);
    if (now !== was) value[key] = now;
  }
  return value;
}

/**
 * The receiver's side, on the message it got (changed in place, and returned): each reference becomes the memory, its
 * buffer or a view of it. A message that was not packed is returned untouched.
 * @template T
 * @param {T} message
 * @returns {T}
 */
export function unpackSharedMemories(message) {
  const memories = message?.[MEMORIES];
  if (!Array.isArray(memories)) return message;
  delete message[MEMORIES];
  return unpacked(message, memories, new Set());
}
