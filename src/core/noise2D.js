/** Perlin 2D (improved 2002). Perm table is local — seed both threads if they must match. */

const PERM_SIZE = 256;

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a, b, t) {
  return a + t * (b - a);
}

function grad(hash, x, y) {
  const h = hash & 3;
  const u = h < 2 ? x : y;
  const v = h < 2 ? y : x;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

function hashSeed(seed) {
  let t = (seed >>> 0) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
}

function shufflePerm(seed) {
  const perm = new Uint8Array(PERM_SIZE * 2);
  for (let i = 0; i < PERM_SIZE; i++) perm[i] = i;
  let s = hashSeed(seed);
  const rand = () => {
    s = hashSeed(s + 1);
    return s / 4294967296;
  };
  for (let i = PERM_SIZE - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    const tmp = perm[i];
    perm[i] = perm[j];
    perm[j] = tmp;
  }
  for (let i = 0; i < PERM_SIZE; i++) perm[PERM_SIZE + i] = perm[i];
  return perm;
}

export class Noise2D {
  /**
   * @param {number} [seed=1]
   */
  constructor(seed = 1) {
    this._perm = shufflePerm(seed);
    this._seed = seed | 0;
  }

  get seed() {
    return this._seed;
  }

  /**
   * Rebuild permutation. Allocates once; never call from a hot sample loop.
   * @param {number} seed
   */
  reseed(seed) {
    this._seed = seed | 0;
    this._perm = shufflePerm(this._seed);
    return this;
  }

  /**
   * Classic Perlin 2D in approx [-1, 1]. Zero alloc.
   * @param {number} x
   * @param {number} y
   * @returns {number}
   */
  sample(x, y) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const ix = x0 & 255;
    const iy = y0 & 255;
    const p = this._perm;
    const aa = p[p[ix] + iy];
    const ab = p[p[ix] + iy + 1];
    const ba = p[p[ix + 1] + iy];
    const bb = p[p[ix + 1] + iy + 1];
    const u = fade(fx);
    const v = fade(fy);
    return lerp(
      lerp(grad(aa, fx, fy), grad(ba, fx - 1, fy), u),
      lerp(grad(ab, fx, fy - 1), grad(bb, fx - 1, fy - 1), u),
      v
    );
  }

  /**
   * Fractal Brownian motion. Zero alloc.
   * @param {number} x
   * @param {number} y
   * @param {number} [octaves=4]
   * @param {number} [freq=1]
   * @param {number} [amp=1]
   * @param {number} [lacunarity=2]
   * @param {number} [gain=0.5]
   * @returns {number}
   */
  fbm(x, y, octaves = 4, freq = 1, amp = 1, lacunarity = 2, gain = 0.5) {
    let sum = 0;
    let a = amp;
    let f = freq;
    const n = octaves | 0;
    for (let o = 0; o < n; o++) {
      sum += this.sample(x * f, y * f) * a;
      f *= lacunarity;
      a *= gain;
    }
    return sum;
  }

  /**
   * Write 1D height samples into caller buffer. `out[i] = sample(x0 + i*dx, ySlice)`.
   * @param {Float32Array} out
   * @param {number} x0
   * @param {number} dx
   * @param {number} count
   * @param {number} [ySlice=0]
   * @returns {Float32Array}
   */
  fillHeight1D(out, x0, dx, count, ySlice = 0) {
    const n = count | 0;
    for (let i = 0; i < n; i++) {
      out[i] = this.sample(x0 + i * dx, ySlice);
    }
    return out;
  }

  static _default = null;

  static _ensure() {
    if (!Noise2D._default) Noise2D._default = new Noise2D(1);
    return Noise2D._default;
  }

  static seed(seed) {
    Noise2D._ensure().reseed(seed);
  }

  static sample(x, y) {
    return Noise2D._ensure().sample(x, y);
  }

  static fbm(x, y, octaves, freq, amp, lacunarity, gain) {
    return Noise2D._ensure().fbm(x, y, octaves, freq, amp, lacunarity, gain);
  }

  static fillHeight1D(out, x0, dx, count, ySlice) {
    return Noise2D._ensure().fillHeight1D(out, x0, dx, count, ySlice);
  }
}
