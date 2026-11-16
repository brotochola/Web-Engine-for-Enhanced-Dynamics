/**
 * The shadow stamp (wasm/shadowStamp.c stamp_light_range) under ASan. Each case is one call through the product's own
 * client (shadowStampClient.js bindShadowStamp and stampLightRangeWasm, the revision's when the harness runs a branch):
 * the stamp's scratch regions malloc'd one by one at the bytes the product's region map gives them for the call's caps
 * (renderQueueMemoryRegions), with maxSun the call's caster count, maxLights its light count and maxPerEntity its own, so
 * a region holds exactly what the call may use; the sun rows and the stamp rows (GPU queue regions in the product) as
 * long as the call's casters and its stampCap. The ASan kernel runs, then the shipped one (engine.wasm, bound by the
 * same client on the same memory), each after its scratch is filled with a byte of its own: the two must write the same
 * cursor, rows and light indices, so a kernel that read scratch it had not written shows too.
 * Frames: shadowStampWasm.test.js's random frames (tests/helpers/shadowStampFrames.mjs), the same frames as keyed rows
 * (shadowStampKeyed.test.js), shadowStampSelect.test.js's selection frames (ported below), and edge cases: caster counts
 * around the sizes the kernel treats apart (16, 64, 256), budgets around them, a grid of exactly 128 x 128 cells and one
 * past it, short scratch, a stamp that ends exactly at its last row or one before, cursors at or past the cap, no lights,
 * empty light slots, begins and strides past the end, lights out of the casters' box or at the ring walk's bounds.
 */
import { bytesOf, firstDifference, placedViews, relocateLayout, rng, snapshot } from '../asanCases.mjs';

const MAX = 3000;
const LIGHTS = 24;
const PER_ENTITY = 3;
const SF = 22;
const LIGHT_FLOAT = 18;
const KF = 7;
const KS = 11;
const GRID_CELLS = 128 * 128;

async function imports(ctx) {
  const [client, map, rqm, gql, frames] = await Promise.all([
    ctx.importRepo('src/render/shadowStampClient.js'),
    ctx.importRepo('src/util/wasmMemoryMap.js'),
    ctx.importRepo('src/util/renderQueueMemory.js'),
    ctx.importRepo('src/render/gpuQueueLayout.js'),
    ctx.importRepo('tests/helpers/shadowStampFrames.mjs'),
  ]);
  const { GPU_PACK_COLUMNS } = await ctx.importRepo('src/render/gpuPackClient.js');
  return { client, map, rqm, gql, frames, tableBytes: rqm.GPU_PACK_TABLE_SLOTS * GPU_PACK_COLUMNS.length * 4 };
}

/** The product's stamp layout for these caps (field names and bytes as the revision lays them), cached by caps. */
const layoutCache = new Map();
function productStampLayout(S, stamp) {
  const key = `${stamp.maxSun}|${stamp.maxPerEntity}|${stamp.maxLights}`;
  let hit = layoutCache.get(key);
  if (!hit) {
    const map = S.map.renderQueueMemoryRegions(64, 64, 1, S.tableBytes, null, stamp);
    const mem = S.rqm.createRenderQueueMemory(1, 64, 64, null, stamp);
    if (!mem || mem.layout.stamp.tableByte !== map.regions.stampTable.byte) {
      throw new Error('shadowStamp: the region map and createRenderQueueMemory disagree on the stamp table');
    }
    hit = { map, layout: mem.layout.stamp };
    layoutCache.set(key, hit);
  }
  return hit;
}

/**
 * One stamp call under ASan and on the shipped kernel. f: { nSun, rows (the casters' rows, f.sf floats each), sf, df,
 * lightFloat, lights, lightBegin, lightStride, maxPerLight, maxPerEntity, stampCap, stampBase } and optionally maxSun /
 * maxLights / maxPerEntityCap (the regions' caps, else the call's own), tmpLen, gridCountsLen, gridItemsLen, noGrid,
 * noLightIdx, exact (the stamp sized to the rows the call writes: 0 that many, -1 one fewer).
 */
async function stampCall(ctx, S, f) {
  const { session } = ctx;
  const sf = f.sf ?? SF;
  const df = f.df ?? SF;
  const maxSun = f.maxSun ?? f.nSun;
  const maxLights = f.maxLights ?? f.lights.length;
  const maxPE = f.maxPerEntityCap ?? Math.max(0, f.maxPerEntity | 0);
  const stampSpec = { maxSun, maxPerEntity: maxPE, maxLights };
  const product = productStampLayout(S, stampSpec);
  const { layout, placed } = relocateLayout(session, product.map, product.layout, 'stamp');
  const sun = session.alloc(Float32Array, maxSun * sf, 'sun rows', maxSun * SF);
  sun.set(f.rows.subarray(0, f.nSun * sf));
  const b = await S.client.bindShadowStamp(session.memory, layout);
  const shipped = b.stampRange;
  const asan = session.fn('stamp_light_range');
  const spec = (stamp, lightIdx, cap) => ({
    sun,
    sunN: f.nSun,
    sunFloats: sf,
    lights: f.lights,
    lightBegin: f.lightBegin | 0,
    lightEnd: f.lights.length,
    lightStride: f.lightStride | 0,
    maxPerLight: f.maxPerLight | 0,
    maxPerEntity: f.maxPerEntity | 0,
    used: null,
    tmpIdx: new Uint32Array(f.tmpLen ?? maxSun),
    dist: new Float32Array(maxSun),
    order: new Uint32Array(maxSun),
    keepIdx: new Uint32Array(maxSun),
    gridCounts: f.noGrid ? null : new Int32Array(f.gridCountsLen ?? GRID_CELLS),
    gridStarts: f.noGrid ? null : new Int32Array((f.gridCountsLen ?? GRID_CELLS) + 1),
    gridItems: f.noGrid ? null : new Uint32Array(f.gridItemsLen ?? maxSun),
    lightVec: new Float32Array(4),
    stamp,
    stampFloats: df,
    stampCap: cap,
    stampBase: f.stampBase | 0,
    stampLightIdx: lightIdx,
    lightFloat: f.lightFloat,
  });
  let cap = f.stampCap;
  if (f.exact !== undefined) {
    // The rows this call writes, from the shipped kernel on a stamp with room for all of them.
    const room = session.alloc(Float32Array, cap * df, 'stamp rows (probe)');
    const idx = session.alloc(Uint16Array, cap, 'stamp light index (probe)');
    b.stampRange = shipped;
    const end = S.client.stampLightRangeWasm(b, spec(room, idx, cap));
    cap = Math.max(0, end + f.exact);
  }
  const stamp = session.alloc(Float32Array, cap * df, 'stamp rows', f.productStamp ? f.productStamp * SF : 0);
  const lightIdx = f.noLightIdx ? null : session.alloc(Uint16Array, cap, 'stamp light index', f.productStamp ?? 0);
  const scratch = placedViews(session, placed, ['stampLights', 'stampTable', 'cookieQueue']);
  const run = (fn, fill) => {
    for (const v of scratch) v.fill(fill);
    bytesOf(stamp).fill(0xa5);
    if (lightIdx) bytesOf(lightIdx).fill(0xa5);
    b.stampRange = fn;
    const cursor = S.client.stampLightRangeWasm(b, spec(stamp, lightIdx, cap));
    return { cursor, rows: snapshot(stamp), idx: lightIdx ? snapshot(lightIdx) : null };
  };
  const got = run(asan, 0xa5);
  const want = run(shipped, 0x5a);
  const out = { calls: 1, rows: Math.max(0, want.cursor - (f.stampBase | 0)), mismatch: null };
  if (got.cursor !== want.cursor) {
    out.mismatch = `cursor ${got.cursor}, the shipped kernel's ${want.cursor}`;
  } else {
    const at = firstDifference(got.rows, want.rows);
    if (at >= 0) out.mismatch = `stamp row ${Math.floor(at / (df * 4))} float ${Math.floor((at % (df * 4)) / 4)} differs from the shipped kernel's`;
    else if (lightIdx) {
      const ai = firstDifference(got.idx, want.idx);
      if (ai >= 0) out.mismatch = `light index of row ${ai >> 1} differs from the shipped kernel's`;
    }
  }
  return out;
}

/** The full rows of a frame as keyed rows (shadowStampKeyed.test.js): x, y, the caster's key, 0, the shadow terms. */
function keyedRows(rows, nSun) {
  const out = new Float32Array(Math.max(1, nSun) * KF);
  for (let c = 0; c < nSun; c++) {
    const s = c * SF;
    const d = c * KF;
    out[d] = rows[s];
    out[d + 1] = rows[s + 1];
    out[d + 2] = c;
    out[d + 3] = 0;
    out[d + 4] = rows[s + 15];
    out[d + 5] = rows[s + 16];
    out[d + 6] = rows[s + 17];
  }
  return out;
}

// --- shadowStampSelect.test.js's selection frames (selectFrame and its helpers, ported; the frames are its own) -------

const W = 2400;
const H = 1400;
const BUDGETS = [1, 2, 3, 7, 15, 16, 31, 32, 33, 63, 64, 65, 100, 300, 511, 512, 513, 5000];
const MAX_PER_LIGHT = [0, 1, 15, 32, 64, 65, 512];
const KINDS = 13;

function writeCasters(rows, xy, r) {
  const n = xy.length >> 1;
  for (let c = 0; c < n; c++) {
    const b = c * SF;
    rows[b] = xy[2 * c];
    rows[b + 1] = xy[2 * c + 1];
    for (let f = 2; f < SF; f++) rows[b + f] = r();
  }
  return n;
}

function crowd(xy, r, n, x0 = 0, y0 = 0, w = W, h = H) {
  for (let c = 0; c < n; c++) xy.push(x0 + r() * w, y0 + r() * h);
}

function rings(xy, cx, cy, pairs) {
  for (const [a, b] of pairs) {
    const pts = new Set();
    for (const [u, v] of [[a, b], [b, a]]) {
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) pts.add(`${cx + sx * u},${cy + sy * v}`);
    }
    for (const p of pts) {
      const [x, y] = p.split(',').map(Number);
      xy.push(x, y);
    }
  }
}

function light(x, y, range, maxShadows, r) {
  return { x, y, intensity: 0.5 + r() * 2, rangeSq: range * range, maxShadows };
}

function cone(L, r, invG = 1) {
  const a = r() * Math.PI * 2;
  const half = 0.2 + r() * 1.6;
  L.coneDirX = Math.cos(a);
  L.coneDirYW = Math.sin(a) * invG;
  L.coneCos = Math.cos(half);
  L.coneInvSpan = 1 / Math.max(Math.cos(half * (1 - r())) - L.coneCos, 0.002);
  L.invG2 = invG * invG;
  return L;
}

function candidateKeys(rows, nSun, L) {
  if (!L || !(L.rangeSq > 0) || !(L.intensity > 0) || L.coneCos > -1) return [];
  const keys = [];
  for (let c = 0; c < nSun; c++) {
    const dx = rows[c * SF] - L.x;
    const dy = rows[c * SF + 1] - L.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > L.rangeSq || Number.isNaN(d2)) continue;
    keys.push(Math.fround(d2));
  }
  return keys.sort((a, b) => a - b);
}

function tieRun(keys, from = 0) {
  for (let k = from; k + 1 < keys.length; k++) {
    if (keys[k] !== keys[k + 1]) continue;
    let e = k + 1;
    while (e < keys.length && keys[e] === keys[k]) e++;
    return [k, e];
  }
  return null;
}

function longestRun(keys) {
  let best = null;
  for (let k = 0; k < keys.length;) {
    let e = k + 1;
    while (e < keys.length && keys[e] === keys[k]) e++;
    if (e - k > 1 && (!best || e - k > best[1] - best[0])) best = [k, e];
    k = e;
  }
  return best;
}

function selectFrame(r, k, rows) {
  const kind = k % KINDS;
  const xy = [];
  const lights = [];
  let maxPerLight = MAX_PER_LIGHT[(k >> 1) % MAX_PER_LIGHT.length];
  const maxPerEntity = [0, 1, PER_ENTITY][Math.floor(k / KINDS) % 3];
  const budget = () => BUDGETS[Math.floor(r() * BUDGETS.length)];
  if (kind === 0) {
    crowd(xy, r, 2600 + Math.floor(r() * 300));
    const n = 8 + Math.floor(r() * (LIGHTS - 8));
    for (let i = 0; i < n; i++) lights.push(light(r() * W, r() * H, 150 + r() * 260, r() < 0.3 ? 0 : budget(), r));
  } else if (kind === 1 || kind === 9) {
    const cx = 900 + Math.floor(r() * 600);
    const cy = 500 + Math.floor(r() * 400);
    rings(xy, cx, cy, [[3, 4], [0, 5], [6, 8], [1, 7], [5, 5], [9, 12], [8, 15], [12, 16], [7, 24], [20, 21], [15, 20]]);
    crowd(xy, r, 900, cx - 300, cy - 300, 600, 600);
    maxPerLight = 0;
    lights.push(light(cx, cy, 120, 0, r));
    lights.push(light(cx, cy, 200, 0, r));
    lights.push(light(cx + 0.5, cy - 0.25, 160, budget(), r));
  } else if (kind === 2) {
    const sx = 1000 + r() * 400;
    const sy = 600 + r() * 200;
    crowd(xy, r, 1500, sx - 400, sy - 400, 800, 800);
    for (let q = 0; q < 40; q++) xy.push(Math.fround(sx + 37.25), Math.fround(sy - 12.5));
    maxPerLight = 0;
    for (let i = 0; i < 6; i++) lights.push(light(sx + (r() - 0.5) * 120, sy + (r() - 0.5) * 120, 250, 0, r));
  } else if (kind === 3) {
    const cx = 800 + Math.floor(r() * 800);
    const cy = 400 + Math.floor(r() * 600);
    rings(xy, cx, cy, [[2, 3], [4, 7]]);
    crowd(xy, r, 1200, cx - 350, cy - 350, 700, 700);
    maxPerLight = 0;
    lights.push(light(cx, cy, 300, 0, r));
    lights.push(light(cx, cy, 300, 0, r));
  } else if (kind === 4) {
    crowd(xy, r, 20 + Math.floor(r() * 60));
    maxPerLight = 0;
    const n = 4 + Math.floor(r() * 10);
    for (let i = 0; i < n; i++) lights.push(light(r() * W, r() * H, 400 + r() * 900, r() < 0.5 ? budget() : 64, r));
  } else if (kind === 5) {
    crowd(xy, r, 2500);
    const invG = [1, 0.7, 0.5][k % 3];
    const n = 8 + Math.floor(r() * (LIGHTS - 8));
    for (let i = 0; i < n; i++) {
      const L = light(r() * W, r() * H, 180 + r() * 220, r() < 0.3 ? 0 : budget(), r);
      if (r() < 0.6) cone(L, r, 1 / invG);
      if (r() < 0.4) {
        L.shade = r();
        if (!(L.invG2 > 0)) L.invG2 = 1 / (invG * invG);
      }
      lights.push(L);
    }
  } else if (kind === 6) {
    crowd(xy, r, 2000, 200, 200, 1800, 1000);
    lights.push(light(-150, 700, 400, budget(), r));
    lights.push(light(2300, 1300, 500, budget(), r));
    lights.push(light(1000, -380, 400, budget(), r));
    lights.push(light(-90, -90, 450, budget(), r));
    lights.push({ x: 1100, y: 600, intensity: 1, rangeSq: Infinity, maxShadows: budget() });
    lights.push({ x: 1100.5, y: 600.5, intensity: 1, rangeSq: 1e30, maxShadows: budget() });
    for (let i = 0; i < 6; i++) lights.push(light(200 + r() * 1800, 200 + r() * 1000, 200 + r() * 200, budget(), r));
  } else if (kind === 7) {
    crowd(xy, r, 2200);
    const sub = Math.floor(k / KINDS) % 3;
    if (sub === 0) xy.push(NaN, 700, 900, NaN, NaN, NaN);
    else if (sub === 1) xy.push(Infinity, 600, 1200, -Infinity);
    else xy.push(3.5e7, 800);
    lights.push(light(100, 100, 300, budget(), r));
    const n = 6 + Math.floor(r() * 10);
    for (let i = 0; i < n; i++) lights.push(light(r() * W, r() * H, 200 + r() * 200, budget(), r));
  } else if (kind === 8) {
    const x0 = 2e7;
    for (let c = 0; c < 2000; c++) xy.push(Math.fround(x0 + r() * 3000), Math.fround(x0 + r() * 2000));
    const n = 6 + Math.floor(r() * 8);
    for (let i = 0; i < n; i++) lights.push(light(x0 + r() * 3000, x0 + r() * 2000, 200 + r() * 200, budget(), r));
  } else if (kind === 10) {
    crowd(xy, r, 2900, 700, 300, 900, 900);
    maxPerLight = 0;
    const n = 4 + Math.floor(r() * 6);
    for (let i = 0; i < n; i++) {
      lights.push(light(1150 + (r() - 0.5) * 200, 750 + (r() - 0.5) * 200, 380 + r() * 120, [512, 700, 1000, 1500, 2000, 15, 64][i % 7], r));
    }
  } else if (kind === 11) {
    const cx = 1200.25;
    const cy = 700.75;
    for (const [rho, n, jitter] of [[40, 60, 0.002], [90, 120, 0.0005], [150, 90, 0.00003], [210, 70, 0]]) {
      const a0 = r() * Math.PI * 2;
      for (let j = 0; j < n; j++) {
        const a = a0 + (j / n) * Math.PI * 2;
        const d = rho + (r() - 0.5) * jitter;
        xy.push(Math.fround(cx + d * Math.cos(a)), Math.fround(cy + d * Math.sin(a)));
      }
    }
    crowd(xy, r, 600, cx - 260, cy - 260, 520, 520);
    maxPerLight = 0;
    lights.push(light(cx, cy, 250, 0, r));
    lights.push(light(cx, cy, 250, 0, r));
    lights.push(light(cx, cy, 250, 0, r));
  } else if (kind === 12) {
    xy.push(0, 0);
    crowd(xy, r, 2400, 0, 0, W, H);
    for (let q = 0; q < 150; q++) xy.push(256 * (1 + Math.floor(r() * 8)), r() * H);
    for (let q = 0; q < 150; q++) xy.push(r() * W, 256 * (1 + Math.floor(r() * 4)));
    maxPerLight = 0;
    const offs = [0, 0, 0.5, -0.5, 3, -3, 20, -20, 1e-9, -1e-9];
    const n = 10 + Math.floor(r() * (LIGHTS - 10));
    for (let i = 0; i < n; i++) {
      const x = 256 * (1 + Math.floor(r() * 8)) + offs[Math.floor(r() * offs.length)] + (r() < 0.3 ? r() * 256 : 0);
      const y = 256 * (1 + Math.floor(r() * 4)) + offs[Math.floor(r() * offs.length)] + (r() < 0.3 ? r() * 256 : 0);
      lights.push(light(x, y, 120 + r() * 300, [1, 2, 7, 15, 16, 31, 32, 33, 63, 64][i % 10], r));
    }
  }
  const nSun = writeCasters(rows, xy, r);
  const keysOf = (L) => candidateKeys(rows, nSun, L);
  if (kind === 1) {
    for (const L of lights.slice(0, 2)) {
      const run = tieRun(keysOf(L), Math.floor(r() * 12));
      L.maxShadows = run ? run[0] + 1 + Math.floor(r() * (run[1] - run[0] - 1)) : 1 + Math.floor(r() * 20);
    }
  } else if (kind === 9) {
    lights[0].maxShadows = 1;
    lights[1].maxShadows = 1;
  } else if (kind === 11) {
    const keys = keysOf(lights[0]);
    const within = (rho) => keys.filter((d) => d < (rho - 1) * (rho - 1)).length;
    lights[0].maxShadows = within(90) + 1 + Math.floor(r() * 110);
    lights[1].maxShadows = within(150) + 1 + Math.floor(r() * 80);
    lights[2].maxShadows = within(40) + 1 + Math.floor(r() * 50);
  } else if (kind === 2) {
    lights.forEach((L, i) => {
      const run = longestRun(keysOf(L));
      if (!run) return;
      const [a, e] = run;
      L.maxShadows = [a + 1 + Math.floor(r() * (e - a - 1)), e, Math.max(1, a)][i % 3];
    });
  } else if (kind === 3) {
    const keys = keysOf(lights[0]);
    let lim = 20 + Math.floor(r() * 10);
    while (lim < keys.length && keys[lim - 1] === keys[lim]) lim++;
    lights[0].maxShadows = lim;
    lights[1].maxShadows = 6;
  } else if (kind === 4) {
    lights.slice(0, 3).forEach((L, i) => {
      const m = keysOf(L).length;
      if (m > 1) L.maxShadows = m + [0, -1, 1][i];
    });
  }
  return {
    nSun,
    lights,
    maxPerLight,
    maxPerEntity,
    lightBegin: k % 13 === 12 ? 1 : 0,
    lightStride: k % 11 === 10 ? 2 : 1,
    stampCap: k % 17 === 16 ? Math.floor(r() * 300) : null,
    stampBase: k % 19 === 18 ? 5 : 0,
    shortTmp: kind === 0 && k % 20 === 10,
  };
}

// --- edge cases ---------------------------------------------------------------------------------------------------------

/** n casters at random in a box, the rest of each row random. */
function casterRows(r, n, x0, y0, w, h) {
  const rows = new Float32Array(Math.max(1, n) * SF);
  for (let c = 0; c < n; c++) {
    rows[c * SF] = x0 + r() * w;
    rows[c * SF + 1] = y0 + r() * h;
    for (let f = 2; f < SF; f++) rows[c * SF + f] = r();
  }
  return rows;
}

function edgeCases(r) {
  const cases = [];
  const one = (label, f) => cases.push({ label, f });
  const lightAt = (x, y, range, maxShadows, extra = {}) => ({ x, y, intensity: 1.25, rangeSq: range * range, maxShadows, ...extra });
  const base = { lightBegin: 0, lightStride: 1, maxPerLight: 0, stampBase: 0 };
  // Caster counts around 16 (E-358's count blocks), 64 (KNN_MAX_LIM, SEL_MIN), 256 (SEL_BINS: the radix select's
  // histogram in cellOf) and budgets around them and the count, one light over every caster; maxShadowsPerEntity 0, 1, 3.
  for (const n of [1, 2, 3, 15, 16, 17, 31, 32, 33, 63, 64, 65, 255, 256, 257, 300]) {
    for (const maxPE of [0, 1, PER_ENTITY]) {
      for (const lim of [...new Set([1, n - 1, n, n + 1, 15, 64, 65, 0])].filter((x) => x >= 0)) {
        const rows = casterRows(r, n, 1000, 1000, 400, 400);
        const lights = [lightAt(1200, 1200, 600, lim)];
        // A second light that keeps a few, so maxShadowsPerEntity has more than one light a caster.
        if (maxPE > 0) lights.push(lightAt(1100.5, 1250.25, 700, 3));
        one(`${n} casters, budget ${lim}, maxPE ${maxPE}`, { ...base, nSun: n, rows, lights, maxPerEntity: maxPE, stampCap: n * lights.length + 4 });
        // The same with a cone light and a dim one (their own copies of the walk and of the rows).
        if (lim === n || lim === 15) {
          const coneLights = [
            lightAt(1200, 1200, 600, lim, { coneDirX: 1, coneDirYW: 0, coneCos: 0.2, coneInvSpan: 5, invG2: 1 }),
            lightAt(1150, 1180, 650, 0, { shade: 0.4, invG2: 1 }),
          ];
          one(`${n} casters, budget ${lim}, maxPE ${maxPE}, cone and dim lights`, { ...base, nSun: n, rows, lights: coneLights, maxPerEntity: maxPE, stampCap: n * 2 + 4 });
        }
      }
    }
  }
  // The grid at its most cells (128 x 128: gridStarts' last entry) and one column past it (the full scan).
  for (const [cols, label] of [[128, 'a grid of exactly 128 x 128 cells'], [129, 'one column past the grid\'s cells']]) {
    const n = 2000;
    const rows = casterRows(r, n, 0, 0, (cols - 1) * 256 + 255, 127 * 256 + 255);
    rows[0] = 0;
    rows[1] = 0;
    rows[SF] = (cols - 1) * 256 + 255.5;
    rows[SF + 1] = 127 * 256 + 255.5;
    const lights = [];
    for (let i = 0; i < 12; i++) lights.push(lightAt(r() * cols * 256, r() * 128 * 256, 300 + r() * 3000, [0, 1, 15, 64, 65, 300][i % 6]));
    for (const maxPE of [0, PER_ENTITY]) one(`${label}, maxPE ${maxPE}`, { ...base, nSun: n, rows, lights, maxPerEntity: maxPE, stampCap: 4000 });
  }
  // Short scratch: the candidates stop at tmpCap (0, 1, 5, one under the casters); a grid refused for its counts or items.
  {
    const n = 500;
    const rows = casterRows(r, n, 0, 0, 1500, 900);
    const lights = [lightAt(700, 450, 2000, 0), lightAt(300, 300, 400, 20), lightAt(900, 500, 800, 70)];
    for (const tmpLen of [0, 1, 5, n - 1]) {
      for (const maxPE of [0, PER_ENTITY]) one(`tmpCap ${tmpLen}, maxPE ${maxPE}`, { ...base, nSun: n, rows, lights, maxPerEntity: maxPE, stampCap: 3 * n, tmpLen });
    }
    one('a grid refused: one count cell', { ...base, nSun: n, rows, lights, maxPerEntity: 0, stampCap: 3 * n, gridCountsLen: 1 });
    one('a grid refused: items under the casters', { ...base, nSun: n, rows, lights, maxPerEntity: 0, stampCap: 3 * n, gridItemsLen: n - 1 });
    one('no grid', { ...base, nSun: n, rows, lights, maxPerEntity: PER_ENTITY, stampCap: 3 * n, noGrid: true });
    one('no light index', { ...base, nSun: n, rows, lights, maxPerEntity: PER_ENTITY, stampCap: 3 * n, noLightIdx: true });
    // A stamp that ends exactly at the call's last row, or one row before it; a cursor at or past the cap.
    for (const maxPE of [0, PER_ENTITY]) {
      one(`a stamp exactly full, maxPE ${maxPE}`, { ...base, nSun: n, rows, lights, maxPerEntity: maxPE, stampCap: 3 * n, exact: 0 });
      one(`a stamp one row short, maxPE ${maxPE}`, { ...base, nSun: n, rows, lights, maxPerEntity: maxPE, stampCap: 3 * n, exact: -1 });
      one(`a stamp with room for one row, maxPE ${maxPE}`, { ...base, nSun: n, rows, lights, maxPerEntity: maxPE, stampCap: 1 });
      one(`a stamp of no rows, maxPE ${maxPE}`, { ...base, nSun: n, rows, lights, maxPerEntity: maxPE, stampCap: 0 });
      one(`the cursor at the cap, maxPE ${maxPE}`, { ...base, nSun: n, rows, lights, maxPerEntity: maxPE, stampCap: 7, stampBase: 7 });
      one(`the cursor past the cap, maxPE ${maxPE}`, { ...base, nSun: n, rows, lights, maxPerEntity: maxPE, stampCap: 7, stampBase: 9 });
    }
    // No lights; only empty slots; a begin at or past the end; a stride past the end.
    one('no lights', { ...base, nSun: n, rows, lights: [], maxPerEntity: PER_ENTITY, stampCap: 10 });
    one('only empty light slots', { ...base, nSun: n, rows, lights: [null, null, null], maxPerEntity: PER_ENTITY, stampCap: 10 });
    one('lights without range or intensity', {
      ...base, nSun: n, rows, maxPerEntity: PER_ENTITY, stampCap: 10,
      lights: [lightAt(1, 1, 0, 0), { x: 5, y: 5, intensity: 0, rangeSq: 1e6, maxShadows: 0 }, { x: 5, y: 5, intensity: 1, rangeSq: NaN, maxShadows: 0 }],
    });
    one('a begin at the end', { ...base, nSun: n, rows, lights, maxPerEntity: PER_ENTITY, stampCap: 3 * n, lightBegin: 3 });
    one('a begin past the end', { ...base, nSun: n, rows, lights, maxPerEntity: 0, stampCap: 3 * n, lightBegin: 5 });
    one('a stride past the end', { ...base, nSun: n, rows, lights, maxPerEntity: PER_ENTITY, stampCap: 3 * n, lightStride: 7 });
    one('the last light only', { ...base, nSun: n, rows, lights, maxPerEntity: PER_ENTITY, stampCap: 3 * n, lightBegin: 2, lightStride: 2 });
    // Lights far out of the casters' box, at the ring walk's bounds (KNN_LIGHT_MAX) and just past them.
    const far = [lightAt(-5000, 450, 300, 15), lightAt(700, 99999, 2000, 15), lightAt(1073741824, 0, 1e10, 15),
      lightAt(-1073741824.5, 10, 1e10, 15), lightAt(3e9, 3e9, 1e10, 15), lightAt(700, 450, 1e-3, 15)];
    for (const maxPE of [0, PER_ENTITY]) one(`lights far out and at the ring walk's bounds, maxPE ${maxPE}`, { ...base, nSun: n, rows, lights: far, maxPerEntity: maxPE, stampCap: 3 * n });
  }
  // E-359 (opt/stamp-rows): the light vec4s go into dist when 4 x the lights fit in min(tmpCap, casters): exactly, one
  // light past it; and rows of a layout that is neither full nor keyed (copy_row, the light float by float).
  for (const [n, capL] of [[8, 2], [12, 3], [11, 3], [16, 4], [17, 4], [15, 4]]) {
    const rows = casterRows(r, n, 0, 0, 200, 200);
    const lights = [];
    for (let i = 0; i < capL; i++) lights.push(lightAt(100 + i, 100 - i, 500, 0));
    one(`${n} casters, ${capL} lights, maxPE ${PER_ENTITY}`, { ...base, nSun: n, rows, lights, maxPerEntity: PER_ENTITY, stampCap: n * capL });
    const coneL = lights.map((L, i) => (i === 0 ? { ...L, coneDirX: 0, coneDirYW: 1, coneCos: -0.5, coneInvSpan: 3, invG2: 1 } : L));
    one(`${n} casters, ${capL} lights (a cone among them), maxPE ${PER_ENTITY}`, { ...base, nSun: n, rows, lights: coneL, maxPerEntity: PER_ENTITY, stampCap: n * capL });
  }
  {
    const n = 300;
    const rows = casterRows(r, n, 0, 0, 900, 900);
    const lights = [lightAt(400, 400, 500, 0), lightAt(200, 600, 300, 10, { coneDirX: 0, coneDirYW: 1, coneCos: 0.1, coneInvSpan: 4, invG2: 1 })];
    for (const maxPE of [0, 1]) {
      one(`rows of their own layout (22 floats, the light at 20 of 26), maxPE ${maxPE}`, { ...base, nSun: n, rows, lights, maxPerEntity: maxPE, stampCap: 2 * n, df: 26, lightFloat: 20 });
    }
  }
  // Many lights over few casters with every one at the same distance (maxShadowsPerEntity's replacement and its ties).
  {
    const n = 40;
    const rows = casterRows(r, n, 500, 500, 2, 2);
    const lights = [];
    for (let i = 0; i < LIGHTS; i++) lights.push(lightAt(501, 501, 300, i % 3 === 0 ? 0 : 1 + (i % 5)));
    for (const maxPE of [1, 2, PER_ENTITY]) one(`${LIGHTS} lights on one spot, maxPE ${maxPE}`, { ...base, nSun: n, rows, lights, maxPerEntity: maxPE, stampCap: n * LIGHTS });
  }
  return cases;
}

export default {
  name: 'shadowStamp',
  sources: ['wasm/shadowStamp.c'],
  exports: ['stamp_light_range'],

  async groups(ctx) {
    const S = await imports(ctx);
    const quick = ctx.quick;
    const lighting = { enabled: true, shadowsEnabled: true, maxShadowCastingLights: LIGHTS, maxShadowsPerLight: 64, maxShadowsPerEntity: PER_ENTITY, maxLights: 64 };
    const caps = S.gql.gpuQueueCaps(MAX, lighting);
    const allCaps = S.gql.gpuQueueCaps(MAX, { ...lighting, maxShadowsPerLight: 0, maxShadowsPerEntity: 0 });
    const groups = [];

    // shadowStampWasm.test.js's frames (its generator), full rows then keyed rows (shadowStampKeyed.test.js).
    const nFrames = quick ? 40 : 240;
    const randomCases = (keyed) => {
      const r = S.frames.rng(keyed ? 191 : 0x5ea1);
      const dst = { sun: new Float32Array(MAX * SF) };
      const cases = [];
      for (let k = 0; k < (keyed ? Math.min(nFrames, 120) : nFrames); k++) {
        const f = S.frames.frame(r, k, caps, dst);
        const rows = keyed ? keyedRows(dst.sun, f.nSun) : dst.sun.slice(0, Math.max(1, f.nSun) * SF);
        const stampCap = Math.min(f.stampCap, caps.maxStamp);
        cases.push({
          label: `frame ${k} (${f.nSun} casters, ${f.lights.length} lights, maxPL ${f.maxPerLight}, maxPE ${f.maxPerEntity})`,
          run: (c) => stampCall(c, S, {
            ...f, rows, stampCap, productStamp: caps.maxStamp,
            ...(keyed ? { sf: KF, df: KS, lightFloat: KF } : {}),
          }),
        });
      }
      return cases;
    };
    groups.push({ label: 'shadowStampWasm frames, full rows', cases: randomCases(false) });
    groups.push({ label: 'shadowStampWasm frames, keyed rows', cases: randomCases(true) });

    // shadowStampSelect.test.js's selection frames.
    {
      const r = rng(0x5e1ec7);
      const cases = [];
      const nSel = quick ? 2 * KINDS : 15 * KINDS;
      for (let k = 0; k < nSel; k++) {
        const rows = new Float32Array(MAX * SF);
        const f = selectFrame(r, k, rows);
        const stampCap = f.stampCap ?? allCaps.maxStamp;
        cases.push({
          label: `selection frame ${k} (kind ${k % KINDS}, ${f.nSun} casters, ${f.lights.length} lights, maxPL ${f.maxPerLight}, maxPE ${f.maxPerEntity})`,
          run: (c) => stampCall(c, S, { ...f, rows, stampCap, productStamp: allCaps.maxStamp, tmpLen: f.shortTmp ? 400 : undefined }),
        });
      }
      groups.push({ label: 'shadowStampSelect frames', cases });
    }

    // Edge cases.
    {
      const r = rng(0xed6e);
      const all = edgeCases(r);
      const cases = (quick ? all.filter((_, i) => i % 5 === 0) : all).map(({ label, f }) => ({ label, run: (c) => stampCall(c, S, f) }));
      groups.push({ label: 'edge cases', cases });
    }
    return groups;
  },
};
