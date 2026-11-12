// E-187: a keyed sprite batch's changed statics into its statics storage buffer on WebGPU. The keyed pack lists them as
// updates (gpuPack.c pack_sprites_keyed: three vec4<u32> of words, then the key, GPU_KEYED_ROW_WORDS u32 each) and its
// texture updates (KEYED_TEX_WORDS: a key's row, then its texture's float bits); the indexed sprite program reads the
// buffer as array<vec4<u32>>, three a key (spriteIndexed.js spriteIndexedWgsl). WebGL draws the updates into its
// statics texture (staticsScatterGl.js); here two compute dispatches write them, the rows first and then the texture
// words (S1.z, the row's word 6), in one pass submitted at once, so it lands before the frame's render submit. A key's
// updates in one frame carry the same statics (a key has one statics row on the GPU), so the dispatch's order among
// them does not matter.
//
// The statics buffer is Pixi's (renderer.buffer.getGPUBuffer); Pixi must never write it again from its CPU copy, which
// a keyed batch leaves at zeros (instancedSpriteBatch.js: no update(), autoGarbageCollect off).

import { GPU_KEYED_ROW_WORDS, GPU_KEYED_TEX_WORDS } from '../gpuPackClient.js';

const WORKGROUP = 64;

const ROWS_WGSL = /* wgsl */ `
struct Params { count: u32, pad0: u32, pad1: u32, pad2: u32 };
@group(0) @binding(0) var<storage, read_write> statics: array<vec4<u32>>;
@group(0) @binding(1) var<storage, read> updates: array<vec4<u32>>;
@group(0) @binding(2) var<uniform> params: Params;
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= params.count) { return; }
  let u = i * ${GPU_KEYED_ROW_WORDS / 4}u;
  let row = updates[u + 3u].x * 3u;
  statics[row] = updates[u];
  statics[row + 1u] = updates[u + 1u];
  statics[row + 2u] = updates[u + 2u];
}
`;

const TEX_WGSL = /* wgsl */ `
struct Params { count: u32, pad0: u32, pad1: u32, pad2: u32 };
@group(0) @binding(0) var<storage, read_write> words: array<u32>;
@group(0) @binding(1) var<storage, read> tex: array<vec2<u32>>;
@group(0) @binding(2) var<uniform> params: Params;
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= params.count) { return; }
  let t = tex[i];
  words[t.x * 12u + 6u] = t.y;
}
`;

/** WebGPU's usage flags (the global is absent outside a WebGPU-capable realm). */
const USAGE = {
  STORAGE: 0x80,
  UNIFORM: 0x40,
  COPY_DST: 0x08,
};

/**
 * The scatter's pipelines and buffers on `device`, the update buffers grown on demand.
 * @param {GPUDevice} device
 */
export function createStaticsScatterGpu(device) {
  const pipeline = (code, label) => device.createComputePipeline({
    label,
    layout: 'auto',
    compute: { module: device.createShaderModule({ code, label }), entryPoint: 'main' },
  });
  const params = (label) => device.createBuffer({ label, size: 16, usage: USAGE.UNIFORM | USAGE.COPY_DST });
  return {
    device,
    rows: pipeline(ROWS_WGSL, 'weed-statics-scatter-rows'),
    tex: pipeline(TEX_WGSL, 'weed-statics-scatter-tex'),
    rowParams: params('weed-statics-scatter-rows-params'),
    texParams: params('weed-statics-scatter-tex-params'),
    rowUpdates: null,
    texUpdates: null,
    // The bind groups, for the statics buffer and update buffers they were made over.
    rowGroup: null,
    texGroup: null,
    groupStatics: null,
    count: new Uint32Array(4),
    submit: [null],
  };
}

function grow(state, current, bytes, label) {
  if (current !== null && current.size >= bytes) return current;
  if (current !== null) current.destroy();
  let size = 256;
  while (size < bytes) size *= 2;
  state.groupStatics = null;
  return state.device.createBuffer({ label, size, usage: USAGE.STORAGE | USAGE.COPY_DST });
}

/**
 * `count` full updates (GPU_KEYED_ROW_WORDS u32 each) and `texCount` texture updates (GPU_KEYED_TEX_WORDS u32 each)
 * into `statics` (a GPUBuffer of three vec4<u32> a key), submitted now.
 * @param {ReturnType<typeof createStaticsScatterGpu>} state
 * @param {GPUBuffer} statics
 * @param {Uint32Array} updates
 * @param {number} count
 * @param {Uint32Array|null} texUpdates
 * @param {number} texCount
 */
export function scatterStaticsGpu(state, statics, updates, count, texUpdates = null, texCount = 0) {
  const n = count > 0 ? count | 0 : 0;
  const nt = texUpdates !== null && texCount > 0 ? texCount | 0 : 0;
  if (n === 0 && nt === 0) return;
  const { device } = state;
  const queue = device.queue;
  state.rowUpdates = grow(state, state.rowUpdates, Math.max(n, 1) * GPU_KEYED_ROW_WORDS * 4, 'weed-statics-updates');
  state.texUpdates = grow(state, state.texUpdates, Math.max(nt, 1) * GPU_KEYED_TEX_WORDS * 4, 'weed-statics-tex-updates');
  if (state.groupStatics !== statics) {
    state.groupStatics = statics;
    state.rowGroup = device.createBindGroup({
      layout: state.rows.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: statics } },
        { binding: 1, resource: { buffer: state.rowUpdates } },
        { binding: 2, resource: { buffer: state.rowParams } },
      ],
    });
    state.texGroup = device.createBindGroup({
      layout: state.tex.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: statics } },
        { binding: 1, resource: { buffer: state.texUpdates } },
        { binding: 2, resource: { buffer: state.texParams } },
      ],
    });
  }
  const c = state.count;
  if (n > 0) {
    queue.writeBuffer(state.rowUpdates, 0, updates.buffer, updates.byteOffset, n * GPU_KEYED_ROW_WORDS * 4);
    c[0] = n;
    queue.writeBuffer(state.rowParams, 0, c.buffer, 0, 16);
  }
  if (nt > 0) {
    queue.writeBuffer(state.texUpdates, 0, texUpdates.buffer, texUpdates.byteOffset, nt * GPU_KEYED_TEX_WORDS * 4);
    c[0] = nt;
    queue.writeBuffer(state.texParams, 0, c.buffer, 0, 16);
  }
  const encoder = device.createCommandEncoder({ label: 'weed-statics-scatter' });
  const pass = encoder.beginComputePass({ label: 'weed-statics-scatter' });
  if (n > 0) {
    pass.setPipeline(state.rows);
    pass.setBindGroup(0, state.rowGroup);
    pass.dispatchWorkgroups(Math.ceil(n / WORKGROUP));
  }
  if (nt > 0) {
    pass.setPipeline(state.tex);
    pass.setBindGroup(0, state.texGroup);
    pass.dispatchWorkgroups(Math.ceil(nt / WORKGROUP));
  }
  pass.end();
  state.submit[0] = encoder.finish();
  queue.submit(state.submit);
  state.submit[0] = null;
}
