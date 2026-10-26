/**
 * The tolerance of a float32 shadow stamp (wasm/test/shadowStampF32.c) against the shipped double one
 * (WASM_HYPOTHESES "Open decisions" 5). Used by shadowStampWasmMicrobench's float32 variants for their checksum
 * and by tests/node/shadowStampF32.test.js.
 *
 * A stamp row is a copy: the caster's sun row, then the light's vec4 as floats. Float32 maths cannot change a
 * value, only which casters a light keeps (and in which order) where two of its distances, or a distance and
 * its range, lie within float rounding of each other, and, with maxShadowsPerEntity, which lights a caster
 * keeps where two of their distances do. So the comparison is of (light, caster) pairs:
 *
 *   - every row of the variant is a valid copy: its caster bytes are a sun row's, its light vec4 is the light's
 *     (Math.fround of x, y, intensity, rangeSq), its light index one the call walks;
 *   - the pairs are the reference's, in the reference's order, except
 *       order swaps: at a position where the two differ, the two casters' (or lights') distances are within
 *       tolerance of each other (a sort of tied values);
 *       flips: a pair only one side has. Each is a tie: within tolerance of the light's selection boundary
 *       (its keep-th and keep+1-th nearest candidates, exact distances) or of its range; with
 *       maxShadowsPerEntity, a caster that such a tie touched (its candidate lights changed), or a light whose
 *       distance to the caster is within tolerance of a light the other side kept instead.
 *
 * Tolerance, per (light, caster): tau = 2^-23 (|lx| + |ly|) + 2^-22 d + 2^-40 px. The float32 distance is off
 * the exact one by at most 2^-24 (|lx| + |ly|) (the light rounded to float) plus about 2.5 * 2^-24 d (the
 * subtraction, the squares, the sum); tau is twice that. A pair of distances is tied when they differ by at most
 * the sum of their tau. At Predator's coordinates (under 8 000 px) tau is about 2e-3 px: no flip can be seen.
 *
 * Both outputs must be uncapped (a stamp cap cuts the row list where the counts put it; a capped output is a
 * prefix of the uncapped one, which the caller checks).
 */

export const TAU_LIGHT = 2 ** -23;
export const TAU_DIST = 2 ** -22;
export const TAU_ABS = 2 ** -40;

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const bitsOf = (v) => {
  f32[0] = v;
  return u32[0];
};

export function tau(lx, ly, d) {
  return TAU_LIGHT * (Math.abs(lx) + Math.abs(ly)) + TAU_DIST * d + TAU_ABS;
}

/** The lights the call walks, as stampLightRange walks them, with their selection limit. */
function walkedLights(spec) {
  const out = [];
  const stride = (spec.lightStride | 0) > 0 ? spec.lightStride | 0 : 1;
  const maxPL = spec.maxPerLight | 0;
  const nSun = spec.sunN | 0;
  for (let i = Math.max(0, spec.lightBegin | 0); i < (spec.lightEnd | 0); i += stride) {
    const L = spec.lights[i];
    if (!L || !(L.rangeSq > 0) || !(L.intensity > 0)) continue;
    let lim;
    if (L.maxShadows > 0) {
      const ms = L.maxShadows | 0;
      lim = maxPL > 0 ? Math.min(maxPL, ms) : ms;
    } else {
      lim = maxPL > 0 ? maxPL : nSun;
    }
    out.push({ i, L, lim });
  }
  return out;
}

/**
 * Compare a variant's stamp with the reference's.
 * @param {object} spec stampLightRange's spec (sun, sunN, sunFloats, lights, lightBegin, lightEnd, lightStride,
 *   maxPerLight, maxPerEntity, stampFloats, stampBase)
 * @param {number} lightAt the light vec4's first float in a row (GPU_CASTER_LIGHT_FLOAT)
 * @param {{ cursor: number, stamp: Float32Array, lightIdx: Uint16Array }} ref the double kernel, uncapped
 * @param {{ cursor: number, stamp: Float32Array, lightIdx: Uint16Array }} out the variant, uncapped
 */
export function compareStamps(spec, lightAt, ref, out) {
  const sun = spec.sun;
  const sf = spec.sunFloats | 0;
  const df = spec.stampFloats | 0;
  const base = spec.stampBase | 0;
  const nSun = spec.sunN | 0;
  const maxPE = Math.max(0, spec.maxPerEntity | 0);
  const problems = [];
  const report = { rows: out.cursor - base, identical: false, orderSwaps: 0, flips: 0, tiedPairs: 0, worstFlipPx: 0, worstFlipTauPx: 0, problems };

  // The casters by the bytes a row copies from them (the floats before the light vec4).
  const keyOfCaster = new Array(nSun);
  const castersOfKey = new Map();
  const sunU32 = new Uint32Array(sun.buffer, sun.byteOffset, sun.length);
  for (let c = 0; c < nSun; c++) {
    let key = '';
    for (let f = 0; f < lightAt; f++) key += `${sunU32[c * sf + f]},`;
    keyOfCaster[c] = key;
    if (!castersOfKey.has(key)) castersOfKey.set(key, c);
  }
  const walked = walkedLights(spec);
  const walkedByIndex = new Map(walked.map((w) => [w.i, w]));

  const decode = (o, side) => {
    const rows = [];
    const words = new Uint32Array(o.stamp.buffer, o.stamp.byteOffset, o.stamp.length);
    for (let k = base; k < o.cursor; k++) {
      const li = o.lightIdx[k];
      let key = '';
      for (let f = 0; f < lightAt; f++) key += `${words[k * df + f]},`;
      const c = castersOfKey.get(key);
      const w = walkedByIndex.get(li);
      if (c === undefined) {
        problems.push(`${side} row ${k}: not a copy of a sun row`);
        continue;
      }
      if (!w) {
        problems.push(`${side} row ${k}: light ${li} is not one the call walks`);
        continue;
      }
      const L = w.L;
      const vec = [L.x, L.y, L.intensity, L.rangeSq];
      for (let q = 0; q < 4; q++) {
        const want = bitsOf(vec[q]);
        const got = words[k * df + lightAt + q];
        if (got !== want && !(Number.isNaN(o.stamp[k * df + lightAt + q]) && Number.isNaN(vec[q]))) {
          problems.push(`${side} row ${k}: light vec4 float ${q} is not light ${li}'s`);
        }
      }
      rows.push({ li, c, key, pair: `${li}|${key}` });
    }
    return rows;
  };
  const R = decode(ref, 'reference');
  const F = decode(out, 'variant');
  if (problems.length) return { ...report, ok: false };

  const dist = (li, c) => {
    const L = walkedByIndex.get(li).L;
    const dx = sun[c * sf] - L.x;
    const dy = sun[c * sf + 1] - L.y;
    return Math.sqrt(dx * dx + dy * dy);
  };
  const tauOf = (li, c) => {
    const L = walkedByIndex.get(li).L;
    return tau(L.x, L.y, dist(li, c));
  };

  // Each light's exact selection boundary: the keep-th and keep+1-th nearest candidates.
  const boundary = new Map();
  for (const w of walked) {
    const ds = [];
    for (let c = 0; c < nSun; c++) {
      const dx = sun[c * sf] - w.L.x;
      const dy = sun[c * sf + 1] - w.L.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > w.L.rangeSq) continue;
      ds.push({ c, d: Math.sqrt(d2) });
    }
    ds.sort((p, q) => (p.d < q.d ? -1 : p.d > q.d ? 1 : p.c - q.c));
    const limited = w.lim > 0 && ds.length > w.lim;
    boundary.set(w.i, {
      lastKept: limited ? ds[w.lim - 1].d : NaN,
      firstOut: limited ? ds[w.lim].d : NaN,
      range: Math.sqrt(w.L.rangeSq),
      rank: new Map(ds.map((p, k) => [p.c, k])),
    });
  }
  /** A light-level tie: c sits within tolerance of li's selection boundary or of its range. */
  const lightTie = (li, c) => {
    const bnd = boundary.get(li);
    const d = dist(li, c);
    if (Number.isNaN(d)) return 0; // a NaN distance has no place in the JS selection's order
    const t = tauOf(li, c);
    if (Math.abs(d - bnd.range) <= t + TAU_LIGHT * bnd.range) return Math.abs(d - bnd.range);
    if (Number.isNaN(bnd.lastKept)) return -1;
    const rank = bnd.rank.get(c);
    const other = rank !== undefined && rank < walkedByIndex.get(li).lim ? bnd.firstOut : bnd.lastKept;
    const L = walkedByIndex.get(li).L;
    const gap = Math.abs(d - other);
    return gap <= t + tau(L.x, L.y, other) ? gap : -1;
  };
  // The pairs within tolerance of a light's boundary (NaN distances left out of the count), and with
  // maxShadowsPerEntity the casters they touch.
  const casterTouched = new Set();
  for (const w of walked) {
    for (let c = 0; c < nSun; c++) {
      if (lightTie(w.i, c) < 0) continue;
      if (!Number.isNaN(dist(w.i, c))) report.tiedPairs++;
      if (maxPE > 0) casterTouched.add(keyOfCaster[c]);
    }
  }
  if (R.length === F.length && R.every((r, k) => r.pair === F[k].pair)) {
    report.identical = true;
    return { ...report, ok: true };
  }

  // Multiset difference of pairs: what only one side has, and the rest of each side in its order.
  const excess = new Map();
  for (const r of R) excess.set(r.pair, (excess.get(r.pair) || 0) + 1);
  for (const r of F) excess.set(r.pair, (excess.get(r.pair) || 0) - 1);
  const split = (list, sign) => {
    const left = new Map(excess);
    const only = [];
    const rest = [];
    for (const r of list) {
      const e = (left.get(r.pair) || 0) * sign;
      if (e > 0) {
        only.push(r);
        left.set(r.pair, left.get(r.pair) - sign);
      } else {
        rest.push(r);
      }
    }
    return { only, rest };
  };
  const { only: onlyR, rest: restR } = split(R, 1);
  const { only: onlyF, rest: restF } = split(F, -1);

  // The shared pairs in their order: each position that differs swaps tied values.
  for (let k = 0; k < restR.length; k++) {
    const a = restR[k];
    const b = restF[k];
    if (a.pair === b.pair) continue;
    report.orderSwaps++;
    const da = dist(a.li, a.c);
    const db = dist(b.li, b.c);
    const sameGroup = maxPE > 0 ? a.key === b.key : a.li === b.li;
    if (!sameGroup || Math.abs(da - db) > tauOf(a.li, a.c) + tauOf(b.li, b.c)) {
      problems.push(`shared pair ${k}: light ${b.li} caster ${b.c} where the reference has light ${a.li} caster ${a.c} (${db} px against ${da} px)`);
    }
  }
  if (!onlyF.length && !onlyR.length) return { ...report, ok: problems.length === 0 };

  const explain = (r, others) => {
    const g = lightTie(r.li, r.c);
    if (g >= 0) return { gap: g, tau: tauOf(r.li, r.c) };
    if (maxPE > 0) {
      if (casterTouched.has(r.key)) return { gap: 0, tau: tauOf(r.li, r.c) };
      const d = dist(r.li, r.c);
      for (const o of others) {
        if (o.key !== r.key) continue;
        const gap = Math.abs(d - dist(o.li, o.c));
        if (gap <= tauOf(r.li, r.c) + tauOf(o.li, o.c)) return { gap, tau: tauOf(r.li, r.c) + tauOf(o.li, o.c) };
      }
    }
    return null;
  };
  report.flips = onlyF.length + onlyR.length;
  for (const [list, others, side] of [[onlyF, onlyR, 'only the variant'], [onlyR, onlyF, 'only the reference']]) {
    for (const r of list) {
      const e = explain(r, others);
      if (!e) {
        problems.push(`${side} keeps light ${r.li} with caster ${r.c} (${dist(r.li, r.c)} px), not a tie`);
        continue;
      }
      if (e.gap > report.worstFlipPx) {
        report.worstFlipPx = e.gap;
        report.worstFlipTauPx = e.tau;
      }
    }
  }
  return { ...report, ok: problems.length === 0 };
}
