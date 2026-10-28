/**
 * E-147: the spatial gather's variants in Chrome (Node screens, Chrome decides: HOW_WE_MEASURE). Replays one captured
 * frame (tests/bench/spatialGatherSnapshot.mjs: the WebAssembly memory and every worker's gather_batch call) on the
 * same bytes with each variant, a fresh frame stamp per replay so each one does the frame's whole work:
 *
 *   f64    gather_batch, the shipped kernel (src/wasm/engine.wasm; float32x4 with a double edge band since E-147)
 *   f32    gather_batch_f32, the range test in float32 (tests/fixtures/wasm/spatialGatherF32.wasm)
 *   f32x4  gather_batch_f32x4, four ids of a cell a step
 *
 * Browser module (chromeKernel.mjs calls run): capture first, then
 *   node tests/bench/spatialGatherSnapshot.mjs --config rebuild
 *   node tests/bench/chromeKernel.mjs --module /tests/bench/spatialGatherReplayKernel.mjs --args '{"rounds":7}'
 * `extra` adds variants: { name: url } of another module's gather_batch (an older engine.wasm, say).
 * Reports per variant the median ms of a replayed frame (rounds alternate the variants) and, against f64, how many
 * candidate rows differ (a float32 range test may keep or drop a candidate on the edge: spatialGatherTolerance.mjs).
 */

const STAMP_MASK = 0x1fff;
/** gather_batch's argument slots (wasm/spatialGather.c GATHER_ARGS). */
const ARG = Object.freeze({ batchCount: 0, listByte: 1, candByte: 4, maxNeighbors: 5, stampFrame: 18 });

async function instantiate(url, memory) {
  const bytes = await (await fetch(url)).arrayBuffer();
  return (await WebAssembly.instantiate(bytes, { env: { memory } })).instance.exports;
}

/** The candidate rows the calls wrote, entity by entity in list order: one array per call. */
function rows(memory, calls) {
  const out = [];
  for (const c of calls) {
    const a = c.args;
    const list = new Uint16Array(memory.buffer, a[ARG.listByte], a[ARG.batchCount]);
    const cand = new Uint16Array(memory.buffer, a[ARG.candByte]);
    const stride = 1 + a[ARG.maxNeighbors];
    const got = [];
    for (let n = 0; n < list.length; n++) {
      const base = list[n] * stride;
      got.push(Array.from(cand.subarray(base, base + 1 + cand[base])).join(','));
    }
    out.push(got);
  }
  return out;
}

export async function run({ dir = '/tests/results/spatial-gather-snapshot', rounds = 7, frames = 20, warmup = 60, extra = {} } = {}) {
  const meta = await (await fetch(`${dir}/calls.json`)).json();
  const bytes = new Uint8Array(await (await fetch(`${dir}/memory.bin`)).arrayBuffer());
  const memory = new WebAssembly.Memory({ initial: meta.pages, maximum: meta.pages, shared: true });
  new Uint8Array(memory.buffer).set(bytes);
  const engine = await instantiate('/src/wasm/engine.wasm', memory);
  const test = await instantiate('/tests/fixtures/wasm/spatialGatherF32.wasm', memory);
  const variants = { f64: engine.gather_batch, f32: test.gather_batch_f32, f32x4: test.gather_batch_f32x4 };
  for (const [name, url] of Object.entries(extra)) variants[name] = (await instantiate(url, memory)).gather_batch;
  let stamp = meta.calls[0].args[ARG.stampFrame];
  const replay = (fn) => {
    stamp = (stamp % STAMP_MASK) + 1;
    let checked = 0;
    for (const c of meta.calls) {
      const a = c.args.slice();
      a[ARG.stampFrame] = stamp;
      checked += fn(...a);
    }
    return checked;
  };

  // The rows each variant writes, against f64's.
  const reference = (replay(variants.f64), rows(memory, meta.calls));
  const differ = {};
  for (const [name, fn] of Object.entries(variants)) {
    replay(fn);
    const got = rows(memory, meta.calls);
    let d = 0;
    let total = 0;
    got.forEach((list, i) => list.forEach((r, n) => {
      total++;
      if (r !== reference[i][n]) d++;
    }));
    differ[name] = { rows: total, differing: d };
  }

  for (const fn of Object.values(variants)) for (let w = 0; w < warmup; w++) replay(fn);
  const times = Object.fromEntries(Object.keys(variants).map((k) => [k, []]));
  const names = Object.keys(variants);
  for (let r = 0; r < rounds; r++) {
    const order = names.slice(r % names.length).concat(names.slice(0, r % names.length));
    for (const name of order) {
      const fn = variants[name];
      const t0 = performance.now();
      for (let f = 0; f < frames; f++) replay(fn);
      times[name].push((performance.now() - t0) / frames);
    }
  }
  const median = (a) => {
    const s = a.slice().sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const summary = {};
  for (const name of names) {
    const ms = median(times[name]);
    summary[name] = { msPerFrame: ms, vsF64Pct: 100 * (median(times.f64) / ms - 1), ...differ[name] };
  }
  return {
    config: meta.config,
    calls: meta.calls.length,
    rows: meta.calls.reduce((s, c) => s + c.args[ARG.batchCount], 0),
    rounds,
    frames,
    summary,
    times,
  };
}
