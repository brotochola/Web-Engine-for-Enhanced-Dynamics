// E-488: how the Pixi worker gets a GPU particle ring's fresh records to the GPU. Each frame `rings` writer workers
// (the logic workers' arms) write `fresh` records of 112 bytes into their ring of one shared WebAssembly.Memory, then
// this page sends each ring's new range up, one of three ways, timed on the CPU (performance.now around the frame's
// copies and upload calls, summed over `frames`):
//
//   set     the engine's route before E-488: the range copied out of the shared memory into the ring's own array
//           (TypedArray.set of pre-made 256-record views, the ends word by word), then uploaded from that array
//   wasm    W30's route: the range copied by memory.copy into an unshared memory (sharedCopy.js's arena), then uploaded
//   direct  uploaded straight from the shared memory: writeBuffer's data and texSubImage2D's pixels a view of it
//   mapped  WebGPU only: the ranges copied (TypedArray.set) into a staging buffer mapped ahead (MAP_WRITE, four of
//           them in turn), unmapped and copied into the rings' buffers by copyBufferToBuffer; no writeBuffer
//
// WebGPU: queue.writeBuffer of the range into the ring's vertex buffer (a range across the ring end as its two pieces),
// one empty submit a frame. WebGL2: texSubImage2D into the ring's RGBA32UI record texture (seven texels a record, 512
// records a row, the engine's layout): set and wasm send the rows the range is on, whole (as the engine did); direct
// sends only the range's texels (a partial first row, the whole rows, a partial last one), since the rest of those rows
// in the shared memory may be records a writer is still writing. After the timed frames, each backend reads one ring
// back from the GPU and compares it with the shared memory, word for word.
//
// Headed (a real GPU):
//   MSYS_NO_PATHCONV=1 node tests/bench/chromeKernel.mjs --headed --module /tests/bench/chrome/gpuRingUploadKernel.mjs \
//     [--args '{"rings":4,"capacity":1048576,"fresh":3400,"frames":400,"rounds":3,"backends":["webgpu","webgl"]}']
// GPU Galaxy's default (4 194 304 particles, 4 arms, a life of 5 s) is 4 rings of 1 048 576, about 3 400 fresh records a
// ring per frame at 60 fps.

const RECORD_FLOATS = 28;
const RECORD_BYTES = RECORD_FLOATS * 4;
const COPY_BLOCK = 256;
const COPY_BLOCK_SHIFT = 8;
const TEX_ROW = 512;
const TEXELS_PER_RECORD = 7;

// sharedCopy.js's module: copy(dst, src, len) by memory.copy from a shared memory into an unshared one.
const COPY_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x03, 0x7f, 0x7f, 0x7f, 0x00, 0x02, 0x1d,
  0x02, 0x03, 0x65, 0x6e, 0x76, 0x03, 0x73, 0x72, 0x63, 0x02, 0x03, 0x01, 0x80, 0x80, 0x04, 0x03, 0x65, 0x6e, 0x76,
  0x03, 0x64, 0x73, 0x74, 0x02, 0x01, 0x01, 0x80, 0x80, 0x04, 0x03, 0x02, 0x01, 0x00, 0x07, 0x08, 0x01, 0x04, 0x63,
  0x6f, 0x70, 0x79, 0x00, 0x00, 0x0a, 0x0e, 0x01, 0x0c, 0x00, 0x20, 0x00, 0x20, 0x01, 0x20, 0x02, 0xfc, 0x0a, 0x01,
  0x00, 0x0b,
]);

// A writer: fills records [from, from + n) of its ring with words that change every frame (the arms' emit, in short).
const WRITER = `
let words = null;
onmessage = (e) => {
  const d = e.data;
  if (d.sab) { words = new Uint32Array(d.sab, d.byte, d.words); postMessage(0); return; }
  let x = (d.seed * 2654435761) >>> 0;
  const end = (d.from + d.n) * ${RECORD_FLOATS};
  for (let w = d.from * ${RECORD_FLOATS}; w < end; w++) {
    x = (x ^ (x << 13)) >>> 0; x = (x ^ (x >>> 17)) >>> 0; x = (x ^ (x << 5)) >>> 0;
    words[w] = x;
  }
  postMessage(0);
};`;

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : NaN;
};

/** One ring: its piece of the shared memory, its own array (set), its arena slice (wasm), its GPU object. */
function makeRing(memory, arenaBuffer, r, capacity) {
  const byte = r * capacity * RECORD_BYTES;
  const words = capacity * RECORD_FLOATS;
  const ring = {
    byte,
    records: new Float32Array(memory.buffer, byte, words),
    recordBits: new Uint32Array(memory.buffer, byte, words),
    mirror: new Float32Array(words),
    arena: new Uint32Array(arenaBuffer, byte, words),
    srcBlocks: [],
    dstBlocks: [],
    published: 0,
    gpu: null,
  };
  ring.mirrorBits = new Uint32Array(ring.mirror.buffer);
  const blockWords = COPY_BLOCK * RECORD_FLOATS;
  for (let k = 0; k < capacity / COPY_BLOCK; k++) {
    ring.srcBlocks.push(ring.records.subarray(k * blockWords, (k + 1) * blockWords));
    ring.dstBlocks.push(ring.mirror.subarray(k * blockWords, (k + 1) * blockWords));
  }
  return ring;
}

/** gpuParticleBatch.js's RingDraw._copy before E-488. */
function copySet(ring, from, n) {
  const end = from + n;
  let r = from;
  let blocks = (r + COPY_BLOCK - 1) & ~(COPY_BLOCK - 1);
  if (blocks > end) blocks = end;
  const src = ring.recordBits;
  const dst = ring.mirrorBits;
  for (let w = r * RECORD_FLOATS; w < blocks * RECORD_FLOATS; w++) dst[w] = src[w];
  r = blocks;
  while (r + COPY_BLOCK <= end) {
    ring.dstBlocks[r >> COPY_BLOCK_SHIFT].set(ring.srcBlocks[r >> COPY_BLOCK_SHIFT]);
    r += COPY_BLOCK;
  }
  for (let w = r * RECORD_FLOATS; w < end * RECORD_FLOATS; w++) dst[w] = src[w];
}

/** The pieces of a ring's fresh range: [from, n] once, or twice across the ring end. */
function pieces(ring, fresh, capacity) {
  const start = ring.published;
  const from = start & (capacity - 1);
  const head = Math.min(fresh, capacity - from);
  const out = [[from, head]];
  if (fresh > head) out.push([0, fresh - head]);
  return out;
}

async function writeFrame(writers, rings, fresh, capacity, frame) {
  await Promise.all(
    writers.map((w, r) => {
      const ps = pieces(rings[r], fresh, capacity);
      return Promise.all(
        ps.map(
          ([from, n], k) =>
            new Promise((resolve) => {
              w.queue.push(resolve);
              w.worker.postMessage({ from, n, seed: frame * 977 + r * 31 + k + 1 });
            }),
        ),
      );
    }),
  );
}

function startWriters(memory, rings, capacity) {
  const url = URL.createObjectURL(new Blob([WRITER], { type: 'text/javascript' }));
  return Promise.all(
    rings.map(
      (ring) =>
        new Promise((resolve) => {
          const worker = new Worker(url);
          const w = { worker, queue: [] };
          worker.onmessage = () => {
            const next = w.queue.shift();
            if (next) next();
            else resolve(w);
          };
          worker.postMessage({ sab: memory.buffer, byte: ring.byte, words: capacity * RECORD_FLOATS });
        }),
    ),
  );
}

// ---- WebGPU ----

async function webgpuBackend(rings, capacity, fresh) {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  for (const ring of rings) {
    ring.gpu = device.createBuffer({ size: capacity * RECORD_BYTES, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  }
  const info = adapter.info || {};
  // mapped: staging buffers (MAP_WRITE) of a frame's fresh records of every ring, mapped ahead; a frame copies its
  // ranges into one's mapped range (TypedArray.set from the shared memory), unmaps it and copies it into the rings'
  // buffers on the GPU (copyBufferToBuffer), then maps it again for a later frame.
  const staging = [];
  for (let k = 0; k < 4; k++) {
    const buf = device.createBuffer({ size: rings.length * fresh * RECORD_BYTES, usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
    staging.push({ buf, mapped: true, promise: null });
  }
  let current = null;
  let range = null;
  let cursor = 0;
  const copies = [];
  return {
    name: 'webgpu',
    gpu: `${info.vendor || ''} ${info.architecture || ''} ${info.description || ''}`.trim(),
    async beginFrame(mode) {
      if (mode !== 'mapped') return;
      current = staging.find((s) => s.mapped) || null;
      if (current === null) {
        await Promise.race(staging.map((s) => s.promise));
        current = staging.find((s) => s.mapped);
      }
      range = null;
      cursor = 0;
      copies.length = 0;
    },
    send(mode, ring, from, n, arenaCopy) {
      const off = from * RECORD_BYTES;
      const bytes = n * RECORD_BYTES;
      if (mode === 'set') {
        copySet(ring, from, n);
        device.queue.writeBuffer(ring.gpu, off, ring.mirror.buffer, off, bytes);
      } else if (mode === 'wasm') {
        arenaCopy(ring.byte + off, ring.byte + off, bytes);
        device.queue.writeBuffer(ring.gpu, off, ring.arena.buffer, ring.byte + off, bytes);
      } else if (mode === 'mapped') {
        if (range === null) range = current.buf.getMappedRange();
        new Uint32Array(range, cursor, n * RECORD_FLOATS).set(ring.recordBits.subarray(from * RECORD_FLOATS, (from + n) * RECORD_FLOATS));
        copies.push(cursor, ring.gpu, off, bytes);
        cursor += bytes;
      } else {
        device.queue.writeBuffer(ring.gpu, off, ring.records.buffer, ring.byte + off, bytes);
      }
    },
    endFrame(mode) {
      if (mode !== 'mapped') {
        device.queue.submit([]);
        return;
      }
      const s = current;
      s.buf.unmap();
      const enc = device.createCommandEncoder();
      for (let k = 0; k < copies.length; k += 4) enc.copyBufferToBuffer(s.buf, copies[k], copies[k + 1], copies[k + 2], copies[k + 3]);
      device.queue.submit([enc.finish()]);
      s.mapped = false;
      s.promise = s.buf.mapAsync(GPUMapMode.WRITE).then(() => {
        s.mapped = true;
      });
    },
    async settle() {
      await device.queue.onSubmittedWorkDone();
    },
    async readBack(ring) {
      const size = capacity * RECORD_BYTES;
      const read = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(ring.gpu, 0, read, 0, size);
      device.queue.submit([enc.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const out = new Uint32Array(read.getMappedRange().slice(0));
      read.unmap();
      read.destroy();
      return out;
    },
    destroy() {
      for (const ring of rings) ring.gpu.destroy();
      for (const s of staging) s.buf.destroy();
      device.destroy();
    },
  };
}

// ---- WebGL2 ----

function webglBackend(rings, capacity) {
  const canvas = new OffscreenCanvas(16, 16);
  const gl = canvas.getContext('webgl2', { powerPreference: 'high-performance' });
  if (!gl) return null;
  const width = TEXELS_PER_RECORD * Math.min(capacity, TEX_ROW);
  const height = Math.max(1, capacity / TEX_ROW);
  if (width > gl.getParameter(gl.MAX_TEXTURE_SIZE) || height > gl.getParameter(gl.MAX_TEXTURE_SIZE)) return null;
  for (const ring of rings) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    ring.gpu = tex;
  }
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  // The instance-attribute fallback (a ring past MAX_TEXTURE_SIZE): Pixi's bufferData and bufferSubData from a view
  // of the shared memory.
  let sharedBufferSubData = 'ok';
  try {
    const probe = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, probe);
    gl.bufferData(gl.ARRAY_BUFFER, rings[0].records.subarray(0, 4 * RECORD_FLOATS), gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, RECORD_BYTES, rings[0].records, RECORD_FLOATS, RECORD_FLOATS);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.deleteBuffer(probe);
  } catch (err) {
    sharedBufferSubData = String(err);
  }
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const rowsFrom = (bits, base, from, n) => {
    const y0 = from >> 9;
    const y1 = (from + n - 1) >> 9;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y0, width, y1 - y0 + 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, bits, base + y0 * width * 4);
  };
  // Records [from, from + n) only: texels of a partial first row, the whole rows, a partial last row.
  const exact = (bits, base, from, n) => {
    let r = from;
    const end = from + n;
    const firstEnd = Math.min(end, (r + TEX_ROW) & ~(TEX_ROW - 1));
    if ((r & (TEX_ROW - 1)) !== 0 || firstEnd - r < TEX_ROW) {
      const x = (r & (TEX_ROW - 1)) * TEXELS_PER_RECORD;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, r >> 9, (firstEnd - r) * TEXELS_PER_RECORD, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, bits, base + r * RECORD_FLOATS);
      r = firstEnd;
    }
    const whole = (end - r) >> 9;
    if (whole > 0) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r >> 9, width, whole, gl.RGBA_INTEGER, gl.UNSIGNED_INT, bits, base + r * RECORD_FLOATS);
      r += whole * TEX_ROW;
    }
    if (r < end) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r >> 9, (end - r) * TEXELS_PER_RECORD, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, bits, base + r * RECORD_FLOATS);
    }
  };
  return {
    name: 'webgl',
    sharedBufferSubData,
    gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    send(mode, ring, from, n, arenaCopy) {
      gl.bindTexture(gl.TEXTURE_2D, ring.gpu);
      if (mode === 'set') {
        copySet(ring, from, n);
        rowsFrom(ring.mirrorBits, 0, from, n);
      } else if (mode === 'wasm') {
        const off = from * RECORD_BYTES;
        arenaCopy(ring.byte + off, ring.byte + off, n * RECORD_BYTES);
        rowsFrom(ring.arena, 0, from, n);
      } else {
        exact(ring.recordBits, 0, from, n);
      }
    },
    endFrame() {
      gl.flush();
    },
    async settle() {
      gl.finish();
    },
    async readBack(ring) {
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ring.gpu, 0);
      const out = new Uint32Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA_INTEGER, gl.UNSIGNED_INT, out);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      return out;
    },
    destroy() {
      for (const ring of rings) gl.deleteTexture(ring.gpu);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

export async function run(args = {}) {
  const ringCount = Math.max(1, args.rings ?? 4);
  const capacity = Math.max(TEX_ROW, args.capacity ?? 1 << 20);
  const fresh = Math.max(1, args.fresh ?? 3400);
  const frames = Math.max(10, args.frames ?? 400);
  const rounds = Math.max(1, args.rounds ?? 3);
  const modes = args.modes ?? ['set', 'wasm', 'mapped', 'direct'];
  const backends = args.backends ?? ['webgpu', 'webgl'];
  const bytes = ringCount * capacity * RECORD_BYTES;
  const pages = Math.ceil(bytes / 65536);
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  const arenaMemory = new WebAssembly.Memory({ initial: pages, maximum: pages });
  let arenaCopy = null;
  try {
    arenaCopy = new WebAssembly.Instance(new WebAssembly.Module(COPY_MODULE), { env: { src: memory, dst: arenaMemory } }).exports.copy;
  } catch {
    arenaCopy = null;
  }
  const rings = [];
  for (let r = 0; r < ringCount; r++) rings.push(makeRing(memory, arenaMemory.buffer, r, capacity));
  const writers = await startWriters(memory, rings, capacity);
  const report = { rings: ringCount, capacity, fresh, frames, rounds, bytesPerFrame: ringCount * fresh * RECORD_BYTES, backends: {} };
  let frame = 0;
  for (const which of backends) {
    const be = which === 'webgpu' ? await webgpuBackend(rings, capacity, fresh) : webglBackend(rings, capacity);
    if (!be) {
      report.backends[which] = { skipped: true };
      continue;
    }
    const out = { gpu: be.gpu, modes: {} };
    if (be.sharedBufferSubData) out.sharedBufferSubData = be.sharedBufferSubData;
    // mapped is WebGPU's alone; the read-back checks the last mode run.
    const runModes = modes.filter((m) => (m !== 'wasm' || arenaCopy) && (m !== 'mapped' || which === 'webgpu'));
    for (const mode of runModes) out.modes[mode] = { msPerFrame: [], error: null };
    for (let round = 0; round < rounds; round++) {
      for (const mode of runModes) {
        let ms = 0;
        try {
          for (let f = 0; f < frames; f++) {
            await writeFrame(writers, rings, fresh, capacity, frame++);
            if (be.beginFrame) await be.beginFrame(mode);
            const t0 = performance.now();
            for (const ring of rings) {
              for (const [from, n] of pieces(ring, fresh, capacity)) be.send(mode, ring, from, n, arenaCopy);
              ring.published = (ring.published + fresh) >>> 0;
            }
            be.endFrame(mode);
            ms += performance.now() - t0;
            if ((f & 15) === 15) await be.settle();
          }
        } catch (err) {
          out.modes[mode].error = String(err);
        }
        out.modes[mode].msPerFrame.push(ms / frames);
        await be.settle();
      }
    }
    for (const mode of runModes) {
      const m = out.modes[mode];
      m.median = median(m.msPerFrame);
      m.gbPerS = report.bytesPerFrame / 1e6 / m.median; // MB per ms
    }
    // The last mode's pass rewrote every slot when frames × fresh >= capacity (`covers`): the ring on the GPU is then
    // the shared memory, word for word, if that mode sends the right words (on WebGL set and wasm also send the rest
    // of each row from their own copy, which is stale where an earlier pass of another mode wrote).
    const onGpu = await be.readBack(rings[0]);
    const want = rings[0].recordBits;
    let differ = 0;
    const n = Math.min(onGpu.length, want.length);
    for (let i = 0; i < n; i++) if (onGpu[i] !== want[i]) differ++;
    out.readBack = { lastMode: runModes[runModes.length - 1], covers: frames * fresh >= capacity, words: n, differ };
    be.destroy();
    report.backends[which] = out;
  }
  for (const w of writers) w.worker.terminate();
  return report;
}
