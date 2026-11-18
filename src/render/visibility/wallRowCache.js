// OL-9: a lamp's row kept from frame to frame (lighting.wallCache). A row (lampWallRow.js) is a function of what goes
// into the lamp's sweep: the lamp's place and reach, the floor's scale, the walls gathered for it (each one's shape where
// the frame shows it and its code: its entity and its opacity) and, with a compound solid in reach, the polar bins its
// outline was drawn into. Pre-render gathers those every frame; this takes their signature, two 32-bit words. A row
// already in the frame's buffer under the same signature is the row the sweep would write again, so the sweep and the
// row's build are skipped: a street lamp among houses costs its gather and this, not its sweep.
//
// The signature is taken from the bits the sweep reads, not from "did anything move": no list of what can change a row
// has to be kept right. Two signatures that agree by chance would leave a stale shadow until the lamp's walls change
// again: 64 bits, far past a session's rows.

/** The signature of the last call, low and high word. Never 0 and 0, which a buffer reads as "no signature". */
export const WALL_SIG = new Uint32Array(2);

/** The lamp's x and y (world px), its radius and 1 / the floor's scale, set before the call (doubles: E-85). */
export const WALL_SIG_F64 = new Float64Array(4);
const F64_WORDS = new Uint32Array(WALL_SIG_F64.buffer);

/** Where the gather's columns start in the visibility memory, in words: cx, cy, cr, vertsX, vertsY, polarDist. */
const AT = new Int32Array(6);

/**
 * Tell the signature where the sweep's inputs are: the visibility memory's views, as pre-render holds them.
 * @param {{ cx: Float32Array, cy: Float32Array, cr: Float32Array, vertsX: Float32Array, vertsY: Float32Array, polarDist: Float32Array }} views
 * @returns {Uint32Array} the memory as words, for wallInputsSignature
 */
export function bindWallSignature(views) {
  AT[0] = views.cx.byteOffset >> 2;
  AT[1] = views.cy.byteOffset >> 2;
  AT[2] = views.cr.byteOffset >> 2;
  AT[3] = views.vertsX.byteOffset >> 2;
  AT[4] = views.vertsY.byteOffset >> 2;
  AT[5] = views.polarDist.byteOffset >> 2;
  return new Uint32Array(views.cx.buffer);
}

/**
 * The signature of a lamp's sweep inputs, into WALL_SIG. The lamp's doubles are WALL_SIG_F64.
 * @param {Uint32Array} words the visibility memory (bindWallSignature)
 * @param {Uint8Array} vertCount each gathered wall's vertices (0: a circle)
 * @param {Int32Array} vertStart where a polygon's vertices start in the pool
 * @param {number} occCount walls gathered
 * @param {Int32Array} occCodes each wall's code (wallEdgeCode: its entity's id and its opacity)
 * @param {boolean} polar whether a compound solid drew into the polar bins
 * @param {Int32Array} polarOwner each bin's entity (-1: none)
 * @param {Float32Array|null} block LightOccluder.block, a compound solid's opacity
 * @param {number} bins the polar bins
 */
export function wallInputsSignature(words, vertCount, vertStart, occCount, occCodes, polar, polarOwner, block, bins) {
  const cxAt = AT[0];
  const cyAt = AT[1];
  const crAt = AT[2];
  const vxAt = AT[3];
  const vyAt = AT[4];
  // Two words mixed apart: a multiply and a shift each, a word at a time.
  let a = 0x9e3779b9 ^ occCount;
  let b = (0x85ebca6b + occCount) | 0;
  for (let i = 0; i < 8; i++) {
    const w = F64_WORDS[i];
    a = Math.imul(a ^ w, 0x9e3779b1);
    a ^= a >>> 15;
    b = Math.imul(((b << 5) | (b >>> 27)) ^ w, 0x85ebca77);
  }
  for (let o = 0; o < occCount; o++) {
    const n = vertCount[o];
    let w = (occCodes[o] << 8) ^ n;
    a = Math.imul(a ^ w, 0x9e3779b1);
    a ^= a >>> 15;
    b = Math.imul(((b << 5) | (b >>> 27)) ^ w, 0x85ebca77);
    if (n === 0) {
      w = words[cxAt + o];
      a = Math.imul(a ^ w, 0x9e3779b1);
      a ^= a >>> 15;
      b = Math.imul(((b << 5) | (b >>> 27)) ^ w, 0x85ebca77);
      w = words[cyAt + o];
      a = Math.imul(a ^ w, 0x9e3779b1);
      a ^= a >>> 15;
      b = Math.imul(((b << 5) | (b >>> 27)) ^ w, 0x85ebca77);
      w = words[crAt + o];
      a = Math.imul(a ^ w, 0x9e3779b1);
      a ^= a >>> 15;
      b = Math.imul(((b << 5) | (b >>> 27)) ^ w, 0x85ebca77);
    } else {
      const from = vertStart[o];
      for (let v = from; v < from + n; v++) {
        w = words[vxAt + v];
        a = Math.imul(a ^ w, 0x9e3779b1);
        a ^= a >>> 15;
        b = Math.imul(((b << 5) | (b >>> 27)) ^ w, 0x85ebca77);
        w = words[vyAt + v];
        a = Math.imul(a ^ w, 0x9e3779b1);
        a ^= a >>> 15;
        b = Math.imul(((b << 5) | (b >>> 27)) ^ w, 0x85ebca77);
      }
    }
  }
  if (polar) {
    // The bins as the solids left them: how far each one's outline is, whose it is, and how much of the light it stops.
    const distAt = AT[5];
    for (let i = 0; i < bins; i++) {
      const owner = polarOwner[i];
      let w = words[distAt + i];
      a = Math.imul(a ^ w, 0x9e3779b1);
      a ^= a >>> 15;
      b = Math.imul(((b << 5) | (b >>> 27)) ^ w, 0x85ebca77);
      w = owner;
      if (owner >= 0 && block !== null) w = (owner << 8) ^ Math.round(block[owner] * 255);
      a = Math.imul(a ^ w, 0x9e3779b1);
      a ^= a >>> 15;
      b = Math.imul(((b << 5) | (b >>> 27)) ^ w, 0x85ebca77);
    }
    a ^= 0x5bd1e995;
  }
  // The last bits spread, and never 0 and 0.
  a ^= a >>> 16;
  a = Math.imul(a, 0x85ebca6b);
  a ^= a >>> 13;
  b ^= b >>> 16;
  b = Math.imul(b, 0xc2b2ae35);
  b ^= b >>> 13;
  WALL_SIG[0] = a;
  WALL_SIG[1] = b | 1;
}
