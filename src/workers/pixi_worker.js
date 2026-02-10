self.postMessage({
  msg: 'log',
  message: 'js loaded',
  when: Date.now(),
});

// webgpu_worker.js - Pure WebGPU renderer with GPU-side culling and sorting
// Uses compute shaders for visibility culling and Y-sorting

import { Transform } from '../components/Transform.js';
import { SpriteRenderer } from '../components/SpriteRenderer.js';
import { RigidBody } from '../components/RigidBody.js';
import { ParticleComponent } from '../components/ParticleComponent.js';
import { DecorationComponent } from '../components/DecorationComponent.js';
import { DecorationPool } from '../core/DecorationPool.js';
import { SpriteSheetRegistry } from '../core/SpriteSheetRegistry.js';
import { AbstractWorker } from './AbstractWorker.js';

import { RENDERER_STATS, createStatsWriter } from './workers-utils.js';
import { sortByY } from '../core/utils.js';

// ============================================================================
// SHADER CODE - CULL COMPUTE PIPELINE
// ============================================================================

const CULL_SHADER = /* wgsl */`
  struct CullUniforms {
    cameraX: f32,
    cameraY: f32,
    zoom: f32,
    viewportWidth: f32,
    viewportHeight: f32,
    totalInstances: u32,
    cullMargin: f32,       // Extra margin for culling (pixels)
    _padding: f32,
  }

  struct UVRect {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
  }

  // Same layout as render shader
  struct InstanceData {
    posXY_rot_scaleX: vec4<f32>,
    scaleY_anchor_uvId: vec4<f32>,
    tint_alpha: vec4<f32>,
  }

  @group(0) @binding(0) var<uniform> cull: CullUniforms;
  @group(0) @binding(1) var<storage, read> allInstances: array<InstanceData>;
  @group(0) @binding(2) var<storage, read> uvTable: array<UVRect>;
  @group(0) @binding(3) var<storage, read_write> visibleInstances: array<InstanceData>;
  @group(0) @binding(4) var<storage, read_write> visibleCount: atomic<u32>;

  @compute @workgroup_size(256)
  fn cullMain(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= cull.totalInstances) { return; }

    let inst = allInstances[idx];

    // Skip if alpha is 0 (inactive/invisible)
    if (inst.tint_alpha.w <= 0.0) { return; }

    let worldX = inst.posXY_rot_scaleX.x;
    let worldY = inst.posXY_rot_scaleX.y;
    let scaleX = inst.posXY_rot_scaleX.w;
    let scaleY = inst.scaleY_anchor_uvId.x;
    let uvIdx = bitcast<u32>(inst.scaleY_anchor_uvId.w);

    // Get sprite size from UV table
    let uv = uvTable[uvIdx];
    let spriteW = uv.w * abs(scaleX);
    let spriteH = uv.h * abs(scaleY);

    // Transform to screen space (center of sprite)
    let screenX = (worldX - cull.cameraX) * cull.zoom;
    let screenY = (worldY - cull.cameraY) * cull.zoom;

    // Half dimensions in screen space (account for scale and zoom)
    let halfW = spriteW * cull.zoom * 0.5 + cull.cullMargin;
    let halfH = spriteH * cull.zoom * 0.5 + cull.cullMargin;

    // Frustum test (AABB vs viewport)
    // Sprite is visible if its bounds intersect the viewport
    if (screenX + halfW < 0.0 || screenX - halfW > cull.viewportWidth ||
        screenY + halfH < 0.0 || screenY - halfH > cull.viewportHeight) {
      return; // Off screen - cull it
    }

    // Visible! Atomically append to output buffer
    let outIdx = atomicAdd(&visibleCount, 1u);
    visibleInstances[outIdx] = inst;
  }
`;

// ============================================================================
// SHADER CODE - BITONIC SORT COMPUTE PIPELINE (GPU Y-Sorting)
// ============================================================================

const BITONIC_SORT_SHADER = /* wgsl */`
  struct SortParams {
    count: u32,        // Number of elements to sort
    k: u32,            // Current phase (power of 2)
    j: u32,            // Current step within phase
    _padding: u32,
  }

  struct InstanceData {
    posXY_rot_scaleX: vec4<f32>,
    scaleY_anchor_uvId: vec4<f32>,
    tint_alpha: vec4<f32>,
  }

  @group(0) @binding(0) var<uniform> params: SortParams;
  @group(0) @binding(1) var<storage, read_write> instances: array<InstanceData>;

  @compute @workgroup_size(256)
  fn bitonicSortStep(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;

    // Bounds check - only process valid indices
    if (i >= params.count) { return; }

    // XOR to find partner index
    let ixj = i ^ params.j;

    // Only process if partner is higher (avoid double-swaps)
    // and within bounds
    if (ixj <= i || ixj >= params.count) { return; }

    // Get Y values for comparison (Y is at posXY_rot_scaleX.y)
    let yi = instances[i].posXY_rot_scaleX.y;
    let yixj = instances[ixj].posXY_rot_scaleX.y;

    // Determine sort direction based on bitonic sequence position
    // If (i & k) == 0, we're in ascending half; otherwise descending
    let ascending = ((i & params.k) == 0u);

    // Swap condition:
    // - ascending: swap if yi > yixj (move larger to higher index)
    // - descending: swap if yi < yixj (move smaller to higher index)
    var shouldSwap = false;
    if (ascending) {
      shouldSwap = (yi > yixj);
    } else {
      shouldSwap = (yi < yixj);
    }

    if (shouldSwap) {
      // Swap entire instance data
      let temp = instances[i];
      instances[i] = instances[ixj];
      instances[ixj] = temp;
    }
  }
`;

// ============================================================================
// SHADER CODE - SPARSE UPDATE COMPUTE PIPELINE (Patch persistent buffer)
// ============================================================================

const SPARSE_UPDATE_SHADER = /* wgsl */`
  struct UpdateParams {
    updateCount: u32,
    _padding1: u32,
    _padding2: u32,
    _padding3: u32,
  }

  struct InstanceData {
    posXY_rot_scaleX: vec4<f32>,
    scaleY_anchor_uvId: vec4<f32>,
    tint_alpha: vec4<f32>,
  }

  @group(0) @binding(0) var<uniform> params: UpdateParams;
  @group(0) @binding(1) var<storage, read> updateIndices: array<u32>;
  @group(0) @binding(2) var<storage, read> updateData: array<InstanceData>;
  @group(0) @binding(3) var<storage, read_write> instances: array<InstanceData>;

  @compute @workgroup_size(256)
  fn sparseUpdate(@builtin(global_invocation_id) gid: vec3<u32>) {
    let updateIdx = gid.x;
    if (updateIdx >= params.updateCount) { return; }

    let targetSlot = updateIndices[updateIdx];
    instances[targetSlot] = updateData[updateIdx];
  }
`;

// ============================================================================
// SHADER CODE - RENDER PIPELINE
// ============================================================================

const RENDER_SHADER = /* wgsl */`
  struct Uniforms {
    cameraX: f32,
    cameraY: f32,
    zoom: f32,
    viewportWidth: f32,
    viewportHeight: f32,
    atlasWidth: f32,
    atlasHeight: f32,
    instanceCount: u32,
  }

  struct UVRect {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
  }

  // Packed instance data to stay within 8 storage buffer limit
  // Layout per instance (16 floats = 64 bytes, aligned):
  //   vec4: posX, posY, rotation, scaleX
  //   vec4: scaleY, anchorX, anchorY, uvId (as f32 bitcast)
  //   vec4: tintR, tintG, tintB, alpha
  struct InstanceData {
    posXY_rot_scaleX: vec4<f32>,    // x, y, rotation, scaleX
    scaleY_anchor_uvId: vec4<f32>,  // scaleY, anchorX, anchorY, uvId (bitcast)
    tint_alpha: vec4<f32>,          // tintR, tintG, tintB, alpha
  }

  @group(0) @binding(0) var<uniform> uniforms: Uniforms;
  @group(0) @binding(1) var textureSampler: sampler;
  @group(0) @binding(2) var atlasTexture: texture_2d<f32>;
  @group(0) @binding(3) var<storage, read> uvTable: array<UVRect>;

  // Single instance buffer (instead of 12 separate ones)
  @group(1) @binding(0) var<storage, read> instances: array<InstanceData>;

  struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) tint: vec4<f32>,
  }

  const quadPositions = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 0.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 1.0)
  );

  @vertex
  fn vertexMain(
    @builtin(vertex_index) vertexIndex: u32,
    @builtin(instance_index) instanceIndex: u32
  ) -> VertexOutput {
    let inst = instances[instanceIndex];

    // Unpack instance data
    let worldX = inst.posXY_rot_scaleX.x;
    let worldY = inst.posXY_rot_scaleX.y;
    let rot = inst.posXY_rot_scaleX.z;
    let sX = inst.posXY_rot_scaleX.w;
    let sY = inst.scaleY_anchor_uvId.x;
    let aX = inst.scaleY_anchor_uvId.y;
    let aY = inst.scaleY_anchor_uvId.z;
    let uvIdx = bitcast<u32>(inst.scaleY_anchor_uvId.w);

    // Get UV from lookup table
    let uv = uvTable[uvIdx];

    let quadPos = quadPositions[vertexIndex];

    // Sprite size from UV dimensions
    let spriteWidth = uv.w;
    let spriteHeight = uv.h;

    // Apply anchor
    var localPos = quadPos - vec2<f32>(aX, aY);
    localPos.x *= spriteWidth * sX;
    localPos.y *= spriteHeight * sY;

    // Apply rotation
    let cosR = cos(rot);
    let sinR = sin(rot);
    let rotatedPos = vec2<f32>(
      localPos.x * cosR - localPos.y * sinR,
      localPos.x * sinR + localPos.y * cosR
    );

    // World to screen
    let worldPos = vec2<f32>(worldX, worldY) + rotatedPos;
    let screenX = (worldPos.x - uniforms.cameraX) * uniforms.zoom;
    let screenY = (worldPos.y - uniforms.cameraY) * uniforms.zoom;

    // To NDC
    let ndcX = (screenX / uniforms.viewportWidth) * 2.0 - 1.0;
    let ndcY = 1.0 - (screenY / uniforms.viewportHeight) * 2.0;

    // UV coordinates
    let texU = (uv.x + quadPos.x * uv.w) / uniforms.atlasWidth;
    let texV = (uv.y + quadPos.y * uv.h) / uniforms.atlasHeight;

    var output: VertexOutput;
    output.position = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
    output.uv = vec2<f32>(texU, texV);
    output.tint = inst.tint_alpha;

    return output;
  }

  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    let texColor = textureSample(atlasTexture, textureSampler, input.uv);
    let tintedColor = vec4<f32>(
      texColor.r * input.tint.r,
      texColor.g * input.tint.g,
      texColor.b * input.tint.b,
      texColor.a * input.tint.a
    );

    if (tintedColor.a < 0.01) {
      discard;
    }

    return tintedColor;
  }
`;

// ============================================================================
// WEBGPU RENDERER CLASS
// ============================================================================

class WebGPURenderer extends AbstractWorker {
  queryConfig = [SpriteRenderer];

  constructor(selfRef) {
    super(selfRef);

    // WebGPU core
    this.device = null;
    this.context = null;
    this.presentationFormat = null;

    // Pipeline
    this.renderPipeline = null;

    // Uniform buffer
    this.uniformBuffer = null;

    // Atlas
    this.atlasTexture = null;
    this.atlasSampler = null;
    this.atlasWidth = 0;
    this.atlasHeight = 0;

    // UV lookup table (GPU buffer)
    this.uvTableBuffer = null;
    this.uvCount = 0;
    this.uvNameToId = new Map(); // frameName -> uvId

    // Instance data buffers (raw data, uploaded once per type change)
    this.maxInstances = 0;
    this.instanceBuffers = null;

    // Compute shader buffers
    this.sortedIndicesBuffer = null;
    this.sortKeysBuffer = null;
    this.visibleCountBuffer = null;
    this.visibleCountStagingBuffer = null; // For reading back count

    // Bind groups
    this.uniformBindGroup = null;
    this.instanceBindGroup = null;

    // ========== GPU CULLING ==========
    // Cull compute pipeline
    this.cullPipeline = null;
    this.cullBindGroup = null;
    this.cullUniformBuffer = null;

    // GPU buffers for culling
    this.allInstancesBuffer = null;      // Input: ALL instances (entities + particles + decorations)
    this.visibleInstancesBuffer = null;  // Output: compacted visible instances
    this.visibleCountBuffer = null;      // Atomic counter for visible count
    this.visibleCountStagingBuffer = null; // For reading back count (indirect draw)
    this.indirectDrawBuffer = null;      // For drawIndirect

    // GPU culling config
    this.gpuCulling = false;             // Enable/disable GPU culling
    this.cullMargin = 50;                // Extra margin in pixels to avoid popping
    this._statsReadbackPending = false;  // Track async stats readback

    // ========== GPU SORTING (Bitonic Sort) ==========
    this.sortPipeline = null;
    this.sortUniformBuffers = [];        // Pool of uniform buffers for batched sort
    this.sortBindGroups = [];            // Corresponding bind groups
    this.sortBufferPoolSize = 0;         // Current pool size
    this.gpuSorting = false;             // Enable GPU Y-sorting

    // ========== SPARSE UPDATES (Persistent GPU buffer with dirty tracking) ==========
    this.sparseUpdates = false;          // Enable sparse update mode
    this.sparseUpdatePipeline = null;    // Compute pipeline for patching
    this.sparseUpdateBindGroup = null;
    this.sparseUpdateUniformBuffer = null;
    this.updateIndicesBuffer = null;     // GPU buffer: target slot indices
    this.updateDataBuffer = null;        // GPU buffer: new instance data
    this.persistentBufferInitialized = false; // First frame needs full upload

    // Pre-allocated CPU arrays for sparse updates (zero GC pressure)
    this.dirtyIndices = null;            // Uint32Array - which slots need updating
    this.dirtyInstanceData = null;       // Float32Array - packed data for dirty slots
    this.dirtyInstanceDataU32 = null;    // Uint32Array view for uvId
    this.dirtyCount = 0;                 // How many dirty this frame
    this.maxDirtyPerFrame = 0;           // Max dirty slots (sized to worst case)

    // Slot tracking for entities/particles/decorations
    // Entity i -> slot i
    // Particle i -> slot globalEntityCount + i
    // Decoration i -> slot globalEntityCount + maxParticles + i
    this.particleSlotOffset = 0;
    this.decorationSlotOffset = 0;

    // Track previous active state to detect deactivation
    this.prevEntityActive = null;        // Uint8Array - previous Transform.active state
    this.prevParticleActive = null;      // Uint8Array - previous ParticleComponent.active
    this.prevDecorationActive = null;    // Uint8Array - previous DecorationComponent.active

    // ========== PRE-ALLOCATED TEMP ARRAYS (Zero GC in hot paths) ==========
    // Reusable typed arrays for writeBuffer calls
    this._tempU32_1 = new Uint32Array(1);      // Single u32
    this._tempU32_4 = new Uint32Array(4);      // 4x u32 (indirect draw, sort params)
    this._tempF32_2 = new Float32Array(2);     // 2x f32 (cull margin)
    this._tempF32_5 = new Float32Array(5);     // 5x f32 (cull uniforms)
    this._tempF32_7 = new Float32Array(7);     // 7x f32 (render uniforms)

    // CPU-side arrays for uploading
    this.cpuArrays = null;

    // Dimensions
    this.canvasWidth = 0;
    this.canvasHeight = 0;

    // Camera interpolation
    this._renderCameraX = 0;
    this._renderCameraY = 0;
    this._renderZoom = 1.0;
    this._cameraInitialized = false;

    // Animation tracking
    this.currentFrameIndex = null;
    this.frameAccumulator = null;

    // Config
    this.ySorting = true;
    this.interpolation = true;
    this.physicsWorkerIndex = 1;

    // Stats
    this.visibleCount = 0;
    this.drawCallCount = 0;

    // Particle/decoration counts
    this.maxParticles = 0;
    this.maxDecorations = 0;

    // Y-sort pool (reused each frame)
    this._sortPool = [];
    this._sortPoolSize = 0;
  }

  async initializeWebGPU(canvas) {
    if (!navigator.gpu) {
      throw new Error('WebGPU not supported');
    }

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');

    this.device = await adapter.requestDevice();
    this.device.lost.then((info) => this.reportError('WebGPU Device Lost', new Error(info.message)));

    this.context = canvas.getContext('webgpu');
    this.presentationFormat = navigator.gpu.getPreferredCanvasFormat();

    this.context.configure({
      device: this.device,
      format: this.presentationFormat,
      alphaMode: 'premultiplied',
    });

    console.log('WEBGPU RENDERER: Device initialized');
  }

  async createPipeline() {
    const renderModule = this.device.createShaderModule({
      code: RENDER_SHADER,
      label: 'RenderShader'
    });

    // Check for shader compilation errors
    const compilationInfo = await renderModule.getCompilationInfo();
    if (compilationInfo.messages.length > 0) {
      for (const msg of compilationInfo.messages) {
        const type = msg.type; // 'error', 'warning', or 'info'
        const line = msg.lineNum;
        const col = msg.linePos;
        const text = msg.message;
        console.error(`WGSL ${type} at line ${line}:${col}: ${text}`);
      }
      const hasErrors = compilationInfo.messages.some(m => m.type === 'error');
      if (hasErrors) {
        throw new Error('Shader compilation failed - see console for details');
      }
    }

    this.renderPipeline = this.device.createRenderPipeline({
      label: 'MainRenderPipeline',
      layout: 'auto',
      vertex: { module: renderModule, entryPoint: 'vertexMain' },
      fragment: {
        module: renderModule,
        entryPoint: 'fragmentMain',
        targets: [{
          format: this.presentationFormat,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });

    console.log('WEBGPU RENDERER: Pipeline created');
  }

  async createCullPipeline() {
    const cullModule = this.device.createShaderModule({
      code: CULL_SHADER,
      label: 'CullShader'
    });

    // Check for shader compilation errors
    const compilationInfo = await cullModule.getCompilationInfo();
    if (compilationInfo.messages.length > 0) {
      for (const msg of compilationInfo.messages) {
        console.error(`WGSL Cull ${msg.type} at line ${msg.lineNum}:${msg.linePos}: ${msg.message}`);
      }
      if (compilationInfo.messages.some(m => m.type === 'error')) {
        throw new Error('Cull shader compilation failed');
      }
    }

    this.cullPipeline = this.device.createComputePipeline({
      label: 'CullComputePipeline',
      layout: 'auto',
      compute: {
        module: cullModule,
        entryPoint: 'cullMain',
      },
    });

    console.log('WEBGPU RENDERER: Cull compute pipeline created');
  }

  createCullBuffers(maxInstances) {
    const dev = this.device;

    // Cull uniform buffer (32 bytes, 8 floats)
    this.cullUniformBuffer = dev.createBuffer({
      label: 'CullUniformBuffer',
      size: 32, // 8 x f32
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Input buffer: ALL instances (same layout as render instance buffer)
    this.allInstancesBuffer = dev.createBuffer({
      label: 'AllInstancesBuffer',
      size: maxInstances * this.INSTANCE_BYTE_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Output buffer: visible instances after culling
    this.visibleInstancesBuffer = dev.createBuffer({
      label: 'VisibleInstancesBuffer',
      size: maxInstances * this.INSTANCE_BYTE_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // Atomic counter for visible count (single u32)
    this.visibleCountBuffer = dev.createBuffer({
      label: 'VisibleCountBuffer',
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    // Staging buffer to read back visible count
    this.visibleCountStagingBuffer = dev.createBuffer({
      label: 'VisibleCountStagingBuffer',
      size: 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    // Indirect draw buffer (4 x u32: vertexCount, instanceCount, firstVertex, firstInstance)
    this.indirectDrawBuffer = dev.createBuffer({
      label: 'IndirectDrawBuffer',
      size: 16,
      usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    });

    console.log(`WEBGPU RENDERER: Cull buffers created (max: ${maxInstances})`);
  }

  createCullBindGroup() {
    this.cullBindGroup = this.device.createBindGroup({
      label: 'CullBindGroup',
      layout: this.cullPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cullUniformBuffer } },
        { binding: 1, resource: { buffer: this.allInstancesBuffer } },
        { binding: 2, resource: { buffer: this.uvTableBuffer } },
        { binding: 3, resource: { buffer: this.visibleInstancesBuffer } },
        { binding: 4, resource: { buffer: this.visibleCountBuffer } },
      ],
    });

    // Update instance bind group to use visible instances buffer for rendering
    this.instanceBindGroupCulled = this.device.createBindGroup({
      label: 'InstanceBindGroupCulled',
      layout: this.renderPipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: { buffer: this.visibleInstancesBuffer } },
      ],
    });

    console.log('WEBGPU RENDERER: Cull bind group created');
  }

  async createSortPipeline() {
    const sortModule = this.device.createShaderModule({
      code: BITONIC_SORT_SHADER,
      label: 'BitonicSortShader'
    });

    // Check for shader compilation errors
    const compilationInfo = await sortModule.getCompilationInfo();
    if (compilationInfo.messages.length > 0) {
      for (const msg of compilationInfo.messages) {
        console.error(`WGSL Sort ${msg.type} at line ${msg.lineNum}:${msg.linePos}: ${msg.message}`);
      }
      if (compilationInfo.messages.some(m => m.type === 'error')) {
        throw new Error('Bitonic sort shader compilation failed');
      }
    }

    this.sortPipeline = this.device.createComputePipeline({
      label: 'BitonicSortPipeline',
      layout: 'auto',
      compute: {
        module: sortModule,
        entryPoint: 'bitonicSortStep',
      },
    });

    console.log('WEBGPU RENDERER: Bitonic sort compute pipeline created');
  }

  createSortBuffers(maxInstances) {
    const dev = this.device;

    // Calculate max sort passes needed for bitonic sort
    // For n elements: passes = sum(1..log2(nextPow2(n))) = log2(n) * (log2(n) + 1) / 2
    const maxPow2 = this.nextPowerOf2(maxInstances);
    const log2Max = Math.ceil(Math.log2(maxPow2));
    const maxPasses = (log2Max * (log2Max + 1)) / 2;

    this.sortBufferPoolSize = maxPasses;
    this.sortUniformBuffers = [];

    // Create a pool of uniform buffers (16 bytes each: count, k, j, padding)
    for (let i = 0; i < maxPasses; i++) {
      const buffer = dev.createBuffer({
        label: `SortUniformBuffer_${i}`,
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.sortUniformBuffers.push(buffer);
    }

    console.log(`WEBGPU RENDERER: Sort buffer pool created (${maxPasses} buffers for up to ${maxInstances} instances)`);
  }

  createSortBindGroups() {
    const dev = this.device;
    this.sortBindGroups = [];

    // Create a bind group for each uniform buffer in the pool
    for (let i = 0; i < this.sortBufferPoolSize; i++) {
      const bindGroup = dev.createBindGroup({
        label: `SortBindGroup_${i}`,
        layout: this.sortPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.sortUniformBuffers[i] } },
          { binding: 1, resource: { buffer: this.visibleInstancesBuffer } },
        ],
      });
      this.sortBindGroups.push(bindGroup);
    }

    console.log(`WEBGPU RENDERER: Sort bind groups created (${this.sortBufferPoolSize})`);
  }

  // ============================================================================
  // SPARSE UPDATE PIPELINE (Persistent buffer with dirty tracking)
  // ============================================================================

  async createSparseUpdatePipeline() {
    const updateModule = this.device.createShaderModule({
      code: SPARSE_UPDATE_SHADER,
      label: 'SparseUpdateShader'
    });

    const compilationInfo = await updateModule.getCompilationInfo();
    if (compilationInfo.messages.length > 0) {
      for (const msg of compilationInfo.messages) {
        console.error(`WGSL SparseUpdate ${msg.type} at line ${msg.lineNum}:${msg.linePos}: ${msg.message}`);
      }
      if (compilationInfo.messages.some(m => m.type === 'error')) {
        throw new Error('Sparse update shader compilation failed');
      }
    }

    this.sparseUpdatePipeline = this.device.createComputePipeline({
      label: 'SparseUpdatePipeline',
      layout: 'auto',
      compute: {
        module: updateModule,
        entryPoint: 'sparseUpdate',
      },
    });

    console.log('WEBGPU RENDERER: Sparse update compute pipeline created');
  }

  createSparseUpdateBuffers(maxInstances) {
    const dev = this.device;

    // Uniform buffer for update count (16 bytes aligned)
    this.sparseUpdateUniformBuffer = dev.createBuffer({
      label: 'SparseUpdateUniformBuffer',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Size for worst case: all instances dirty
    // In practice, we'll use much less most frames
    this.maxDirtyPerFrame = maxInstances;

    // GPU buffer for update indices (u32 per entry)
    this.updateIndicesBuffer = dev.createBuffer({
      label: 'UpdateIndicesBuffer',
      size: maxInstances * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // GPU buffer for update data (48 bytes per instance = 12 floats)
    this.updateDataBuffer = dev.createBuffer({
      label: 'UpdateDataBuffer',
      size: maxInstances * this.INSTANCE_BYTE_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Pre-allocate CPU-side arrays (ZERO GC during runtime)
    this.dirtyIndices = new Uint32Array(maxInstances);
    this.dirtyInstanceData = new Float32Array(maxInstances * this.INSTANCE_STRIDE);
    this.dirtyInstanceDataU32 = new Uint32Array(this.dirtyInstanceData.buffer);

    // Track previous active states for deactivation detection
    this.prevEntityActive = new Uint8Array(this.globalEntityCount);
    this.prevParticleActive = new Uint8Array(this.maxParticles);
    this.prevDecorationActive = new Uint8Array(this.maxDecorations);

    // Calculate slot offsets
    this.particleSlotOffset = this.globalEntityCount;
    this.decorationSlotOffset = this.globalEntityCount + this.maxParticles;

    console.log(`WEBGPU RENDERER: Sparse update buffers created (max dirty: ${maxInstances})`);
    console.log(`  Entity slots: 0-${this.globalEntityCount - 1}`);
    console.log(`  Particle slots: ${this.particleSlotOffset}-${this.particleSlotOffset + this.maxParticles - 1}`);
    console.log(`  Decoration slots: ${this.decorationSlotOffset}-${this.decorationSlotOffset + this.maxDecorations - 1}`);
  }

  createSparseUpdateBindGroup() {
    this.sparseUpdateBindGroup = this.device.createBindGroup({
      label: 'SparseUpdateBindGroup',
      layout: this.sparseUpdatePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.sparseUpdateUniformBuffer } },
        { binding: 1, resource: { buffer: this.updateIndicesBuffer } },
        { binding: 2, resource: { buffer: this.updateDataBuffer } },
        { binding: 3, resource: { buffer: this.allInstancesBuffer } }, // Persistent buffer
      ],
    });

    console.log('WEBGPU RENDERER: Sparse update bind group created');
  }

  createBuffers(maxInstances) {
    this.maxInstances = maxInstances;
    const dev = this.device;

    // Uniform buffer
    this.uniformBuffer = dev.createBuffer({
      label: 'UniformBuffer',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    // Packed instance data: 12 floats per instance (3 vec4s = 48 bytes)
    // Padded to 16-byte alignment (48 is already 16-aligned)
    this.INSTANCE_STRIDE = 12; // floats per instance
    this.INSTANCE_BYTE_STRIDE = this.INSTANCE_STRIDE * 4; // 48 bytes

    this.instanceBuffer = dev.createBuffer({
      label: 'InstanceDataBuffer',
      size: maxInstances * this.INSTANCE_BYTE_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // CPU-side packed array for uploading
    this.cpuInstanceData = new Float32Array(maxInstances * this.INSTANCE_STRIDE);
    // View for writing uvId as u32
    this.cpuInstanceDataU32 = new Uint32Array(this.cpuInstanceData.buffer);

    console.log(`WEBGPU RENDERER: Buffers created (max: ${maxInstances}, ${this.INSTANCE_BYTE_STRIDE} bytes/instance)`);
  }

  async uploadAtlasTexture(imageBitmap) {
    this.atlasWidth = imageBitmap.width;
    this.atlasHeight = imageBitmap.height;

    this.atlasTexture = this.device.createTexture({
      size: [imageBitmap.width, imageBitmap.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.device.queue.copyExternalImageToTexture(
      { source: imageBitmap },
      { texture: this.atlasTexture },
      [imageBitmap.width, imageBitmap.height]
    );

    this.atlasSampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    console.log(`WEBGPU RENDERER: Atlas uploaded (${imageBitmap.width}x${imageBitmap.height})`);
  }

  buildUVTable(spritesheetData, proxySheets) {
    if (!spritesheetData.bigAtlas) return;

    const json = spritesheetData.bigAtlas.json;
    const frames = Object.entries(json.frames);

    // Build UV table array
    const uvData = new Float32Array(frames.length * 4);
    let uvId = 0;

    for (const [frameName, frameData] of frames) {
      const frame = frameData.frame;
      this.uvNameToId.set(frameName, uvId);

      uvData[uvId * 4 + 0] = frame.x;
      uvData[uvId * 4 + 1] = frame.y;
      uvData[uvId * 4 + 2] = frame.w;
      uvData[uvId * 4 + 3] = frame.h;

      uvId++;
    }

    this.uvCount = uvId;

    // Create GPU buffer
    this.uvTableBuffer = this.device.createBuffer({
      size: uvData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.uvTableBuffer, 0, uvData);

    console.log(`WEBGPU RENDERER: UV table built (${this.uvCount} entries)`);

    // Register proxy sheets
    if (proxySheets) {
      for (const [proxyName, proxyData] of Object.entries(proxySheets)) {
        SpriteSheetRegistry.registerProxy(proxyName, proxyData);
      }
      console.log(`WEBGPU RENDERER: ${Object.keys(proxySheets).length} proxy sheets registered`);
    }
  }

  createBindGroups() {
    // Uniform bind group (group 0)
    this.uniformBindGroup = this.device.createBindGroup({
      label: 'UniformBindGroup',
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.atlasSampler },
        { binding: 2, resource: this.atlasTexture.createView() },
        { binding: 3, resource: { buffer: this.uvTableBuffer } },
      ],
    });

    // Instance bind group (group 1) - single packed buffer
    this.instanceBindGroup = this.device.createBindGroup({
      label: 'InstanceBindGroup',
      layout: this.renderPipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: { buffer: this.instanceBuffer } },
      ],
    });

    console.log('WEBGPU RENDERER: Bind groups created');
  }

  getUVId(frameName) {
    return this.uvNameToId.get(frameName) ?? 0;
  }

  getEntityFrameName(entityIndex) {
    const spritesheetId = SpriteRenderer.spritesheetId[entityIndex];
    const animState = SpriteRenderer.animationState[entityIndex];
    const frameIdx = this.currentFrameIndex?.[entityIndex] || 0;

    const sheetName = SpriteSheetRegistry.getSpritesheetName(spritesheetId);
    if (!sheetName) return '_white';

    const animName = SpriteSheetRegistry.getAnimationName(sheetName, animState);
    if (!animName) return '_white';

    const bigAtlas = SpriteSheetRegistry.spritesheets.get('bigAtlas');
    const sheet = SpriteSheetRegistry.spritesheets.get(sheetName);

    let prefixedAnimName = animName;
    if (sheet?.isProxy) {
      prefixedAnimName = `${sheetName}_${animName}`;
    }

    const animData = bigAtlas?.animations?.[prefixedAnimName];
    if (animData?.frames?.length > 0) {
      return animData.frames[frameIdx % animData.frames.length];
    }

    return animName;
  }

  tintToRGB(tint) {
    const b = ((tint >> 16) & 0xFF) / 255;
    const g = ((tint >> 8) & 0xFF) / 255;
    const r = (tint & 0xFF) / 255;
    return { r, g, b };
  }

  /**
   * Collect ALL instance data for GPU culling (no CPU visibility checks)
   * GPU will handle culling via compute shader
   */
  collectAllInstanceDataForGPUCull(deltaSeconds) {
    const data = this.cpuInstanceData;
    const dataU32 = this.cpuInstanceDataU32;
    const stride = this.INSTANCE_STRIDE;
    let writeIdx = 0;

    // Collect ALL entities (GPU will cull)
    const entities = this.queryActiveEntities(this.queryConfig);
    for (const entityIdx of entities) {
      if (!Transform.active[entityIdx]) continue;
      if (!SpriteRenderer.renderVisible[entityIdx]) continue;
      // NOTE: We skip isItOnScreen check - GPU does frustum culling!

      // Advance animation
      if (SpriteRenderer.isAnimated[entityIdx]) {
        this.advanceAnimation(entityIdx, deltaSeconds);
      }

      const base = writeIdx * stride;
      const frameName = this.getEntityFrameName(entityIdx);
      const rgb = this.tintToRGB(SpriteRenderer.tint[entityIdx]);

      data[base + 0] = Transform.x[entityIdx];
      data[base + 1] = Transform.y[entityIdx];
      data[base + 2] = Transform.rotation[entityIdx];
      data[base + 3] = SpriteRenderer.scaleX[entityIdx];
      data[base + 4] = SpriteRenderer.scaleY[entityIdx];
      data[base + 5] = SpriteRenderer.anchorX[entityIdx];
      data[base + 6] = SpriteRenderer.anchorY[entityIdx];
      dataU32[base + 7] = this.getUVId(frameName);
      data[base + 8] = rgb.r;
      data[base + 9] = rgb.g;
      data[base + 10] = rgb.b;
      data[base + 11] = SpriteRenderer.alpha[entityIdx];

      writeIdx++;
    }

    // Collect ALL particles (GPU will cull)
    for (let i = 0; i < this.maxParticles; i++) {
      if (!ParticleComponent.active[i]) continue;
      // NOTE: Skip isItOnScreen - GPU culls!

      const base = writeIdx * stride;
      const tid = ParticleComponent.textureId[i];
      let frameName = '_white';
      if (tid >= 0) {
        const name = SpriteSheetRegistry.getAnimationName('bigAtlas', tid);
        if (name) frameName = name;
      }
      const rgb = this.tintToRGB(ParticleComponent.tint[i]);

      data[base + 0] = ParticleComponent.x[i];
      data[base + 1] = ParticleComponent.y[i] + ParticleComponent.z[i];
      data[base + 2] = ParticleComponent.rotation[i];
      data[base + 3] = ParticleComponent.flipX[i] ? -ParticleComponent.scaleX[i] : ParticleComponent.scaleX[i];
      data[base + 4] = ParticleComponent.flipY[i] ? -ParticleComponent.scaleY[i] : ParticleComponent.scaleY[i];
      data[base + 5] = 0.5;
      data[base + 6] = 0.5;
      dataU32[base + 7] = this.getUVId(frameName);
      data[base + 8] = rgb.r;
      data[base + 9] = rgb.g;
      data[base + 10] = rgb.b;
      data[base + 11] = ParticleComponent.alpha[i];

      writeIdx++;
    }

    // Collect ALL decorations (GPU will cull)
    for (let i = 0; i < this.maxDecorations; i++) {
      if (!DecorationComponent.active[i]) continue;
      // NOTE: Skip isItOnScreen - GPU culls!

      const base = writeIdx * stride;
      const tid = DecorationComponent.textureId[i];
      let frameName = '_white';
      if (tid >= 0) {
        const name = SpriteSheetRegistry.getAnimationName('bigAtlas', tid);
        if (name) frameName = name;
      }
      const rgb = this.tintToRGB(DecorationComponent.tint[i]);

      data[base + 0] = DecorationComponent.x[i] + DecorationComponent.offsetX[i];
      data[base + 1] = DecorationComponent.y[i] + DecorationComponent.offsetY[i];
      data[base + 2] = DecorationComponent.rotation[i];
      data[base + 3] = DecorationComponent.scaleX[i];
      data[base + 4] = DecorationComponent.scaleY[i];
      data[base + 5] = DecorationComponent.anchorX[i];
      data[base + 6] = DecorationComponent.anchorY[i];
      dataU32[base + 7] = this.getUVId(frameName);
      data[base + 8] = rgb.r;
      data[base + 9] = rgb.g;
      data[base + 10] = rgb.b;
      data[base + 11] = DecorationComponent.alpha[i];

      writeIdx++;
    }

    return writeIdx;
  }

  /**
   * Collect all instance data into CPU arrays with Y-sorting
   */
  collectInstanceData(deltaSeconds) {
    // Reset sort pool
    this._sortPoolSize = 0;

    // Collect entities into sort pool
    const entities = this.queryActiveEntities(this.queryConfig);
    for (const entityIdx of entities) {
      if (!Transform.active[entityIdx]) continue;
      if (!SpriteRenderer.renderVisible[entityIdx]) continue;
      if (!SpriteRenderer.isItOnScreen[entityIdx]) continue;

      // Advance animation
      if (SpriteRenderer.isAnimated[entityIdx]) {
        this.advanceAnimation(entityIdx, deltaSeconds);
      }

      const poolIdx = this._sortPoolSize++;
      if (!this._sortPool[poolIdx]) {
        this._sortPool[poolIdx] = { type: 'entity', idx: 0, y: 0 };
      }
      this._sortPool[poolIdx].type = 'entity';
      this._sortPool[poolIdx].idx = entityIdx;
      this._sortPool[poolIdx].y = Transform.y[entityIdx];
    }

    // Collect particles into sort pool
    for (let i = 0; i < this.maxParticles; i++) {
      if (!ParticleComponent.active[i]) continue;
      if (!ParticleComponent.isItOnScreen[i]) continue;

      const poolIdx = this._sortPoolSize++;
      if (!this._sortPool[poolIdx]) {
        this._sortPool[poolIdx] = { type: 'particle', idx: 0, y: 0 };
      }
      this._sortPool[poolIdx].type = 'particle';
      this._sortPool[poolIdx].idx = i;
      this._sortPool[poolIdx].y = ParticleComponent.y[i];
    }

    // Collect decorations into sort pool
    for (let i = 0; i < this.maxDecorations; i++) {
      if (!DecorationComponent.active[i]) continue;
      if (!DecorationComponent.isItOnScreen[i]) continue;

      const poolIdx = this._sortPoolSize++;
      if (!this._sortPool[poolIdx]) {
        this._sortPool[poolIdx] = { type: 'decoration', idx: 0, y: 0 };
      }
      this._sortPool[poolIdx].type = 'decoration';
      this._sortPool[poolIdx].idx = i;
      this._sortPool[poolIdx].y = DecorationComponent.y[i];
    }

    // Y-sort if enabled
    if (this.ySorting && this._sortPoolSize > 1) {
      this._sortPool.length = this._sortPoolSize;
      this._sortPool.sort(sortByY);
    }

    // Write sorted data to packed CPU array
    // Layout: [posX, posY, rotation, scaleX, scaleY, anchorX, anchorY, uvId, tintR, tintG, tintB, alpha]
    const data = this.cpuInstanceData;
    const dataU32 = this.cpuInstanceDataU32;
    const stride = this.INSTANCE_STRIDE;

    for (let i = 0; i < this._sortPoolSize; i++) {
      const item = this._sortPool[i];
      const base = i * stride;

      if (item.type === 'entity') {
        const idx = item.idx;
        const frameName = this.getEntityFrameName(idx);
        const rgb = this.tintToRGB(SpriteRenderer.tint[idx]);

        // vec4: posX, posY, rotation, scaleX
        data[base + 0] = Transform.x[idx];
        data[base + 1] = Transform.y[idx];
        data[base + 2] = Transform.rotation[idx];
        data[base + 3] = SpriteRenderer.scaleX[idx];
        // vec4: scaleY, anchorX, anchorY, uvId (as bitcast f32)
        data[base + 4] = SpriteRenderer.scaleY[idx];
        data[base + 5] = SpriteRenderer.anchorX[idx];
        data[base + 6] = SpriteRenderer.anchorY[idx];
        dataU32[base + 7] = this.getUVId(frameName); // Store as u32, shader bitcasts
        // vec4: tintR, tintG, tintB, alpha
        data[base + 8] = rgb.r;
        data[base + 9] = rgb.g;
        data[base + 10] = rgb.b;
        data[base + 11] = SpriteRenderer.alpha[idx];
      } else if (item.type === 'particle') {
        const idx = item.idx;
        const tid = ParticleComponent.textureId[idx];
        let frameName = '_white';
        if (tid >= 0) {
          const name = SpriteSheetRegistry.getAnimationName('bigAtlas', tid);
          if (name) frameName = name;
        }
        const rgb = this.tintToRGB(ParticleComponent.tint[idx]);

        data[base + 0] = ParticleComponent.x[idx];
        data[base + 1] = ParticleComponent.y[idx] + ParticleComponent.z[idx];
        data[base + 2] = ParticleComponent.rotation[idx];
        data[base + 3] = ParticleComponent.flipX[idx] ? -ParticleComponent.scaleX[idx] : ParticleComponent.scaleX[idx];
        data[base + 4] = ParticleComponent.flipY[idx] ? -ParticleComponent.scaleY[idx] : ParticleComponent.scaleY[idx];
        data[base + 5] = 0.5;
        data[base + 6] = 0.5;
        dataU32[base + 7] = this.getUVId(frameName);
        data[base + 8] = rgb.r;
        data[base + 9] = rgb.g;
        data[base + 10] = rgb.b;
        data[base + 11] = ParticleComponent.alpha[idx];
      } else if (item.type === 'decoration') {
        const idx = item.idx;
        const tid = DecorationComponent.textureId[idx];
        let frameName = '_white';
        if (tid >= 0) {
          const name = SpriteSheetRegistry.getAnimationName('bigAtlas', tid);
          if (name) frameName = name;
        }
        const rgb = this.tintToRGB(DecorationComponent.tint[idx]);

        data[base + 0] = DecorationComponent.x[idx] + DecorationComponent.offsetX[idx];
        data[base + 1] = DecorationComponent.y[idx] + DecorationComponent.offsetY[idx];
        data[base + 2] = DecorationComponent.rotation[idx];
        data[base + 3] = DecorationComponent.scaleX[idx];
        data[base + 4] = DecorationComponent.scaleY[idx];
        data[base + 5] = DecorationComponent.anchorX[idx];
        data[base + 6] = DecorationComponent.anchorY[idx];
        dataU32[base + 7] = this.getUVId(frameName);
        data[base + 8] = rgb.r;
        data[base + 9] = rgb.g;
        data[base + 10] = rgb.b;
        data[base + 11] = DecorationComponent.alpha[idx];
      }
    }

    return this._sortPoolSize;
  }

  /**
   * Collect ONLY dirty instance data for sparse GPU updates
   * Uses dirty tracking to minimize CPU work and GPU uploads
   * Zero GC pressure - all arrays pre-allocated
   *
   * Returns: total instance count (for culling), updates dirtyCount
   */
  collectSparseUpdates(deltaSeconds) {
    const indices = this.dirtyIndices;
    const data = this.dirtyInstanceData;
    const dataU32 = this.dirtyInstanceDataU32;
    const stride = this.INSTANCE_STRIDE;

    let dirtyIdx = 0;
    let totalActive = 0;

    // ========== ENTITIES ==========
    const entities = this.queryActiveEntities(this.queryConfig);
    for (const entityIdx of entities) {
      const isActive = Transform.active[entityIdx] && SpriteRenderer.renderVisible[entityIdx];
      const wasActive = this.prevEntityActive[entityIdx];

      if (isActive) {
        totalActive++;

        // Check if entity needs GPU update:
        // 1. First frame (buffer not initialized)
        // 2. Entity just became active
        // 3. Entity is awake (not sleeping) - it moved
        // 4. Visual properties changed (renderDirty)
        // 5. Animated sprite (frame might change)
        const justActivated = !wasActive;
        const isAwake = !RigidBody.sleeping || RigidBody.sleeping[entityIdx] === 0;
        const isDirty = SpriteRenderer.renderDirty[entityIdx] === 1;
        const isAnimated = SpriteRenderer.isAnimated[entityIdx] === 1;

        const needsUpdate = !this.persistentBufferInitialized ||
          justActivated || isAwake || isDirty || isAnimated;

        if (needsUpdate) {
          // Advance animation if needed
          if (isAnimated) {
            this.advanceAnimation(entityIdx, deltaSeconds);
          }

          // Write to dirty arrays
          const base = dirtyIdx * stride;
          const frameName = this.getEntityFrameName(entityIdx);
          const tint = SpriteRenderer.tint[entityIdx];

          indices[dirtyIdx] = entityIdx; // Slot = entity index

          data[base + 0] = Transform.x[entityIdx];
          data[base + 1] = Transform.y[entityIdx];
          data[base + 2] = Transform.rotation[entityIdx];
          data[base + 3] = SpriteRenderer.scaleX[entityIdx];
          data[base + 4] = SpriteRenderer.scaleY[entityIdx];
          data[base + 5] = SpriteRenderer.anchorX[entityIdx];
          data[base + 6] = SpriteRenderer.anchorY[entityIdx];
          dataU32[base + 7] = this.getUVId(frameName);
          // Inline tint conversion (avoid function call)
          data[base + 8] = (tint & 0xFF) / 255;           // R
          data[base + 9] = ((tint >> 8) & 0xFF) / 255;    // G
          data[base + 10] = ((tint >> 16) & 0xFF) / 255;  // B
          data[base + 11] = SpriteRenderer.alpha[entityIdx];

          dirtyIdx++;

          // Clear dirty flag
          SpriteRenderer.renderDirty[entityIdx] = 0;
        }

        this.prevEntityActive[entityIdx] = 1;
      } else if (wasActive) {
        // Entity just became inactive - zero its GPU slot (alpha = 0)
        const base = dirtyIdx * stride;
        indices[dirtyIdx] = entityIdx;

        // Zero out (alpha = 0 makes cull shader skip it)
        data[base + 0] = 0;
        data[base + 1] = 0;
        data[base + 2] = 0;
        data[base + 3] = 0;
        data[base + 4] = 0;
        data[base + 5] = 0;
        data[base + 6] = 0;
        dataU32[base + 7] = 0;
        data[base + 8] = 0;
        data[base + 9] = 0;
        data[base + 10] = 0;
        data[base + 11] = 0; // Alpha = 0

        dirtyIdx++;
        this.prevEntityActive[entityIdx] = 0;
      }
    }

    // ========== PARTICLES (always dynamic, update all active) ==========
    for (let i = 0; i < this.maxParticles; i++) {
      const isActive = ParticleComponent.active[i];
      const wasActive = this.prevParticleActive[i];
      const slot = this.particleSlotOffset + i;

      if (isActive) {
        totalActive++;

        // Particles are highly dynamic - always update active ones
        const base = dirtyIdx * stride;
        const tid = ParticleComponent.textureId[i];
        let frameName = '_white';
        if (tid >= 0) {
          const name = SpriteSheetRegistry.getAnimationName('bigAtlas', tid);
          if (name) frameName = name;
        }
        const tint = ParticleComponent.tint[i];

        indices[dirtyIdx] = slot;

        data[base + 0] = ParticleComponent.x[i];
        data[base + 1] = ParticleComponent.y[i] + ParticleComponent.z[i];
        data[base + 2] = ParticleComponent.rotation[i];
        data[base + 3] = ParticleComponent.flipX[i] ? -ParticleComponent.scaleX[i] : ParticleComponent.scaleX[i];
        data[base + 4] = ParticleComponent.flipY[i] ? -ParticleComponent.scaleY[i] : ParticleComponent.scaleY[i];
        data[base + 5] = 0.5;
        data[base + 6] = 0.5;
        dataU32[base + 7] = this.getUVId(frameName);
        data[base + 8] = (tint & 0xFF) / 255;
        data[base + 9] = ((tint >> 8) & 0xFF) / 255;
        data[base + 10] = ((tint >> 16) & 0xFF) / 255;
        data[base + 11] = ParticleComponent.alpha[i];

        dirtyIdx++;
        this.prevParticleActive[i] = 1;
      } else if (wasActive) {
        // Particle deactivated - zero its slot
        const base = dirtyIdx * stride;
        indices[dirtyIdx] = slot;
        for (let j = 0; j < stride; j++) data[base + j] = 0;
        dirtyIdx++;
        this.prevParticleActive[i] = 0;
      }
    }

    // ========== DECORATIONS (mostly static, only update if dirty) ==========
    for (let i = 0; i < this.maxDecorations; i++) {
      const isActive = DecorationComponent.active[i];
      const wasActive = this.prevDecorationActive[i];
      const slot = this.decorationSlotOffset + i;

      if (isActive) {
        totalActive++;

        // Decorations: update on first frame, activation, or if they have sway
        // For now, treat sway decorations as always dirty (optimize later with GPU sway)
        const justActivated = !wasActive;
        const hasSway = DecorationComponent.swayAmount && DecorationComponent.swayAmount[i] > 0;

        if (!this.persistentBufferInitialized || justActivated || hasSway) {
          const base = dirtyIdx * stride;
          const tid = DecorationComponent.textureId[i];
          let frameName = '_white';
          if (tid >= 0) {
            const name = SpriteSheetRegistry.getAnimationName('bigAtlas', tid);
            if (name) frameName = name;
          }
          const tint = DecorationComponent.tint[i];

          indices[dirtyIdx] = slot;

          data[base + 0] = DecorationComponent.x[i] + DecorationComponent.offsetX[i];
          data[base + 1] = DecorationComponent.y[i] + DecorationComponent.offsetY[i];
          data[base + 2] = DecorationComponent.rotation[i];
          data[base + 3] = DecorationComponent.scaleX[i];
          data[base + 4] = DecorationComponent.scaleY[i];
          data[base + 5] = DecorationComponent.anchorX[i];
          data[base + 6] = DecorationComponent.anchorY[i];
          dataU32[base + 7] = this.getUVId(frameName);
          data[base + 8] = (tint & 0xFF) / 255;
          data[base + 9] = ((tint >> 8) & 0xFF) / 255;
          data[base + 10] = ((tint >> 16) & 0xFF) / 255;
          data[base + 11] = DecorationComponent.alpha[i];

          dirtyIdx++;
        }

        this.prevDecorationActive[i] = 1;
      } else if (wasActive) {
        // Decoration deactivated - zero its slot
        const base = dirtyIdx * stride;
        indices[dirtyIdx] = slot;
        for (let j = 0; j < stride; j++) data[base + j] = 0;
        dirtyIdx++;
        this.prevDecorationActive[i] = 0;
      }
    }

    this.dirtyCount = dirtyIdx;
    return totalActive;
  }

  /**
   * Execute sparse update + GPU cull + sort + render
   * Only uploads changed instances, patches persistent buffer on GPU
   */
  executeSparseUpdateAndRender(totalInstances) {
    if (!this.renderPipeline || !this.uniformBindGroup || !this.instanceBindGroupCulled) {
      console.warn('WEBGPU RENDERER: Cannot render - pipeline not ready');
      return;
    }

    const dev = this.device;
    const workgroupSize = 256;

    // Upload sparse updates (only if there are any)
    if (this.dirtyCount > 0) {
      const indicesByteSize = this.dirtyCount * 4;
      const dataByteSize = this.dirtyCount * this.INSTANCE_BYTE_STRIDE;

      dev.queue.writeBuffer(this.updateIndicesBuffer, 0, this.dirtyIndices.buffer, 0, indicesByteSize);
      dev.queue.writeBuffer(this.updateDataBuffer, 0, this.dirtyInstanceData.buffer, 0, dataByteSize);
      this._tempU32_4[0] = this.dirtyCount;
      this._tempU32_4[1] = 0;
      this._tempU32_4[2] = 0;
      this._tempU32_4[3] = 0;
      dev.queue.writeBuffer(this.sparseUpdateUniformBuffer, 0, this._tempU32_4);
    }

    // Reset cull counter and indirect draw args (reuse pre-allocated arrays)
    this._tempU32_4[0] = 6;  // vertexCount
    this._tempU32_4[1] = 0;  // instanceCount (will be filled by cull)
    this._tempU32_4[2] = 0;  // firstVertex
    this._tempU32_4[3] = 0;  // firstInstance
    dev.queue.writeBuffer(this.indirectDrawBuffer, 0, this._tempU32_4);
    this._tempU32_1[0] = 0;
    dev.queue.writeBuffer(this.visibleCountBuffer, 0, this._tempU32_1);

    // Update cull uniforms (reuse pre-allocated array)
    this._tempF32_5[0] = this._renderCameraX;
    this._tempF32_5[1] = this._renderCameraY;
    this._tempF32_5[2] = this._renderZoom;
    this._tempF32_5[3] = this.canvasWidth;
    this._tempF32_5[4] = this.canvasHeight;
    dev.queue.writeBuffer(this.cullUniformBuffer, 0, this._tempF32_5);
    this._tempU32_1[0] = totalInstances;
    dev.queue.writeBuffer(this.cullUniformBuffer, 20, this._tempU32_1);
    this._tempF32_2[0] = this.cullMargin;
    this._tempF32_2[1] = 0;
    dev.queue.writeBuffer(this.cullUniformBuffer, 24, this._tempF32_2);

    // Update render uniforms (reuse pre-allocated array)
    this._tempF32_7[0] = this._renderCameraX;
    this._tempF32_7[1] = this._renderCameraY;
    this._tempF32_7[2] = this._renderZoom;
    this._tempF32_7[3] = this.canvasWidth;
    this._tempF32_7[4] = this.canvasHeight;
    this._tempF32_7[5] = this.atlasWidth;
    this._tempF32_7[6] = this.atlasHeight;
    dev.queue.writeBuffer(this.uniformBuffer, 0, this._tempF32_7);

    // Pre-write sort uniform buffers if sorting enabled
    let sortPassCount = 0;
    let sortWorkgroupCount = 0;
    if (this.gpuSorting && this.sortPipeline) {
      const n = totalInstances;
      const nextPow2 = this.nextPowerOf2(n);
      sortWorkgroupCount = Math.ceil(nextPow2 / workgroupSize);

      let bufferIdx = 0;
      for (let k = 2; k <= nextPow2; k *= 2) {
        for (let j = k >> 1; j > 0; j >>= 1) {
          if (bufferIdx < this.sortBufferPoolSize) {
            this._tempU32_4[0] = n;
            this._tempU32_4[1] = k;
            this._tempU32_4[2] = j;
            this._tempU32_4[3] = 0;
            dev.queue.writeBuffer(this.sortUniformBuffers[bufferIdx], 0, this._tempU32_4);
            bufferIdx++;
          }
        }
      }
      sortPassCount = bufferIdx;
    }

    // Build command buffer: SparseUpdate → Cull → Sort → Render
    const commandEncoder = dev.createCommandEncoder({ label: 'SparseMainEncoder' });

    // ===== COMPUTE PASS: Sparse Update (patch persistent buffer) =====
    if (this.dirtyCount > 0) {
      const updateWorkgroups = Math.ceil(this.dirtyCount / workgroupSize);
      const updatePass = commandEncoder.beginComputePass({ label: 'SparseUpdatePass' });
      updatePass.setPipeline(this.sparseUpdatePipeline);
      updatePass.setBindGroup(0, this.sparseUpdateBindGroup);
      updatePass.dispatchWorkgroups(updateWorkgroups);
      updatePass.end();
    }

    // ===== COMPUTE PASS: Frustum Culling =====
    // Note: totalInstances is the buffer size, not active count
    // Cull shader checks alpha > 0 to skip inactive slots
    const maxSlots = this.globalEntityCount + this.maxParticles + this.maxDecorations;
    const cullWorkgroupCount = Math.ceil(maxSlots / workgroupSize);
    const cullPass = commandEncoder.beginComputePass({ label: 'CullPass' });
    cullPass.setPipeline(this.cullPipeline);
    cullPass.setBindGroup(0, this.cullBindGroup);
    cullPass.dispatchWorkgroups(cullWorkgroupCount);
    cullPass.end();

    // ===== COMPUTE PASSES: Bitonic Sort =====
    if (sortPassCount > 0) {
      for (let i = 0; i < sortPassCount; i++) {
        const sortPass = commandEncoder.beginComputePass({ label: `SortPass_${i}` });
        sortPass.setPipeline(this.sortPipeline);
        sortPass.setBindGroup(0, this.sortBindGroups[i]);
        sortPass.dispatchWorkgroups(sortWorkgroupCount);
        sortPass.end();
      }
    }

    // Copy visible count to indirect draw buffer
    commandEncoder.copyBufferToBuffer(this.visibleCountBuffer, 0, this.indirectDrawBuffer, 4, 4);

    // Copy for stats readback
    if (!this._statsReadbackPending) {
      commandEncoder.copyBufferToBuffer(this.visibleCountBuffer, 0, this.visibleCountStagingBuffer, 0, 4);
    }

    // ===== RENDER PASS =====
    const textureView = this.context.getCurrentTexture().createView();
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.1, g: 0.1, b: 0.15, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });

    renderPass.setPipeline(this.renderPipeline);
    renderPass.setBindGroup(0, this.uniformBindGroup);
    renderPass.setBindGroup(1, this.instanceBindGroupCulled);
    renderPass.drawIndirect(this.indirectDrawBuffer, 0);
    renderPass.end();

    dev.queue.submit([commandEncoder.finish()]);

    this.drawCallCount = 1;

    // Async stats readback
    if (!this._statsReadbackPending) {
      this.readbackVisibleCountForStats();
    }

    // Mark buffer as initialized after first frame
    if (!this.persistentBufferInitialized) {
      this.persistentBufferInitialized = true;
    }
  }

  advanceAnimation(entityIndex, deltaSeconds) {
    if (!this.frameAccumulator) return;

    this.frameAccumulator[entityIndex] += deltaSeconds;
    const speed = SpriteRenderer.animationSpeed[entityIndex] || 1;
    const frameDuration = 1 / (speed * 60);

    if (this.frameAccumulator[entityIndex] >= frameDuration) {
      this.frameAccumulator[entityIndex] -= frameDuration;

      const spritesheetId = SpriteRenderer.spritesheetId[entityIndex];
      const animState = SpriteRenderer.animationState[entityIndex];
      const sheetName = SpriteSheetRegistry.getSpritesheetName(spritesheetId);
      const animName = SpriteSheetRegistry.getAnimationName(sheetName, animState);

      let frameCount = 1;
      const bigAtlas = SpriteSheetRegistry.spritesheets.get('bigAtlas');
      const sheet = SpriteSheetRegistry.spritesheets.get(sheetName);
      let prefixedName = animName;
      if (sheet?.isProxy) prefixedName = `${sheetName}_${animName}`;

      if (bigAtlas?.animations?.[prefixedName]?.frames) {
        frameCount = bigAtlas.animations[prefixedName].frames.length;
      }

      const shouldLoop = SpriteRenderer.loop[entityIndex] === 1;
      const currentFrame = this.currentFrameIndex[entityIndex];

      if (shouldLoop || currentFrame < frameCount - 1) {
        this.currentFrameIndex[entityIndex] = (currentFrame + 1) % frameCount;
      }
    }
  }

  /**
   * Execute GPU culling + sorting + rendering in a single command buffer
   * Uses drawIndirect to avoid GPU->CPU readback of visible count
   * Uses pre-allocated uniform buffer pool for batched bitonic sort
   *
   * Pipeline: Cull → (optional) Bitonic Sort → Render
   */
  executeGPUCullAndRender(totalInstances) {
    if (!this.renderPipeline || !this.uniformBindGroup || !this.instanceBindGroupCulled) {
      console.warn('WEBGPU RENDERER: Cannot render culled - pipeline or bind groups not ready');
      return;
    }

    const dev = this.device;
    const workgroupSize = 256;

    // Reset visible count to 0 and set up indirect draw args (reuse pre-allocated arrays)
    this._tempU32_4[0] = 6;  // vertexCount
    this._tempU32_4[1] = 0;  // instanceCount (will be filled by cull)
    this._tempU32_4[2] = 0;  // firstVertex
    this._tempU32_4[3] = 0;  // firstInstance
    dev.queue.writeBuffer(this.indirectDrawBuffer, 0, this._tempU32_4);
    this._tempU32_1[0] = 0;
    dev.queue.writeBuffer(this.visibleCountBuffer, 0, this._tempU32_1);

    // Update cull uniforms (reuse pre-allocated array)
    this._tempF32_5[0] = this._renderCameraX;
    this._tempF32_5[1] = this._renderCameraY;
    this._tempF32_5[2] = this._renderZoom;
    this._tempF32_5[3] = this.canvasWidth;
    this._tempF32_5[4] = this.canvasHeight;
    dev.queue.writeBuffer(this.cullUniformBuffer, 0, this._tempF32_5);
    this._tempU32_1[0] = totalInstances;
    dev.queue.writeBuffer(this.cullUniformBuffer, 20, this._tempU32_1);
    this._tempF32_2[0] = this.cullMargin;
    this._tempF32_2[1] = 0;
    dev.queue.writeBuffer(this.cullUniformBuffer, 24, this._tempF32_2);

    // Update render uniforms (reuse pre-allocated array)
    this._tempF32_7[0] = this._renderCameraX;
    this._tempF32_7[1] = this._renderCameraY;
    this._tempF32_7[2] = this._renderZoom;
    this._tempF32_7[3] = this.canvasWidth;
    this._tempF32_7[4] = this.canvasHeight;
    this._tempF32_7[5] = this.atlasWidth;
    this._tempF32_7[6] = this.atlasHeight;
    dev.queue.writeBuffer(this.uniformBuffer, 0, this._tempF32_7);

    // Pre-write all sort uniform buffers (if sorting enabled)
    let sortPassCount = 0;
    let sortWorkgroupCount = 0;
    if (this.gpuSorting && this.sortPipeline) {
      const n = totalInstances;
      const nextPow2 = this.nextPowerOf2(n);
      sortWorkgroupCount = Math.ceil(nextPow2 / workgroupSize);

      // Pre-write all (count, k, j) values to the uniform buffer pool
      let bufferIdx = 0;
      for (let k = 2; k <= nextPow2; k *= 2) {
        for (let j = k >> 1; j > 0; j >>= 1) {
          if (bufferIdx < this.sortBufferPoolSize) {
            this._tempU32_4[0] = n;
            this._tempU32_4[1] = k;
            this._tempU32_4[2] = j;
            this._tempU32_4[3] = 0;
            dev.queue.writeBuffer(this.sortUniformBuffers[bufferIdx], 0, this._tempU32_4);
            bufferIdx++;
          }
        }
      }
      sortPassCount = bufferIdx;
    }

    // Build single command buffer: Cull -> Sort -> Copy -> Render
    const commandEncoder = dev.createCommandEncoder({ label: 'MainEncoder' });

    // ===== COMPUTE PASS: Frustum Culling =====
    const cullWorkgroupCount = Math.ceil(totalInstances / workgroupSize);
    const cullPass = commandEncoder.beginComputePass({ label: 'CullPass' });
    cullPass.setPipeline(this.cullPipeline);
    cullPass.setBindGroup(0, this.cullBindGroup);
    cullPass.dispatchWorkgroups(cullWorkgroupCount);
    cullPass.end();

    // ===== COMPUTE PASSES: Bitonic Sort (all passes batched) =====
    if (sortPassCount > 0) {
      for (let i = 0; i < sortPassCount; i++) {
        const sortPass = commandEncoder.beginComputePass({ label: `SortPass_${i}` });
        sortPass.setPipeline(this.sortPipeline);
        sortPass.setBindGroup(0, this.sortBindGroups[i]);
        sortPass.dispatchWorkgroups(sortWorkgroupCount);
        sortPass.end();
      }
    }

    // Copy visible count to indirect draw buffer's instanceCount (offset 4)
    commandEncoder.copyBufferToBuffer(
      this.visibleCountBuffer, 0,
      this.indirectDrawBuffer, 4,
      4
    );

    // Copy to staging buffer for stats readback ONLY if not currently mapped
    // (avoids "buffer used while mapped" error)
    if (!this._statsReadbackPending) {
      commandEncoder.copyBufferToBuffer(
        this.visibleCountBuffer, 0,
        this.visibleCountStagingBuffer, 0,
        4
      );
    }

    // ===== RENDER PASS: Draw visible instances =====
    const textureView = this.context.getCurrentTexture().createView();
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.1, g: 0.1, b: 0.15, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });

    renderPass.setPipeline(this.renderPipeline);
    renderPass.setBindGroup(0, this.uniformBindGroup);
    renderPass.setBindGroup(1, this.instanceBindGroupCulled);
    renderPass.drawIndirect(this.indirectDrawBuffer, 0);
    renderPass.end();

    // Submit everything in one go!
    dev.queue.submit([commandEncoder.finish()]);

    this.drawCallCount = 1;

    // Async readback of visible count for stats (doesn't block rendering)
    // Only attempt if we copied to staging buffer this frame
    if (!this._statsReadbackPending) {
      this.readbackVisibleCountForStats();
    }
  }

  /**
   * Helper: Get next power of 2 >= n
   */
  nextPowerOf2(n) {
    if (n <= 1) return 1;
    return 1 << (32 - Math.clz32(n - 1));
  }

  /**
   * Non-blocking readback of visible count for stats display
   */
  readbackVisibleCountForStats() {
    // Only attempt readback if not already pending
    if (this._statsReadbackPending) return;
    this._statsReadbackPending = true;

    this.visibleCountStagingBuffer.mapAsync(GPUMapMode.READ).then(() => {
      const countData = new Uint32Array(this.visibleCountStagingBuffer.getMappedRange());
      this.visibleCount = countData[0];
      this.visibleCountStagingBuffer.unmap();
      this._statsReadbackPending = false;
    }).catch(() => {
      this._statsReadbackPending = false;
    });
  }

  update(deltaTime, dtRatio, resuming) {
    // Camera interpolation
    let interpolationAlpha = 1.0;
    if (this.interpolation && this.frameRateData) {
      const physicsFPS = this.frameRateData[this.physicsWorkerIndex] || 60;
      if (physicsFPS > 0 && this.currentFPS > physicsFPS) {
        interpolationAlpha = Math.min(1.0, physicsFPS / this.currentFPS);
      }
    }

    const targetZoom = this.cameraData[0];
    const targetCamX = this.cameraData[1];
    const targetCamY = this.cameraData[2];

    if (!this._cameraInitialized) {
      this._renderCameraX = targetCamX;
      this._renderCameraY = targetCamY;
      this._renderZoom = targetZoom;
      this._cameraInitialized = true;
    } else {
      this._renderCameraX += (targetCamX - this._renderCameraX) * interpolationAlpha;
      this._renderCameraY += (targetCamY - this._renderCameraY) * interpolationAlpha;
      this._renderZoom += (targetZoom - this._renderZoom) * interpolationAlpha;
    }

    const deltaSeconds = deltaTime / 1000;

    // ========== SPARSE UPDATES PATH (Persistent buffer, dirty tracking) ==========
    if (this.sparseUpdates && this.sparseUpdatePipeline) {
      // Collect only dirty instances - massive savings for sleeping entities
      const totalActive = this.collectSparseUpdates(deltaSeconds);

      if (totalActive === 0 && this.persistentBufferInitialized) {
        this.renderEmpty();
        return;
      }

      // Execute: sparse update → cull → sort → render
      this.executeSparseUpdateAndRender(totalActive);
      return;
    }

    // ========== GPU CULLING PATH (Full upload every frame) ==========
    if (this.gpuCulling && this.cullPipeline) {
      // Collect ALL instance data (no CPU visibility checks)
      const totalCount = this.collectAllInstanceDataForGPUCull(deltaSeconds);

      if (totalCount === 0) {
        this.renderEmpty();
        return;
      }

      // Upload ALL instances to GPU
      const byteSize = totalCount * this.INSTANCE_BYTE_STRIDE;
      this.device.queue.writeBuffer(
        this.allInstancesBuffer,
        0,
        this.cpuInstanceData.buffer,
        0,
        byteSize
      );

      // Execute GPU cull + render in single command buffer (no async!)
      this.executeGPUCullAndRender(totalCount);
      return;
    }

    // ========== CPU CULLING PATH (with Y-sorting) ==========
    const totalCount = this.collectInstanceData(deltaSeconds);

    if (totalCount === 0) {
      this.renderEmpty();
      return;
    }

    // Upload data to GPU
    this.uploadInstanceData(totalCount);

    // Render (single instanced draw call)
    this.render(totalCount);
  }

  uploadInstanceData(count) {
    // Upload packed instance data in a single call
    const byteSize = count * this.INSTANCE_BYTE_STRIDE;
    this.device.queue.writeBuffer(
      this.instanceBuffer,
      0,
      this.cpuInstanceData.buffer,
      0,
      byteSize
    );
  }

  render(instanceCount) {
    // Safety check - don't render with invalid pipeline
    if (!this.renderPipeline || !this.uniformBindGroup || !this.instanceBindGroup) {
      console.warn('WEBGPU RENDERER: Cannot render - pipeline or bind groups not ready');
      return;
    }

    const dev = this.device;

    // Update render uniforms (reuse pre-allocated array)
    this._tempF32_7[0] = this._renderCameraX;
    this._tempF32_7[1] = this._renderCameraY;
    this._tempF32_7[2] = this._renderZoom;
    this._tempF32_7[3] = this.canvasWidth;
    this._tempF32_7[4] = this.canvasHeight;
    this._tempF32_7[5] = this.atlasWidth;
    this._tempF32_7[6] = this.atlasHeight;
    dev.queue.writeBuffer(this.uniformBuffer, 0, this._tempF32_7);
    this._tempU32_1[0] = instanceCount;
    dev.queue.writeBuffer(this.uniformBuffer, 28, this._tempU32_1);

    const commandEncoder = dev.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();

    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.1, g: 0.1, b: 0.15, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });

    renderPass.setPipeline(this.renderPipeline);
    renderPass.setBindGroup(0, this.uniformBindGroup);
    renderPass.setBindGroup(1, this.instanceBindGroup);
    renderPass.draw(6, instanceCount);
    renderPass.end();

    dev.queue.submit([commandEncoder.finish()]);
    this.drawCallCount = 1;
    this.visibleCount = instanceCount;
  }

  renderEmpty() {
    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();

    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.1, g: 0.1, b: 0.15, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    renderPass.end();

    this.device.queue.submit([commandEncoder.finish()]);
    this.drawCallCount = 0;
  }

  reportFPS() {
    if (this.stats) {
      this.stats[RENDERER_STATS.FPS] = this.currentFPS;
      this.stats[RENDERER_STATS.DRAW_CALLS] = this.drawCallCount;
      this.stats[RENDERER_STATS.VISIBLE_SPRITES] = this.visibleCount;
      this.stats[RENDERER_STATS.SPRITES_CREATED] = this.maxInstances;
      this.stats[RENDERER_STATS.VISIBLE_ENTITIES] = this.visibleCount; // Approximate
      this.stats[RENDERER_STATS.ACTIVE_DECORATIONS] = DecorationPool.activeCount?.[0] || 0;
      // Track sparse update efficiency (dirty count vs total)
      if (this.sparseUpdates && RENDERER_STATS.DIRTY_COUNT !== undefined) {
        this.stats[RENDERER_STATS.DIRTY_COUNT] = this.dirtyCount;
      }
    }
  }

  handleResize(data) {
    this.canvasWidth = data.width;
    this.canvasHeight = data.height;

    if (this.context && this.device) {
      this.context.configure({
        device: this.device,
        format: this.presentationFormat,
        alphaMode: 'premultiplied',
      });
    }
  }

  handleCustomMessage(data) {
    if (data.msg === 'resize') {
      this.handleResize(data);
    }
  }

  async initialize(data) {
    console.log('WEBGPU RENDERER: Initializing with compute shaders...');

    if (data.buffers.rendererStats) {
      this.stats = createStatsWriter(data.buffers.rendererStats, RENDERER_STATS);
    }

    this.canvasWidth = data.config.canvasWidth;
    this.canvasHeight = data.config.canvasHeight;

    await this.initializeWebGPU(data.view);
    await this.createPipeline();

    if (data.spritesheetMetadata) {
      SpriteSheetRegistry.deserialize(data.spritesheetMetadata);
    }

    // Calculate max instances
    this.maxParticles = data.maxParticles || 0;
    this.maxDecorations = data.maxDecorations || 0;
    const maxInstances = this.globalEntityCount + this.maxParticles + this.maxDecorations;

    this.createBuffers(maxInstances);

    // Upload atlas and build UV table
    if (data.spritesheets?.bigAtlas?.imageBitmap) {
      await this.uploadAtlasTexture(data.spritesheets.bigAtlas.imageBitmap);
    }
    this.buildUVTable(data.spritesheets, data.bigAtlasProxySheets);

    this.createBindGroups();

    // Animation tracking
    this.currentFrameIndex = new Uint16Array(this.globalEntityCount);
    this.frameAccumulator = new Float32Array(this.globalEntityCount);

    // Config
    const rendererConfig = data.config.renderer || {};
    this.ySorting = rendererConfig.ySorting !== false;
    this.interpolation = rendererConfig.interpolation !== false;

    // GPU Culling + Sorting setup
    // GPU path can be explicitly requested, or is used when Y-sorting is disabled
    const gpuCullingRequested = rendererConfig.gpuCulling === true;
    const useGPUPath = gpuCullingRequested || !this.ySorting;

    if (useGPUPath) {
      try {
        // Create cull pipeline
        await this.createCullPipeline();
        this.createCullBuffers(maxInstances);
        this.createCullBindGroup();
        this.gpuCulling = true;
        this.cullMargin = rendererConfig.cullMargin ?? 50;

        // Create sort pipeline for GPU Y-sorting (bitonic sort)
        await this.createSortPipeline();
        this.createSortBuffers(maxInstances);
        this.createSortBindGroups();

        // Enable GPU sorting if Y-sorting is requested
        // GPU bitonic sort replaces CPU Array.sort()
        this.gpuSorting = this.ySorting;

        console.log('WEBGPU RENDERER: GPU frustum culling ENABLED');
        console.log(`  Cull margin: ${this.cullMargin}px`);
        if (this.gpuSorting) {
          console.log('WEBGPU RENDERER: GPU bitonic Y-sort ENABLED');
        }

        // ========== SPARSE UPDATES (Dirty tracking optimization) ==========
        // Enable sparse updates if requested (or default when GPU culling is on)
        const sparseUpdatesRequested = rendererConfig.sparseUpdates !== false;
        if (sparseUpdatesRequested) {
          try {
            await this.createSparseUpdatePipeline();
            this.createSparseUpdateBuffers(maxInstances);
            this.createSparseUpdateBindGroup();
            this.sparseUpdates = true;

            console.log('WEBGPU RENDERER: Sparse updates ENABLED');
            console.log('  - Sleeping entities: SKIP (RigidBody.sleeping)');
            console.log('  - Clean entities: SKIP (SpriteRenderer.renderDirty)');
            console.log('  - Static decorations: SKIP (no sway)');
          } catch (err) {
            console.error('WEBGPU RENDERER: Failed to create sparse update pipeline', err);
            this.sparseUpdates = false;
          }
        }
      } catch (err) {
        console.error('WEBGPU RENDERER: Failed to create GPU pipelines, falling back to CPU', err);
        this.gpuCulling = false;
        this.gpuSorting = false;
        this.sparseUpdates = false;
      }
    } else {
      console.log('WEBGPU RENDERER: Using CPU culling + sorting');
    }

    // Check for noLimitFPS in renderer config
    if (rendererConfig.noLimitFPS === true) {
      this.noLimitFPS = true;
      console.log('WEBGPU RENDERER: Running in unlimited FPS mode');
    }

    console.log('WEBGPU RENDERER: Initialized');
    console.log(`  Max instances: ${maxInstances}`);
    console.log(`  Y-sorting: ${this.ySorting} (GPU: ${this.gpuSorting})`);
    console.log(`  GPU culling: ${this.gpuCulling}`);
    console.log(`  GPU sorting: ${this.gpuSorting}`);
    console.log(`  Sparse updates: ${this.sparseUpdates}`);
  }
}

self.webgpuRenderer = new WebGPURenderer(self);
