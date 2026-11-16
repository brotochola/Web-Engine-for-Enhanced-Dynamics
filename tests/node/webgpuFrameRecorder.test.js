import test from 'node:test';
import assert from 'node:assert/strict';

// webgpuFrameRecorder.mjs's worker side on a fake WebGPU whose GPU clock moves by a known cost per command: each draw
// is timed to its own cost, each pass to its load, draws and store, the labels name the pass target, the pipeline's
// program, its shaders' bindings and its textures, no query set is written while a copy of it is being read
// (R-0204), and the prototypes are put back after the window.

let clock = 1000000n; // a real timestamp is never 0 (the recorder reads 0 as never written)
const tick = (ns) => (clock += BigInt(ns));
let writesWhileRead = 0;
// Draws a real pass ran with no pipeline set (a split pass that did not get the caller's state again).
let drawsWithoutPipeline = 0;
// Each real render pass's first colour attachment's load and store ops.
const passLog = [];

class GPUTextureView {}
class GPUTexture {
  constructor(d) {
    this.label = d.label || '';
    [this.width, this.height] = d.size;
    this.format = d.format;
    this.sampleCount = 1;
  }
  createView() {
    return new GPUTextureView();
  }
}
class GPUQuerySet {
  constructor(d) {
    this.values = new BigUint64Array(d.count);
    this.readers = new Set();
  }
  write(i, t) {
    for (const b of this.readers) if (b.reading) writesWhileRead++;
    this.values[i] = t;
  }
  destroy() {}
}
class GPUBuffer {
  constructor(d) {
    this.size = d.size;
    this.label = d.label || '';
    this.data = new ArrayBuffer(d.size);
    this.reading = false;
    this.from = null;
  }
  mapAsync() {
    this.reading = true;
    return new Promise((resolve) => setTimeout(resolve, 3));
  }
  getMappedRange(o = 0, s = this.size) {
    return this.data.slice(o, o + s);
  }
  unmap() {
    this.reading = false;
  }
  destroy() {}
}
class GPUBindGroup {}
class GPURenderPipeline {
  constructor(label) {
    this.label = label || '';
  }
}
class GPUComputePipeline extends GPURenderPipeline {}
class GPUShaderModule {}
class GPUCommandBuffer {
  constructor(ops) {
    this.ops = ops;
  }
}
// A pass's load costs 20 us and its store 5 us; writing a timestamp 1 us; a draw 100 us + 10 ns an instance, an
// indexed draw 300 us + 10 ns an instance, a dispatch 1 us a workgroup.
function passCommands(Base) {
  return class extends Base {
    constructor(enc, desc) {
      super();
      this.enc = enc;
      this.tw = desc?.timestampWrites || null;
      const tw = this.tw;
      enc.ops.push(() => {
        if (tw) tw.querySet.write(tw.beginningOfPassWriteIndex, clock);
        tick(20000);
      });
    }
    setPipeline(p) {
      this.pipe = p;
    }
    setBindGroup() {}
    writeTimestamp(qs, i) {
      this.enc.ops.push(() => qs.write(i, tick(1000)));
    }
    end() {
      const tw = this.tw;
      this.enc.ops.push(() => {
        tick(5000);
        if (tw) tw.querySet.write(tw.endOfPassWriteIndex, clock);
      });
    }
  };
}
class GPURenderPassEncoder extends passCommands(Object) {
  setVertexBuffer() {}
  setIndexBuffer() {}
  setViewport() {}
  setScissorRect() {}
  setBlendConstant() {}
  setStencilReference() {}
  draw(n, inst = 1) {
    if (!this.pipe) drawsWithoutPipeline++;
    this.enc.ops.push(() => tick(100000 + inst * 10));
  }
  drawIndexed(n, inst = 1) {
    if (!this.pipe) drawsWithoutPipeline++;
    this.enc.ops.push(() => tick(300000 + inst * 10));
  }
  drawIndirect() {}
  drawIndexedIndirect() {}
  executeBundles() {}
}
class GPUComputePassEncoder extends passCommands(Object) {
  dispatchWorkgroups(x) {
    if (!this.pipe) drawsWithoutPipeline++;
    this.enc.ops.push(() => tick(x * 1000));
  }
  dispatchWorkgroupsIndirect() {}
}
class GPUCommandEncoder {
  constructor() {
    this.ops = [];
  }
  beginRenderPass(d) {
    const a = d.colorAttachments[0];
    passLog.push(`${a.view === lightView ? 'light' : 'canvas'} ${a.loadOp}/${a.storeOp}`);
    return new GPURenderPassEncoder(this, d);
  }
  beginComputePass(d) {
    return new GPUComputePassEncoder(this, d);
  }
  resolveQuerySet(qs, first, count, dst, off) {
    this.ops.push(() => {
      new BigUint64Array(dst.data, off, count).set(qs.values.subarray(first, first + count));
      dst.from = qs;
    });
  }
  copyBufferToBuffer(src, so, dst, doff, size) {
    this.ops.push(() => {
      new Uint8Array(dst.data, doff, size).set(new Uint8Array(src.data, so, size));
      if (src.from) src.from.readers.add(dst);
    });
  }
  copyTextureToTexture() {}
  copyBufferToTexture() {}
  copyTextureToBuffer() {}
  clearBuffer() {}
  finish() {
    return new GPUCommandBuffer(this.ops);
  }
}
class GPUQueue {
  submit(cbs) {
    for (const cb of cbs) for (const op of cb.ops) op();
  }
  writeBuffer() {}
  writeTexture() {}
  copyExternalImageToTexture() {}
  onSubmittedWorkDone() {
    return Promise.resolve();
  }
}
class GPUDevice {
  constructor() {
    this.queue = new GPUQueue();
    this.features = new Set(['timestamp-query', 'chromium-experimental-timestamp-query-inside-passes']);
  }
  addEventListener() {}
  removeEventListener() {}
  createCommandEncoder() {
    return new GPUCommandEncoder();
  }
  createQuerySet(d) {
    return new GPUQuerySet(d);
  }
  createBuffer(d) {
    return new GPUBuffer(d);
  }
  createTexture(d) {
    return new GPUTexture(d);
  }
  createSampler() {
    return {};
  }
  createShaderModule() {
    return new GPUShaderModule();
  }
  createRenderPipeline(d) {
    return new GPURenderPipeline(d.label);
  }
  createComputePipeline(d) {
    return new GPUComputePipeline(d.label);
  }
  createRenderPipelineAsync(d) {
    return Promise.resolve(new GPURenderPipeline(d.label));
  }
  createComputePipelineAsync(d) {
    return Promise.resolve(new GPUComputePipeline(d.label));
  }
  createBindGroup() {
    return new GPUBindGroup();
  }
}
class GPUAdapter {
  requestDevice() {
    return Promise.resolve(new GPUDevice());
  }
}
class GPUCanvasContext {
  getCurrentTexture() {
    return new GPUTexture({ size: [1280, 720], format: 'bgra8unorm' });
  }
}
Object.assign(globalThis, {
  GPUTextureView, GPUTexture, GPUBuffer, GPUBindGroup, GPURenderPassEncoder, GPUComputePassEncoder, GPUCommandEncoder,
  GPUQueue, GPUDevice, GPUAdapter, GPUCanvasContext,
  GPUBufferUsage: { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, QUERY_RESOLVE: 512 },
  GPUMapMode: { READ: 1 },
});
globalThis.self = globalThis;

const { installCreationHooks, recordInWorker } = await import('../bench/webgpuRecorderWorker.mjs');

assert.equal(installCreationHooks(), 'installed');
const device = await new GPUAdapter().requestDevice({ requiredFeatures: ['timestamp-query'] });
const canvas = new GPUCanvasContext();
const lightRT = device.createTexture({ label: 'lightRT', size: [960, 540], format: 'rgba16float' });
const lightView = lightRT.createView();
const atlas = device.createTexture({ label: 'atlas/big.png', size: [4096, 4096], format: 'rgba8unorm' });
const code = '@group(0) @binding(0) var<uniform> globalUniforms: G; @group(1) @binding(0) var uTexture: texture_2d<f32>; ' +
  '@group(1) @binding(1) var uSampler: sampler; @group(2) @binding(0) var<storage, read> uPoses: array<f32>;';
const module = device.createShaderModule({ code });
const sprites = device.createRenderPipeline({
  label: 'PIXI Pipeline (instanced-sprites)',
  vertex: { module, entryPoint: 'mainVert' },
  fragment: { module, entryPoint: 'mainFrag', targets: [{ format: 'bgra8unorm' }] },
});
const lighting = device.createRenderPipeline({
  label: 'PIXI Pipeline (lighting)',
  vertex: { module, entryPoint: 'mainVert' },
  fragment: { module, entryPoint: 'mainFragAdd', targets: [{ format: 'rgba16float' }] },
});
const scatter = device.createComputePipeline({
  compute: { module: device.createShaderModule({ code: '@group(0) @binding(0) var<storage, read_write> statics: array<f32>;' }), entryPoint: 'main' },
});
const bg = device.createBindGroup({ entries: [{ binding: 0, resource: atlas.createView() }] });
const px = { frameNumber: 0, pixiApp: { renderer: { gpu: { device, adapter: { info: { vendor: 'test' } } } } } };
globalThis.pixiRenderer = px;

// A frame: the light pass (one draw), the colour pass to the canvas (two indexed draws), a pass with no draw, and a
// compute pass in its own submit.
function frame() {
  const enc = device.createCommandEncoder();
  const light = enc.beginRenderPass({ colorAttachments: [{ view: lightView, loadOp: 'clear', storeOp: 'store' }] });
  light.setPipeline(lighting);
  light.setBindGroup(0, bg);
  light.draw(6, 1);
  light.end();
  const colour = enc.beginRenderPass({ colorAttachments: [{ view: canvas.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
  colour.setPipeline(sprites);
  colour.setBindGroup(0, bg);
  colour.setBindGroup(0, bg);
  colour.drawIndexed(6, 1000);
  colour.setPipeline(sprites);
  colour.drawIndexed(6, 50);
  colour.end();
  enc.beginRenderPass({ colorAttachments: [{ view: lightView, loadOp: 'load', storeOp: 'store' }] }).end();
  device.queue.submit([enc.finish()]);
  const enc2 = device.createCommandEncoder();
  const c = enc2.beginComputePass({ label: 'weed-statics-scatter' });
  c.setPipeline(scatter);
  c.dispatchWorkgroups(64);
  c.end();
  device.queue.submit([enc2.finish()]);
  px.frameNumber++;
}

async function record(mode) {
  const loop = setInterval(frame, 4);
  try {
    return await recordInWorker({ ms: 400, mode });
  } finally {
    clearInterval(loop);
  }
}

const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} against ${b}`);

test('--gpu-draws times each draw and each pass part to its own cost, named by pass, program, bindings and textures', async () => {
  const before = GPURenderPassEncoder.prototype.drawIndexed;
  const r = await record('draws');
  assert.equal(GPURenderPassEncoder.prototype.drawIndexed, before, 'the prototype was not put back');
  const g = r.gpu;
  assert.ok(g.perDraw);
  assert.equal(g.invalid, 0);
  assert.equal(g.lost, 0);
  assert.ok(g.framesTimed >= 3, `${g.framesTimed} frames timed`);
  assert.ok(g.slots < 64, `${g.slots} query sets for a few in flight`);
  assert.equal(writesWhileRead, 0, 'a query set was written while its copy was being read');
  const ms = (needle) => {
    const row = g.draws.find((d) => d.label.includes(needle));
    assert.ok(row, `no row ${needle}`);
    return row.ns / row.n / 1e6;
  };
  // Each draw: its cost plus the 1 us of the timestamp after it.
  near(ms('canvas 1280x720 bgra8unorm | draw 0: instanced-sprites [uTexture,uSampler,uPoses] {big.png 4096x4096}'), 0.311, 'draw 0');
  near(ms('canvas 1280x720 bgra8unorm | draw 1: instanced-sprites'), 0.3015, 'draw 1');
  near(ms('lightRT | draw 0: lighting:mainFragAdd'), 0.10101, 'the light draw');
  near(ms('"weed-statics-scatter" | dispatch 0 64x1x1'), 0.065, 'the dispatch');
  // A pass's load to its first draw: the load and the timestamp before the draw; its end: the store.
  near(ms('lightRT | clear (to the first draw)'), 0.021, 'the light pass clear');
  near(ms('lightRT | end (from the last draw'), 0.005, 'the light pass store');
  near(ms('lightRT | no draw (load)'), 0.025, 'a pass with no draw');
  // A pass is its parts and the timestamps between its draws (1 us each).
  for (const p of g.passes) assert.ok(p.drawNs + p.preNs + p.postNs <= p.ns, `${p.label}: its parts are over the pass`);
  const colour = g.passes.find((p) => p.label.startsWith('render canvas'));
  near((colour.ns - colour.drawNs - colour.preNs - colour.postNs) / colour.n / 1e6, 0.001, 'the gap between the colour pass draws');
  assert.equal(colour.drawCount / colour.n, 2, 'the colour pass draws');
  assert.match(colour.label, /first instanced-sprites/);
  assert.equal(r.perFrame.draws, 3);
  assert.equal(r.top.find((t) => t.name === 'setBindGroup').redundantPerFrame, 1);
});

test('--gpu-passes times passes only; the counts mode writes no timestamp', async () => {
  const p = await record('passes');
  assert.equal(p.gpu.perDraw, false);
  assert.equal(p.gpu.draws, undefined);
  const light = p.gpu.passes.find((x) => x.label.includes('lightRT') && x.label.includes('first lighting'));
  near(light.ns / light.n / 1e6, 0.12501, 'the light pass: load, draw, store');
  const c = await record('counts');
  assert.equal(c.gpu, null);
  assert.equal(c.perFrame.renderPasses, 3);
  assert.equal(c.perFrame.computePasses, 1);
  assert.equal(writesWhileRead, 0);
});

test('--split-passes times each draw in a pass of its own, with the caller\'s state set again and its clear kept', async () => {
  passLog.length = 0;
  const r = await record('split');
  const g = r.gpu;
  assert.ok(g.split);
  assert.equal(g.invalid, 0);
  assert.equal(drawsWithoutPipeline, 0, 'a split pass drew with no pipeline');
  assert.equal(writesWhileRead, 0);
  const ms = (needle) => {
    const row = g.draws.find((d) => d.label.includes(needle));
    assert.ok(row, `no row ${needle}`);
    return row.ns / row.n / 1e6;
  };
  // Each draw: its pass's load (20 us) and store (5 us) around its cost; the clear and the empty pass alone.
  near(ms('canvas 1280x720 bgra8unorm | draw 0: instanced-sprites'), 0.335, 'draw 0 in its own pass');
  near(ms('canvas 1280x720 bgra8unorm | draw 1: instanced-sprites'), 0.3255, 'draw 1 in its own pass');
  near(ms('lightRT | draw 0: lighting'), 0.12501, 'the light draw in its own pass');
  near(ms('"weed-statics-scatter" | dispatch 0 64x1x1'), 0.089, 'the dispatch in its own pass');
  near(ms('lightRT | clear (a pass of its own)'), 0.025, 'the light pass clear');
  near(ms('canvas 1280x720 bgra8unorm | an empty pass'), 0.025, 'an empty pass');
  const colour = g.passes.find((p) => p.label.startsWith('render canvas'));
  near((colour.ns - colour.drawNs - colour.preNs - colour.postNs) / colour.n, 0, 'a split pass is its parts');
  // The canvas pass: its clear (stored), then each draw's pass and the empty one load and store.
  const i = passLog.indexOf('canvas clear/store');
  assert.ok(i >= 0, passLog.slice(0, 8).join(' | '));
  assert.deepEqual(passLog.slice(i, i + 4), ['canvas clear/store', 'canvas load/store', 'canvas load/store', 'canvas load/store']);
  assert.equal(r.perFrame.draws, 3);
  assert.equal(r.top.find((t) => t.name === 'setBindGroup').redundantPerFrame, 1, 'the replays were counted as calls');
});
