// Change record for a picture or buffer filled from a shared array.
// The game calls Layer.updateTexture. These integers stay inside the engine.

export const TEXTURE_UPLOAD_INTS = 8;
const GEN = 0;
const X = 1;
const Y = 2;
const W = 3;
const H = 4;
const SEEN = 5;
const RES = 6;
const FIELD = 7;

export function assertSharedBytes(view) {
  if (!view || typeof view.length !== 'number' || !view.buffer) {
    throw new Error('WeedJS: texture source is missing');
  }
  if (typeof SharedArrayBuffer !== 'undefined' && view.buffer instanceof SharedArrayBuffer) return view;
  throw new Error(
    'WeedJS: texture source must be a shared array. A normal typed array is only visible to one thread.',
  );
}

/**
 * Union a rectangle into the slot, then publish an even generation.
 * Odd GEN means a write is in progress. Even GEN is a stable rectangle.
 * No x means the whole picture and replaces any pending rectangle.
 * @param {Int32Array} view
 */
export function writeTextureUpload(view, x, y, w, h, fullW, fullH, resourceIndex, fieldIndex) {
  const full = x === undefined || x === null;
  let nx;
  let ny;
  let nw;
  let nh;
  if (full) {
    nx = 0;
    ny = 0;
    nw = fullW | 0;
    nh = fullH | 0;
  } else {
    nx = x | 0;
    ny = y | 0;
    nw = w | 0;
    nh = h | 0;
    if (nw < 1 || nh < 1) return;
  }
  // Several logic workers can mark the same texture. Claim the slot by moving
  // GEN from even to odd with a CAS, so two writers never merge into the
  // pending rectangle at once (the later store dropped the other's region:
  // 4 of 200 contended rounds in the probe). Held for a few stores only.
  let gen;
  for (;;) {
    gen = Atomics.load(view, GEN);
    if ((gen & 1) === 0 && Atomics.compareExchange(view, GEN, gen, (gen + 1) | 0) === gen) break;
  }
  const seen = Atomics.load(view, SEEN);
  if (!full && gen !== seen) {
    const px = Atomics.load(view, X);
    const py = Atomics.load(view, Y);
    const pw = Atomics.load(view, W);
    const ph = Atomics.load(view, H);
    const x0 = px < nx ? px : nx;
    const y0 = py < ny ? py : ny;
    const x1 = px + pw > nx + nw ? px + pw : nx + nw;
    const y1 = py + ph > ny + nh ? py + ph : ny + nh;
    nx = x0;
    ny = y0;
    nw = x1 - x0;
    nh = y1 - y0;
  }
  if (resourceIndex !== undefined && resourceIndex !== null) {
    Atomics.store(view, RES, resourceIndex | 0);
    Atomics.store(view, FIELD, fieldIndex | 0);
  }
  Atomics.store(view, X, nx);
  Atomics.store(view, Y, ny);
  Atomics.store(view, W, nw);
  Atomics.store(view, H, nh);
  Atomics.store(view, GEN, (gen + 2) | 0);
}

/**
 * Fill `out` from a stable (even) generation. A write in progress returns null
 * and leaves SEEN alone so the finished rectangle is still read later.
 * @param {Int32Array} view
 * @param {{x:number,y:number,w:number,h:number,resourceIndex:number,fieldIndex:number}} out
 */
export function readTextureUpload(view, out) {
  if (!out) return null;
  const gen = Atomics.load(view, GEN);
  if ((gen & 1) !== 0) return null;
  if (gen === Atomics.load(view, SEEN)) return null;
  out.x = Atomics.load(view, X);
  out.y = Atomics.load(view, Y);
  out.w = Atomics.load(view, W);
  out.h = Atomics.load(view, H);
  out.resourceIndex = Atomics.load(view, RES);
  out.fieldIndex = Atomics.load(view, FIELD);
  const gen2 = Atomics.load(view, GEN);
  if (gen !== gen2 || (gen2 & 1) !== 0) return null;
  Atomics.store(view, SEEN, gen2);
  return out;
}

export function bytesPerTexel(format) {
  if (format === 'r8unorm' || format === 'r8uint') return 1;
  if (format === 'rgba8unorm' || format === 'rgba8uint' || format === 'r32float') return 4;
  if (format === 'rgba32float') return 16;
  return 4;
}
