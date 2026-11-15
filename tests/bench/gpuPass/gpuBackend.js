/**
 * The GPU pass bench's WebGPU side: a pass's WGSL as the engine builds it, its bind group layouts written from its own
 * declarations (wgslReflect.js: every binding visible to both stages, a texture filterable only where the source samples
 * it), its uniform structs laid out and filled by field name, its vertex inputs fed from one per-vertex and one
 * interleaved per-instance buffer. No Pixi: only the measured pass runs.
 *
 * Timing: K render passes in one command buffer, the clock around its submit and device.queue.onSubmittedWorkDone()
 * (plan §9.3). A wait that never ends is cut at `hangMs` and reported, instead of hanging the page.
 */

import { isSampled, layoutStruct, packUniforms, parseBindings, parseStructs, parseVertexInputs, fragmentTargets } from './wgslReflect.js';

const FORMATS = {
  rgba8: { gpu: 'rgba8unorm', bytes: 4, filterable: true },
  r8: { gpu: 'r8unorm', bytes: 1, filterable: true },
  r16f: { gpu: 'r16float', bytes: 2, filterable: true },
  rgba16f: { gpu: 'rgba16float', bytes: 8, filterable: true },
  r32f: { gpu: 'r32float', bytes: 4, filterable: false, wide: true },
  rgba32f: { gpu: 'rgba32float', bytes: 16, filterable: false, wide: true },
};

function blendState(mode) {
  const one = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
  switch (mode) {
    case 'none':
      return undefined;
    case 'max':
      return { color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' } };
    case 'add':
      return { color: one, alpha: one };
    case 'multiply':
      return {
        color: { srcFactor: 'dst', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      };
    default: {
      // 'premultiplied': Pixi's normal blending on premultiplied colour.
      const over = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' };
      return { color: over, alpha: over };
    }
  }
}

function withTimeout(promise, ms, what) {
  let timer = 0;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`hang: ${what} did not finish in ${ms} ms`)), ms);
    }),
  ]);
}

function padded(data) {
  const bytes = data.byteLength;
  if (bytes % 4 === 0) return data;
  const out = new Uint8Array(Math.ceil(bytes / 4) * 4);
  out.set(new Uint8Array(data.buffer, data.byteOffset, bytes));
  return out;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ hangMs?: number, intBits?: 'exact' | 'float' }} [opts]
 */
export async function createGpuBackend(canvas, { hangMs = 10000, intBits = 'exact' } = {}) {
  if (!navigator.gpu) throw new Error('no WebGPU (navigator.gpu)');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no WebGPU adapter');
  const wanted = ['float32-blendable', 'float32-filterable'].filter((f) => adapter.features.has(f));
  const device = await adapter.requestDevice({ requiredFeatures: wanted });
  let lost = null;
  device.lost.then((why) => {
    lost = why;
  });
  const context = canvas.getContext('webgpu');
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format: canvasFormat, alphaMode: 'opaque' });
  const ai = adapter.info || {};
  const info = {
    backend: 'webgpu',
    vendor: ai.vendor || '',
    architecture: ai.architecture || '',
    device: ai.device || '',
    description: ai.description || '',
    features: wanted,
    intBits,
  };

  const textures = new Map();
  const handles = [];
  const linear = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const nearest = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  const black = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  const zeros16 = device.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  function supports(format, blended) {
    const f = FORMATS[format];
    if (!f) return `unknown format ${format}`;
    if (f.wide && blended && !device.features.has('float32-blendable')) return `${format} blending needs the float32-blendable feature`;
    return null;
  }

  function createTexture(key, desc) {
    if (desc.kind === 'depth') {
      const texture = device.createTexture({ size: [desc.width, desc.height], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
      textures.set(key, { texture, view: texture.createView(), width: desc.width, height: desc.height, format: 'depth' });
      return;
    }
    const format = desc.format || 'rgba8';
    const f = FORMATS[format];
    if (!f) throw new Error(`unknown texture format ${format}`);
    const width = desc.kind === 'bitmap' ? desc.bitmap.width : desc.width;
    const height = desc.kind === 'bitmap' ? desc.bitmap.height : desc.height;
    let usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
    if (desc.kind === 'bitmap' || desc.kind === 'target') usage |= GPUTextureUsage.RENDER_ATTACHMENT;
    if (desc.kind === 'target') usage |= GPUTextureUsage.COPY_SRC;
    const texture = device.createTexture({ size: [width, height], format: f.gpu, usage });
    if (desc.kind === 'bitmap') {
      device.queue.copyExternalImageToTexture({ source: desc.bitmap, flipY: false }, { texture, premultipliedAlpha: Boolean(desc.premultiply) }, [width, height]);
    } else if (desc.kind === 'data') {
      device.queue.writeTexture({ texture }, desc.data, { bytesPerRow: width * f.bytes, rowsPerImage: height }, [width, height]);
    }
    textures.set(key, { texture, view: texture.createView(), width, height, format, filter: desc.filter || 'nearest' });
  }

  async function validated(what, make) {
    device.pushErrorScope('validation');
    const out = make();
    const error = await device.popErrorScope();
    if (error) throw new Error(`${what}: ${error.message}`);
    return out;
  }

  /**
   * Compiles and sets up a pass (page.js's pass spec): its pipeline with an explicit layout, its uniform buffers and bind
   * groups, its per-vertex and per-instance buffers.
   */
  async function createPass(spec) {
    const code = spec.wgsl.code;
    const module = device.createShaderModule({ code, label: spec.name });
    const ci = await module.getCompilationInfo();
    const errors = ci.messages.filter((m) => m.type === 'error');
    if (errors.length) throw new Error(`${spec.name}'s WGSL does not compile: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);

    const structs = parseStructs(code);
    const bindings = parseBindings(code);
    const groupCount = bindings.reduce((n, b) => Math.max(n, b.group + 1), 0);
    const unknown = [];
    const layouts = [];
    const groupEntries = [];
    const buffers = [];
    for (let g = 0; g < groupCount; g++) {
      const layoutEntries = [];
      const entries = [];
      for (const b of bindings.filter((x) => x.group === g)) {
        if (b.kind === 'uniform') {
          const layout = layoutStruct(structs, b.type.replace(/\s+/g, ''));
          for (const f of layout.fields) if (spec.uniforms?.[f.name] === undefined) unknown.push(f.name);
          const data = packUniforms(layout, spec.uniforms || {}, intBits);
          const buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
          device.queue.writeBuffer(buffer, 0, data);
          buffers.push(buffer);
          layoutEntries.push({ binding: b.binding, visibility: VF, buffer: { type: 'uniform' } });
          entries.push({ binding: b.binding, resource: { buffer } });
        } else if (b.kind === 'read-only-storage' || b.kind === 'storage') {
          unknown.push(b.name);
          layoutEntries.push({ binding: b.binding, visibility: GPUShaderStage.FRAGMENT | (b.kind === 'storage' ? 0 : GPUShaderStage.VERTEX), buffer: { type: b.kind } });
          entries.push({ binding: b.binding, resource: { buffer: zeros16 } });
        } else if (b.kind === 'texture') {
          const key = spec.textures?.[b.name];
          const entry = key ? textures.get(key) : null;
          if (key && !entry) throw new Error(`${spec.name}: no texture ${key} for ${b.name}`);
          if (!key) unknown.push(b.name);
          const sampled = isSampled(code, b.name);
          const format = entry ? entry.format : 'rgba8';
          if (sampled && !FORMATS[format].filterable && !device.features.has('float32-filterable')) {
            throw new Error(`${spec.name}: ${b.name} is sampled but ${format} is not filterable`);
          }
          const sampleType = /<i32>/.test(b.type) ? 'sint' : /<u32>/.test(b.type) ? 'uint' : sampled ? 'float' : 'unfilterable-float';
          layoutEntries.push({ binding: b.binding, visibility: VF, texture: { sampleType, viewDimension: '2d', multisampled: false } });
          entries.push({ binding: b.binding, resource: entry ? entry.view : black.createView() });
        } else if (b.kind === 'sampler') {
          layoutEntries.push({ binding: b.binding, visibility: VF, sampler: { type: 'filtering' } });
          entries.push({ binding: b.binding, resource: spec.samplers?.[b.name] === 'nearest' ? nearest : linear });
        } else {
          throw new Error(`${spec.name}: binding ${b.name} (${b.type}) is of a kind the bench does not feed`);
        }
      }
      const layout = device.createBindGroupLayout({ entries: layoutEntries, label: `${spec.name} group ${g}` });
      layouts.push(layout);
      groupEntries.push(entries);
    }
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: layouts });
    const bindGroups = await validated(`${spec.name}'s bind groups`, () =>
      layouts.map((layout, g) => device.createBindGroup({ layout, entries: groupEntries[g] })),
    );

    const inputs = parseVertexInputs(code, spec.wgsl.vertexEntry);
    const perVertex = spec.vertex;
    const instanceCount = spec.instances ? spec.instances.count : 1;
    const vertexInput = inputs.find((i) => i.name === perVertex.name);
    const others = inputs.filter((i) => i.name !== perVertex.name);
    const vertexBuffers = [];
    const vbuf = device.createBuffer({ size: padded(perVertex.data).byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vbuf, 0, padded(perVertex.data));
    buffers.push(vbuf);
    const bufferLayouts = [];
    if (vertexInput) {
      bufferLayouts.push({ arrayStride: perVertex.size * 4, stepMode: 'vertex', attributes: [{ shaderLocation: vertexInput.location, offset: 0, format: vertexInput.format }] });
      vertexBuffers.push(vbuf);
    }
    if (others.length > 0) {
      const stride = others.reduce((s, a) => s + a.floats, 0);
      const data = new Float32Array(stride * instanceCount);
      // Copied as bits: a float that carries a uint (aInstTintBits) is a NaN for most tints.
      const bits = new Uint32Array(data.buffer);
      let offset = 0;
      const attributes = [];
      for (const a of others) {
        const src = spec.instances?.attributes?.[a.name];
        if (src) {
          const have = Math.max(1, Math.round(src.length / instanceCount));
          const from = new Uint32Array(src.buffer, src.byteOffset, src.length);
          for (let i = 0; i < instanceCount; i++) {
            for (let c = 0; c < a.floats && c < have; c++) bits[i * stride + offset + c] = from[i * have + c];
          }
        } else {
          unknown.push(a.name);
        }
        attributes.push({ shaderLocation: a.location, offset: offset * 4, format: a.format });
        offset += a.floats;
      }
      const ibuf = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(ibuf, 0, data);
      buffers.push(ibuf);
      bufferLayouts.push({ arrayStride: stride * 4, stepMode: 'instance', attributes });
      vertexBuffers.push(ibuf);
    }
    let indexBuffer = null;
    let indexCount = 0;
    if (perVertex.indices) {
      const idx = padded(perVertex.indices);
      indexBuffer = device.createBuffer({ size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(indexBuffer, 0, idx);
      buffers.push(indexBuffer);
      indexCount = perVertex.indices.length;
    }

    const targets = spec.targets.map((key, i) => {
      const t = textures.get(key);
      if (!t) throw new Error(`${spec.name}: no target ${key}`);
      const mode = (spec.blend || [])[i] || (spec.blend || ['none'])[0];
      const why = supports(t.format, mode !== 'none');
      if (why) throw new Error(`${spec.name}: ${why}`);
      return { format: FORMATS[t.format].gpu, blend: blendState(mode) };
    });
    const outputs = fragmentTargets(code, spec.wgsl.fragmentEntry);
    if (outputs !== targets.length) throw new Error(`${spec.name}: ${spec.wgsl.fragmentEntry} writes ${outputs} targets, the pass has ${targets.length}`);
    const depth = spec.depthTarget ? textures.get(spec.depthTarget) : null;
    const pipeline = await validated(`${spec.name}'s pipeline`, () =>
      device.createRenderPipeline({
        label: spec.name,
        layout: pipelineLayout,
        vertex: { module, entryPoint: spec.wgsl.vertexEntry, buffers: bufferLayouts },
        fragment: { module, entryPoint: spec.wgsl.fragmentEntry, targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: depth ? { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' } : undefined,
      }),
    );
    const first = textures.get(spec.targets[0]);
    const c = spec.clear || [0, 0, 0, 0];
    const handle = {
      spec,
      pipeline,
      bindGroups,
      vertexBuffers,
      indexBuffer,
      indexCount,
      vertexCount: perVertex.count,
      instanceCount,
      colorViews: spec.targets.map((k) => textures.get(k).view),
      depthView: depth ? depth.view : null,
      clear: Boolean(spec.clear),
      clearValue: { r: c[0], g: c[1], b: c[2], a: c[3] },
      width: first.width,
      height: first.height,
      buffers,
      unknown: [...new Set(unknown)],
    };
    handles.push(handle);
    return handle;
  }

  function encode(encoder, h) {
    const pass = encoder.beginRenderPass({
      colorAttachments: h.colorViews.map((view) => ({ view, loadOp: h.clear ? 'clear' : 'load', storeOp: 'store', clearValue: h.clearValue })),
      depthStencilAttachment: h.depthView
        ? { view: h.depthView, depthLoadOp: 'clear', depthClearValue: 1, depthStoreOp: 'store' }
        : undefined,
    });
    pass.setPipeline(h.pipeline);
    for (let g = 0; g < h.bindGroups.length; g++) pass.setBindGroup(g, h.bindGroups[g]);
    for (let b = 0; b < h.vertexBuffers.length; b++) pass.setVertexBuffer(b, h.vertexBuffers[b]);
    if (h.indexBuffer) {
      pass.setIndexBuffer(h.indexBuffer, 'uint16');
      pass.drawIndexed(h.indexCount, h.instanceCount);
    } else {
      pass.draw(h.vertexCount, h.instanceCount);
    }
    pass.end();
  }

  function checkLost() {
    if (lost) throw new Error(`the WebGPU device was lost: ${lost.message || lost.reason}`);
  }

  /** One execution, submitted on its own (the warm-up and the frame's inputs). */
  function draw(h) {
    const encoder = device.createCommandEncoder();
    encode(encoder, h);
    device.queue.submit([encoder.finish()]);
  }

  /** ms from the submit of K executions (encoded beforehand) to onSubmittedWorkDone. */
  async function timeK(h, k) {
    checkLost();
    const encoder = device.createCommandEncoder();
    for (let i = 0; i < k; i++) encode(encoder, h);
    const commands = encoder.finish();
    await withTimeout(device.queue.onSubmittedWorkDone(), hangMs, 'the queue before timing');
    const t0 = performance.now();
    device.queue.submit([commands]);
    await withTimeout(device.queue.onSubmittedWorkDone(), hangMs, `${k} x ${h.spec.name}`);
    const ms = performance.now() - t0;
    checkLost();
    return ms;
  }

  /** ms for the clock alone: an empty submit and its onSubmittedWorkDone. */
  async function timeEmpty() {
    await withTimeout(device.queue.onSubmittedWorkDone(), hangMs, 'the queue');
    const t0 = performance.now();
    device.queue.submit([device.createCommandEncoder().finish()]);
    await withTimeout(device.queue.onSubmittedWorkDone(), hangMs, 'an empty submit');
    return performance.now() - t0;
  }

  /** One presented frame with the pass encoded n times (the capacity search). */
  function frame(h, n) {
    const encoder = device.createCommandEncoder();
    for (let i = 0; i < n; i++) encode(encoder, h);
    const present = encoder.beginRenderPass({
      colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.08, g: 0.08, b: 0.1, a: 1 } }],
    });
    present.end();
    device.queue.submit([encoder.finish()]);
  }

  /** A target's pixels (RGBA8 targets only), for a sanity look at what a pass drew. */
  async function readTarget(key) {
    const t = textures.get(key);
    if (!t || t.format !== 'rgba8') return null;
    const bytesPerRow = Math.ceil((t.width * 4) / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * t.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: t.texture }, { buffer, bytesPerRow }, [t.width, t.height]);
    device.queue.submit([encoder.finish()]);
    await withTimeout(buffer.mapAsync(GPUMapMode.READ), hangMs, 'a read back');
    const src = new Uint8Array(buffer.getMappedRange());
    const out = new Uint8Array(t.width * t.height * 4);
    for (let y = 0; y < t.height; y++) out.set(src.subarray(y * bytesPerRow, y * bytesPerRow + t.width * 4), y * t.width * 4);
    buffer.unmap();
    buffer.destroy();
    return { width: t.width, height: t.height, data: out };
  }

  function destroy() {
    for (const h of handles) for (const b of h.buffers) b.destroy();
    for (const t of textures.values()) t.texture.destroy();
    device.destroy();
  }

  return { kind: 'webgpu', info, supports, createTexture, createPass, draw, timeK, timeEmpty, frame, readTarget, destroy };
}
