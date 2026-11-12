#!/usr/bin/env node
/**
 * E-187: the keyed statics scatter on WebGPU (src/render/webgpu/staticsScatterGpu.js) run on the browser's GPU and read
 * back: a statics buffer of `keys` rows (three vec4<u32> each) filled with a marker, `n` full updates to random keys
 * (16 u32 each: the row's 12 words, the key, three zeros) and `nt` texture updates (a key, a word), then the buffer
 * against the same scatter done on the CPU (the rows first, then each texture update's word 6). A second frame of
 * updates over the same buffer checks the bind groups are reused or remade right. A check, not a timing.
 *
 *   node tests/bench/chromeKernel.mjs --headed --module /tests/bench/staticsScatterGpuCheck.mjs [--args '{"n":5000}']
 */
export async function run({ root = '', keys = 20000, n = 5000, nt = 3000, seed = 187 } = {}) {
  const { createStaticsScatterGpu, scatterStaticsGpu } = await import(`${root}/src/render/webgpu/staticsScatterGpu.js`);
  if (!navigator.gpu) return { ok: false, why: 'no navigator.gpu' };
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return { ok: false, why: 'no adapter' };
  const device = await adapter.requestDevice();
  const errors = [];
  device.addEventListener('uncapturederror', (e) => errors.push(String(e.error?.message || e.error)));
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s;
  };
  const words = keys * 12;
  const expect = new Uint32Array(words);
  for (let i = 0; i < words; i++) expect[i] = 0xdead0000 + (i & 0xffff);
  const statics = device.createBuffer({
    size: words * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    mappedAtCreation: true,
  });
  new Uint32Array(statics.getMappedRange()).set(expect);
  statics.unmap();
  const state = createStaticsScatterGpu(device);
  const frames = [];
  for (let frame = 0; frame < 2; frame++) {
    const count = frame === 0 ? n : n >> 3;
    const texCount = frame === 0 ? nt : nt >> 3;
    // Unique keys a frame, as the keyed pack writes them (a key's updates carry one statics row).
    const used = new Set();
    const updates = new Uint32Array(count * 16);
    for (let u = 0; u < count; u++) {
      let key;
      do key = rnd() % keys; while (used.has(key));
      used.add(key);
      for (let w = 0; w < 12; w++) updates[u * 16 + w] = rnd();
      updates[u * 16 + 12] = key;
      expect.set(updates.subarray(u * 16, u * 16 + 12), key * 12);
    }
    const tex = new Uint32Array(texCount * 2);
    const texUsed = new Set();
    for (let u = 0; u < texCount; u++) {
      let key;
      do key = rnd() % keys; while (texUsed.has(key));
      texUsed.add(key);
      tex[u * 2] = key;
      tex[u * 2 + 1] = rnd();
    }
    for (let u = 0; u < texCount; u++) expect[tex[u * 2] * 12 + 6] = tex[u * 2 + 1];
    const t0 = performance.now();
    scatterStaticsGpu(state, statics, updates, count, tex, texCount);
    frames.push({ count, texCount, submitMs: performance.now() - t0 });
  }
  const read = device.createBuffer({ size: words * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(statics, 0, read, 0, words * 4);
  device.queue.submit([enc.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const got = new Uint32Array(read.getMappedRange().slice(0));
  read.unmap();
  let bad = 0;
  let first = -1;
  for (let i = 0; i < words; i++) {
    if (got[i] !== expect[i]) {
      if (first < 0) first = i;
      bad++;
    }
  }
  device.destroy();
  return {
    ok: bad === 0 && errors.length === 0,
    keys,
    frames,
    wrongWords: bad,
    firstWrong: first < 0 ? null : { word: first, got: got[first], want: expect[first] },
    errors,
  };
}
